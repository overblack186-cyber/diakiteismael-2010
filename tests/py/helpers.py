"""Outils communs aux tests : dossier de données temporaire et application de test."""
from __future__ import annotations

import json
import os
import shutil
import socket
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from .fakes import FakeOllamaHandler, FakeOpenAIHandler, start, stop_server


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class TempHomeTest(unittest.TestCase):
    """Chaque test dispose de son propre NEXAAI_HOME, supprimé ensuite."""

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="nexaai-test-")
        self._old_home = os.environ.get("NEXAAI_HOME")
        os.environ["NEXAAI_HOME"] = self.home

    def tearDown(self):
        if self._old_home is None:
            os.environ.pop("NEXAAI_HOME", None)
        else:
            os.environ["NEXAAI_HOME"] = self._old_home
        shutil.rmtree(self.home, ignore_errors=True)


class AppTest(TempHomeTest):
    """Application complète (serveur HTTP réel) branchée sur un faux Ollama."""

    def setUp(self):
        super().setUp()
        from nexaai.server import App, make_server
        self.fake, self.fake_state = start(FakeOllamaHandler)
        self.ollama_url = f"http://127.0.0.1:{self.fake.server_address[1]}"
        self.app = App()
        self.app.settings.update({"providers": {"ollama": {"base_url": self.ollama_url, "enabled": True}}})
        self.server = make_server(self.app, free_port())
        self.base = f"http://127.0.0.1:{self.app.port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.app.chat.cancel_all()
        self.app.chat.wait_all(3)
        self.server.shutdown()
        self.server.server_close()
        self.app.storage.close()
        stop_server(self.fake)
        super().tearDown()

    def start_remote(self):
        server, state = start(FakeOpenAIHandler)
        self.addCleanup(stop_server, server)
        return f"http://127.0.0.1:{server.server_address[1]}/v1", state

    def request(self, method, path, body=None, token=True, raw=None, headers=None):
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        h = {"Content-Type": "application/json", **(headers or {})}
        if token:
            h["X-NexaAI-Token"] = self.app.token
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = resp.read().decode()
                status = resp.status
                ctype = resp.headers.get("Content-Type", "")
        except urllib.error.HTTPError as err:
            payload, status, ctype = err.read().decode(), err.code, err.headers.get("Content-Type", "")
        if "ndjson" in ctype:
            return status, [json.loads(line) for line in payload.splitlines() if line.strip()]
        if "json" in ctype:
            return status, json.loads(payload or "null")
        return status, payload
