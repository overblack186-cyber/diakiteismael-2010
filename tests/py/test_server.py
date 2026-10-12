"""Tests : serveur HTTP (sécurité, API, flux NDJSON), performances et fermeture."""
import http.client
import json
import threading
import time
import urllib.request

from .helpers import AppTest, TempHomeTest, free_port


class SecurityTests(AppTest):
    def test_token_required(self):
        status, body = self.request("GET", "/api/settings", token=False)
        self.assertEqual(status, 401)
        status, _ = self.request("GET", "/api/settings", headers={"X-NexaAI-Token": "faux"}, token=False)
        self.assertEqual(status, 401)

    def test_host_header_checked(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.app.port)
        conn.request("GET", "/api/settings", headers={"Host": "evil.example:80", "X-NexaAI-Token": self.app.token})
        self.assertEqual(conn.getresponse().status, 403, "protection contre le DNS rebinding")
        conn.close()

    def test_index_injects_token_and_csp(self):
        with urllib.request.urlopen(self.base + "/") as resp:
            html = resp.read().decode()
            self.assertIn(self.app.token, html)
            self.assertIn("default-src 'self'", resp.headers["Content-Security-Policy"])

    def test_static_path_traversal(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.app.port)
        conn.request("GET", "/../nexaai/server.py")
        self.assertEqual(conn.getresponse().status, 404)
        conn.close()

    def test_listens_on_localhost_only(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")

    def test_keep_alive_after_unread_body(self):
        """Régression : un corps de requête non lu ne doit pas corrompre la requête suivante."""
        conn = http.client.HTTPConnection("127.0.0.1", self.app.port)
        h = {"X-NexaAI-Token": self.app.token, "Content-Type": "application/json"}
        conn.request("POST", "/api/system/heartbeat", body="{}", headers=h)
        self.assertEqual(conn.getresponse().read() and 200, 200)
        conn.request("GET", "/api/settings", headers=h)
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        json.loads(resp.read())
        conn.close()

    def test_preview_is_isolated(self):
        _, r = self.request("POST", "/api/studio/preview", {"html": "<script>alert(1)</script>", "allow_scripts": False})
        with urllib.request.urlopen(self.base + r["url"]) as resp:
            csp = resp.headers["Content-Security-Policy"]
        self.assertIn("sandbox", csp)
        self.assertNotIn("script-src", csp, "scripts bloqués par défaut")
        self.assertIn("default-src 'none'", csp, "aucun accès réseau ni à l'API")


class ApiTests(AppTest):
    def test_conversation_flow_over_http(self):
        _, conv = self.request("POST", "/api/conversations", {})
        status, events = self.request("POST", f"/api/conversations/{conv['id']}/messages", {"content": "Salut"})
        self.assertEqual(status, 200)
        self.assertEqual(events[0]["type"], "accepted")
        self.assertEqual(events[-1]["type"], "done")
        _, full = self.request("GET", f"/api/conversations/{conv['id']}")
        self.assertEqual(len(full["messages"]), 2)
        self.assertIsNone(full["active_job"])
        _, res = self.request("GET", "/api/search?q=salut")
        self.assertEqual(res["results"][0]["id"], conv["id"])
        status, _ = self.request("POST", f"/api/conversations/{conv['id']}/messages", {"content": ""})
        self.assertEqual(status, 400)

    def test_stop_over_http(self):
        _, conv = self.request("POST", "/api/conversations", {})
        result = {}
        t = threading.Thread(target=lambda: result.update(events=self.request("POST", f"/api/conversations/{conv['id']}/messages", {"content": "LENT"})[1]))
        t.start()
        for _ in range(50):
            job = self.app.chat.active_job(conv["id"])
            if job:
                break
            time.sleep(0.05)
        time.sleep(0.5)
        _, r = self.request("POST", f"/api/jobs/{job.id}/cancel", {})
        self.assertTrue(r["ok"])
        t.join(5)
        self.assertEqual(result["events"][-1]["type"], "stopped")

    def test_settings_api(self):
        status, s = self.request("PATCH", "/api/settings", {"general": {"theme": "light"}})
        self.assertEqual((status, s["general"]["theme"]), (200, "light"))
        status, err = self.request("PATCH", "/api/settings", {"ai": {"mode": "x"}})
        self.assertEqual(status, 400)
        status, _ = self.request("PATCH", "/api/settings", {"files": {"allowed_folders": [{"path": "C:\\", "access": "read_write"}]}})
        self.assertEqual(status, 400, "les permissions ne se modifient que par l'API dédiée (avec contrôles)")
        status, _ = self.request("PATCH", "/api/settings", {"pc": {"allowed_apps": [{"id": "x", "path": "cmd.exe"}]}})
        self.assertEqual(status, 400)

    def test_models_endpoint(self):
        _, cat = self.request("GET", "/api/models")
        names = [m["name"] for m in cat["providers"][0]["models"]]
        self.assertEqual(sorted(names), ["llama3.2:latest", "llava:latest", "qwen2.5-coder:latest"])
        _, res = self.request("POST", "/api/models/resolve", {"need": ["vision"]})
        self.assertEqual(res["model"], "llava:latest")

    def test_provider_key_never_returned(self):
        url, _ = self.start_remote()
        _, cfg = self.request("POST", "/api/providers", {"preset": "custom", "name": "Test", "base_url": url,
                                                         "api_key": "sk-test-1234567890", "is_local": False})
        self.assertFalse(cfg["is_local"])
        for path in ("/api/settings", "/api/models", "/api/bootstrap", "/api/system/export"):
            _, body = self.request("GET", path)
            self.assertNotIn("sk-test-1234567890", json.dumps(body), path)
        _, test = self.request("POST", f"/api/providers/{cfg['id']}/test", {})
        self.assertTrue(test["ok"])
        self.request("DELETE", f"/api/providers/{cfg['id']}")
        self.assertIsNone(self.app.secrets.get(cfg["id"]), "la clé est supprimée avec le fournisseur")

    def test_attachment_upload(self):
        status, att = self.request("POST", "/api/attachments?name=note.txt", raw=b"bonjour", headers={"Content-Type": "application/octet-stream"})
        self.assertEqual((status, att["kind"], att["size"]), (200, "text", 7))
        status, _ = self.request("POST", "/api/attachments?name=gros.bin", raw=b"x", headers={"Content-Length": str(30 * 1024 * 1024)})
        self.assertEqual(status, 413)

    def test_gestures_api_persist(self):
        _, g = self.request("POST", "/api/gestures", {"name": "Pouce", "action": "chat.new", "samples": [[0.0] * 63] * 3})
        self.assertEqual(g["sample_count"], 3)
        status, _ = self.request("POST", f"/api/gestures/{g['id']}/samples", {"samples": [[1, 2]]})
        self.assertEqual(status, 400)
        _, items = self.request("GET", "/api/gestures?samples=1")
        self.assertEqual(len(items["items"][0]["samples"]), 3)

    def test_memory_clear_requires_confirmation(self):
        self.request("POST", "/api/memory", {"kind": "fact", "content": "x"})
        status, _ = self.request("POST", "/api/memory/clear", {})
        self.assertEqual(status, 400)
        _, r = self.request("POST", "/api/memory/clear", {"confirm": "EFFACER"})
        self.assertEqual(r["deleted"], 1)

    def test_file_endpoints_respect_permissions(self):
        status, body = self.request("GET", f"/api/files/list?path={self.home}")
        self.assertEqual((status, body["kind"]), (403, "permission"))
        status, _ = self.request("POST", "/api/files/folders", {"path": self.home + "/inexistant"})
        self.assertEqual(status, 400)

    def test_system_info_and_logs(self):
        _, info = self.request("GET", "/api/system/info")
        self.assertTrue(any(d["name"] == "Ollama" and d["ok"] for d in info["dependencies"]))
        _, logs = self.request("GET", "/api/system/logs")
        self.assertIsInstance(logs["lines"], list)


class PerformanceTests(AppTest):
    def test_ui_responsive_during_long_generation(self):
        """Pendant une génération longue, les autres requêtes restent rapides (pas de blocage)."""
        _, conv = self.request("POST", "/api/conversations", {})
        t = threading.Thread(target=lambda: self.request("POST", f"/api/conversations/{conv['id']}/messages", {"content": "LENT"}))
        t.start()
        time.sleep(0.5)
        timings = []
        for _ in range(10):
            start = time.perf_counter()
            status, _ = self.request("GET", "/api/conversations?limit=20")
            timings.append(time.perf_counter() - start)
            self.assertEqual(status, 200)
        self.assertLess(max(timings), 0.5, f"latence max {max(timings):.3f}s")
        self.app.chat.cancel_all()
        t.join(5)
        print(f"\n  latence API pendant une génération : moyenne {sum(timings) / len(timings) * 1000:.1f} ms, max {max(timings) * 1000:.1f} ms")

    def test_large_history_search_speed(self):
        st = self.app.storage
        for i in range(200):
            c = st.create_conversation(f"Conversation {i}")
            for j in range(10):
                st.add_message(c["id"], "user" if j % 2 == 0 else "assistant", f"message {i}-{j} sur la physique quantique et la chimie")
        start = time.perf_counter()
        res = st.search("quantique")
        elapsed = time.perf_counter() - start
        self.assertTrue(res)
        self.assertLess(elapsed, 1.0)
        print(f"\n  recherche dans 2 000 messages : {elapsed * 1000:.0f} ms")


class LifecycleTests(TempHomeTest):
    def test_clean_shutdown_during_generation(self):
        """Fermeture pendant une tâche : la génération est annulée, la réponse partielle enregistrée, la base fermée."""
        from nexaai.server import App, make_server
        from .fakes import FakeOllamaHandler, start, stop_server
        fake, _ = start(FakeOllamaHandler)
        app = App()
        app.settings.update({"providers": {"ollama": {"base_url": f"http://127.0.0.1:{fake.server_address[1]}", "enabled": True}}})
        server = make_server(app, free_port())
        threading.Thread(target=server.serve_forever, daemon=True).start()
        conv = app.storage.create_conversation()
        job, _ = app.chat.send(conv["id"], "LENT")
        time.sleep(0.5)
        start_t = time.time()
        app.chat.cancel_all()
        app.chat.wait_all(timeout=5)
        server.shutdown()
        server.server_close()
        msgs = app.storage.list_messages(conv["id"])
        app.storage.close()
        stop_server(fake)
        self.assertLess(time.time() - start_t, 3)
        self.assertTrue(job.finished.is_set())
        self.assertEqual(msgs[-1]["status"], "stopped")

    def test_restart_keeps_data(self):
        from nexaai.server import App
        app = App()
        c = app.storage.create_conversation("Persistante")
        app.storage.add_message(c["id"], "user", "x")
        app.settings.update({"general": {"theme": "light"}})
        app.storage.close()
        app2 = App()
        self.assertEqual(app2.storage.get_conversation(c["id"])["title"], "Persistante")
        self.assertEqual(app2.settings.get("general", "theme"), "light")
        self.assertNotEqual(app.token, app2.token, "nouveau jeton de session à chaque démarrage")
        app2.storage.close()

    def test_port_fallback(self):
        import socket
        from nexaai.server import App, make_server
        busy = socket.socket()
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        port = busy.getsockname()[1]
        app = App()
        server = make_server(app, port)
        self.assertNotEqual(app.port, port, "un port occupé est remplacé par un port libre")
        server.server_close()
        busy.close()
        app.storage.close()
