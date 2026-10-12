"""Tests : permissions, couche d'exécution des actions, fichiers et sauvegardes."""
import os
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest import mock

from .helpers import TempHomeTest


class ToolTests(TempHomeTest):
    def setUp(self):
        super().setUp()
        from nexaai.config import Settings
        from nexaai.files import Files
        from nexaai.storage import Storage
        from nexaai.tools.executor import Executor
        from nexaai.tools.permissions import Permissions
        self.settings = Settings()
        self.storage = Storage()
        self.addCleanup(self.storage.close)
        self.perm = Permissions(self.settings)
        self.files = Files(self.perm)
        self.ex = Executor(self.settings, self.storage, self.perm, self.files)
        self.ro = Path(tempfile.mkdtemp(prefix="ro-", dir=self.home))
        self.rw = Path(tempfile.mkdtemp(prefix="rw-", dir=self.home))
        self.outside = Path(tempfile.mkdtemp(prefix="outside-", dir=self.home))
        (self.ro / "lisez-moi.txt").write_text("contenu lecture", encoding="utf-8")
        (self.rw / "notes.md").write_text("version 1", encoding="utf-8")
        (self.outside / "secret.txt").write_text("interdit", encoding="utf-8")
        self.perm.add_folder(str(self.ro), "read")
        self.perm.add_folder(str(self.rw), "read_write")

    def test_permission_granted_and_denied(self):
        ok = self.ex.run("read_text_file", {"path": str(self.ro / "lisez-moi.txt")}, origin="agent")
        self.assertEqual((ok["status"], ok["result"]), ("done", "contenu lecture"))
        denied = self.ex.run("read_text_file", {"path": str(self.outside / "secret.txt")}, origin="agent")
        self.assertEqual(denied["status"], "denied")
        self.assertNotIn("interdit", denied["result"])
        traversal = self.ex.run("read_text_file", {"path": str(self.ro / ".." / self.outside.name / "secret.txt")}, origin="agent")
        self.assertEqual(traversal["status"], "denied", "« .. » ne permet pas de sortir d'un dossier autorisé")

    def test_symlink_escape_blocked(self):
        if sys.platform == "win32":
            self.skipTest("liens symboliques non garantis sous Windows")
        link = self.ro / "lien"
        os.symlink(self.outside, link)
        res = self.ex.run("read_text_file", {"path": str(link / "secret.txt")}, origin="agent")
        self.assertEqual(res["status"], "denied")

    def test_root_folder_refused(self):
        with self.assertRaises(ValueError):
            self.perm.add_folder(os.path.abspath(os.sep))

    def _run_with_decision(self, name, args, approve):
        result = {}
        t = threading.Thread(target=lambda: result.update(self.ex.run(name, args, origin="agent")))
        t.start()
        for _ in range(100):
            if self.ex.hub.pending_ids():
                break
            time.sleep(0.02)
        pending = self.ex.hub.pending_ids()
        self.assertEqual(len(pending), 1, "l'action sensible attend une confirmation")
        self.assertEqual(self.storage.get_action(pending[0])["status"], "pending")
        self.ex.hub.decide(pending[0], approve)
        t.join(3)
        return result

    def test_sensitive_action_confirmed(self):
        res = self._run_with_decision("write_text_file", {"path": str(self.rw / "notes.md"), "content": "version 2"}, True)
        self.assertEqual(res["status"], "done")
        self.assertEqual((self.rw / "notes.md").read_text(encoding="utf-8"), "version 2")
        backups = self.files.list_backups(str(self.rw / "notes.md"))
        self.assertEqual(len(backups), 1, "la version précédente est sauvegardée")
        self.files.restore_backup(str(self.rw / "notes.md"), backups[0]["id"])
        self.assertEqual((self.rw / "notes.md").read_text(encoding="utf-8"), "version 1")

    def test_sensitive_action_refused(self):
        res = self._run_with_decision("write_text_file", {"path": str(self.rw / "notes.md"), "content": "piraté"}, False)
        self.assertEqual(res["status"], "denied")
        self.assertEqual((self.rw / "notes.md").read_text(encoding="utf-8"), "version 1", "rien n'est écrit sans accord")

    def test_cancelled_action(self):
        from nexaai.providers.base import CancelToken
        token = CancelToken()
        result = {}
        t = threading.Thread(target=lambda: result.update(self.ex.run(
            "write_text_file", {"path": str(self.rw / "notes.md"), "content": "x"}, origin="agent", cancel=token)))
        t.start()
        time.sleep(0.2)
        token.cancel()
        t.join(3)
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual((self.rw / "notes.md").read_text(encoding="utf-8"), "version 1")

    def test_write_in_read_only_folder_denied_without_asking(self):
        res = self.ex.run("write_text_file", {"path": str(self.ro / "lisez-moi.txt"), "content": "x"}, origin="agent")
        self.assertEqual(res["status"], "denied", "refusé par les permissions, sans demander de confirmation inutile")
        self.assertIn("lecture seule", res["result"])
        self.assertEqual(self.ex.hub.pending_ids(), [])

    def test_failed_execution_is_reported(self):
        res = self.ex.run("read_text_file", {"path": str(self.ro / "absent.txt")}, origin="agent")
        self.assertEqual(res["status"], "failed")
        self.assertIn("introuvable", res["result"].lower())

    def test_invalid_proposals(self):
        self.assertEqual(self.ex.run("rm_rf", {}, origin="agent")["status"], "failed")
        self.assertEqual(self.ex.run("read_text_file", {}, origin="agent")["status"], "failed")
        self.assertEqual(self.ex.run("remember", {"kind": "secret", "content": "x"}, origin="agent")["status"], "failed")
        self.assertEqual(self.ex.run("list_directory", "pas un objet", origin="agent")["status"], "failed")

    def test_only_allowed_apps_launch(self):
        res = self.ex.run("launch_app", {"app_id": "cmd"}, origin="user")
        self.assertEqual(res["status"], "denied")
        exe = self.rw / "outil.exe"
        exe.write_text("x")
        with self.assertRaises(ValueError):
            self.perm.add_app("Mauvais", str(exe), "a && del *")
        self.perm.add_app("Outil", str(exe), "--fenetre")
        with mock.patch("nexaai.tools.executor.launch_path") as launch:
            res = self.ex.run("launch_app", {"app_id": "outil"}, origin="user")
        self.assertEqual(res["status"], "done")
        launch.assert_called_once_with(str(exe), ["--fenetre"])

    def test_medium_risk_confirmation_setting(self):
        tool = self.ex.tools["open_path"]
        self.assertTrue(self.ex.needs_confirmation(tool))
        self.settings.update({"pc": {"confirm_actions": False}})
        self.assertFalse(self.ex.needs_confirmation(tool))
        self.assertTrue(self.ex.needs_confirmation(self.ex.tools["write_text_file"]), "écriture : confirmation toujours exigée")

    def test_memory_tool_respects_disabled_memory(self):
        self.settings.update({"memory": {"enabled": False}})
        res = self.ex.run("remember", {"kind": "fact", "content": "J'ai un chat"}, origin="agent")
        self.assertEqual(res["status"], "denied")
        self.assertEqual(self.storage.list_memory(), [])

    def test_actions_are_logged(self):
        self.ex.run("get_datetime", {}, origin="agent")
        log = self.storage.list_actions()
        self.assertEqual(log[0]["tool"], "get_datetime")
        self.assertEqual(log[0]["status"], "done")
        self.assertIsNotNone(log[0]["finished_at"])

    def test_files_listing_and_formats(self):
        (self.ro / "image.png").write_bytes(b"\x89PNG")
        (self.ro / "doc.pdf").write_bytes(b"%PDF")
        listing = {e["name"]: e["kind"] for e in self.files.list_dir(str(self.ro))["entries"]}
        self.assertEqual(listing, {"lisez-moi.txt": "text", "image.png": "image", "doc.pdf": "unsupported"})
        with self.assertRaises(ValueError):
            self.files.read_text(str(self.ro / "doc.pdf"))
