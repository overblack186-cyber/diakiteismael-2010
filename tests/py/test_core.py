"""Tests : réglages, stockage (persistance), secrets, journalisation, studio."""
import json
import os

from .helpers import TempHomeTest


class SettingsTests(TempHomeTest):
    def test_defaults_and_persistence(self):
        from nexaai.config import Settings
        s = Settings()
        self.assertEqual(s.get("ai", "mode"), "local")
        self.assertFalse(s.get("ai", "auto_allow_remote"), "aucune bascule distante sans consentement")
        s.update({"general": {"theme": "light"}, "vision": {"confidence": 0.9}})
        self.assertEqual(Settings().get("general", "theme"), "light", "les réglages persistent après redémarrage")

    def test_validation(self):
        from nexaai.config import Settings, SettingsError
        s = Settings()
        for patch in ({"ai": {"mode": "magique"}}, {"ai": {"temperature": 9}}, {"general": {"inconnu": 1}},
                      {"nope": {}}, {"memory": {"enabled": "oui"}}):
            with self.assertRaises(SettingsError, msg=patch):
                s.update(patch)
        self.assertEqual(s.get("ai", "mode"), "local", "un patch invalide n'est pas appliqué partiellement")

    def test_camera_off_by_default(self):
        from nexaai.config import DEFAULT_SETTINGS
        self.assertNotIn("camera_on", DEFAULT_SETTINGS["vision"])
        self.assertTrue(DEFAULT_SETTINGS["vision"]["test_mode"])

    def test_corrupt_file_is_set_aside(self):
        from nexaai.config import Settings
        path = Settings().path
        path.write_text("{ pas du json", encoding="utf-8")
        s = Settings()
        self.assertEqual(s.get("ai", "mode"), "local")
        self.assertTrue(path.with_suffix(".json.corrupt").exists())


class StorageTests(TempHomeTest):
    def setUp(self):
        super().setUp()
        from nexaai.storage import Storage
        self.Storage = Storage
        self.st = Storage()

    def tearDown(self):
        self.st.close()
        super().tearDown()

    def test_conversation_lifecycle_and_persistence(self):
        a = self.st.create_conversation()
        b = self.st.create_conversation()
        self.assertNotEqual(a["id"], b["id"], "chaque conversation a un identifiant unique")
        self.st.add_message(a["id"], "user", "Bonjour")
        self.st.add_message(a["id"], "assistant", "Salut", meta={"x": 1})
        self.st.update_conversation(a["id"], title="Mon titre", archived=True)
        self.st.close()
        self.st = self.Storage()
        conv = self.st.get_conversation(a["id"])
        self.assertEqual((conv["title"], conv["archived"], conv["message_count"]), ("Mon titre", True, 2))
        self.assertEqual(self.st.list_messages(a["id"])[1]["meta"], {"x": 1})
        self.assertEqual(len(self.st.list_conversations(archived=False)), 1)
        self.st.delete_conversation(a["id"])
        self.assertEqual(self.st.list_messages(a["id"]), [], "suppression en cascade des messages")

    def test_search_titles_and_messages(self):
        c = self.st.create_conversation("Photosynthèse")
        self.st.add_message(c["id"], "user", "Explique la mitochondrie en détail")
        d = self.st.create_conversation("Autre")
        self.st.add_message(d["id"], "assistant", "Rien à voir 100%")
        self.assertEqual([r["id"] for r in self.st.search("photo")], [c["id"]])
        res = self.st.search("MITOCHONDRIE")
        self.assertEqual(res[0]["matches"][0]["role"], "user")
        self.assertIn("mitochondrie", res[0]["matches"][0]["snippet"])
        self.assertEqual(len(self.st.search("100%")), 1, "les caractères spéciaux LIKE sont échappés")
        self.assertEqual([r["id"] for r in self.st.search("%")], [d["id"]], "« % » est cherché littéralement")

    def test_edit_truncates_following(self):
        c = self.st.create_conversation()
        m1 = self.st.add_message(c["id"], "user", "1")
        self.st.add_message(c["id"], "assistant", "2")
        self.st.add_message(c["id"], "user", "3")
        self.st.delete_messages_after(m1["id"])
        self.assertEqual([m["content"] for m in self.st.list_messages(c["id"])], ["1"])

    def test_memory(self):
        p = self.st.create_project("Robot")
        self.st.add_memory("preference", "Réponses courtes")
        with self.assertRaises(ValueError):
            self.st.add_memory("project_note", "sans projet")
        note = self.st.add_memory("project_note", "Utiliser Arduino", project_id=p["id"])
        with self.assertRaises(ValueError):
            self.st.add_memory("inconnu", "x")
        self.st.update_memory(note["id"], enabled=False)
        self.assertEqual(len(self.st.list_memory(enabled_only=True)), 1)
        self.assertEqual(self.st.clear_memory(), 2)

    def test_gestures_persist_and_validate(self):
        g = self.st.create_gesture("Main ouverte", action="chat.new")
        with self.assertRaises(ValueError):
            self.st.add_gesture_samples(g["id"], [[0.1] * 10])
        self.st.add_gesture_samples(g["id"], [[0.1] * 63, [0.2] * 63])
        self.st.update_gesture(g["id"], sensitivity=1.5, enabled=False)
        with self.assertRaises(ValueError):
            self.st.update_gesture(g["id"], sensitivity=5)
        self.st.close()
        self.st = self.Storage()
        loaded = self.st.get_gesture(g["id"], with_samples=True)
        self.assertEqual((loaded["sample_count"], loaded["enabled"], loaded["sensitivity"]), (2, False, 1.5))
        self.assertEqual(len(loaded["samples"][0]["vector"]), 63)

    def test_purge_only_old_empty_conversations(self):
        old_empty = self.st.create_conversation()
        self.st._exec("UPDATE conversations SET updated_at = 0 WHERE id=?", (old_empty["id"],))
        recent_empty = self.st.create_conversation()
        old_full = self.st.create_conversation()
        self.st.add_message(old_full["id"], "user", "x")
        self.st._exec("UPDATE conversations SET updated_at = 0 WHERE id=?", (old_full["id"],))
        self.assertEqual(self.st.purge_empty_conversations(), 1)
        ids = {c["id"] for c in self.st.list_conversations(archived=None)}
        self.assertEqual(ids, {recent_empty["id"], old_full["id"]})


class SecretsAndLogsTests(TempHomeTest):
    def test_secret_store(self):
        from nexaai.secrets_store import SecretStore
        s = SecretStore()
        s.set("openai-1", "sk-abcdefghijklmnop1234")
        self.assertEqual(SecretStore().get("openai-1"), "sk-abcdefghijklmnop1234")
        d = s.describe("openai-1")
        self.assertEqual(d["hint"], "…1234")
        self.assertNotIn("abcdef", json.dumps(d), "la clé complète n'est jamais exposée")
        if os.name != "nt":
            self.assertEqual(oct(s.path.stat().st_mode & 0o777), "0o600")
        os.environ["NEXAAI_KEY_OPENAI_1"] = "sk-env-override-9999"
        try:
            self.assertEqual(s.get("openai-1"), "sk-env-override-9999")
        finally:
            del os.environ["NEXAAI_KEY_OPENAI_1"]
        s.delete("openai-1")
        self.assertIsNone(s.get("openai-1"))

    def test_log_redaction(self):
        from nexaai.logs import redact
        text = redact('Authorization: Bearer abc.def-123 api_key="sk-proj-ABCDEFGHIJ12345" token=xyz')
        for secret in ("abc.def-123", "ABCDEFGHIJ12345", "xyz"):
            self.assertNotIn(secret, text)


class StudioTests(TempHomeTest):
    def test_extract_and_diff(self):
        from nexaai.studio import diff_lines, extract_code
        self.assertIsNone(extract_code("pas de code"))
        self.assertIsNone(extract_code("```py\nincomplet"), "un bloc non refermé n'est jamais appliqué")
        self.assertEqual(extract_code("Résumé\n```py\nprint(2)\n```"), "print(2)\n")
        d = diff_lines("a\nb\nc\n", "a\nB\nc\nd\n")
        self.assertEqual((d["added"], d["removed"], d["identical"]), (2, 1, False))
        self.assertTrue(diff_lines("x\n", "x\n")["identical"])
