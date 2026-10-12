"""Faux serveurs Ollama et « OpenAI-compatible » pour les tests automatisés.

Ils reproduisent le format réel des API (streaming NDJSON / SSE), sans modèle :
les réponses sont déterministes. Ils NE remplacent PAS un test avec un vrai
modèle (voir docs/TESTS.md, tests manuels).

Utilisable aussi à la main :  python -m tests.py.fakes --port 11434
"""
from __future__ import annotations

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OLLAMA_MODELS = {
    "llama3.2:latest": {"capabilities": ["completion", "tools"], "ctx": 131072, "family": "llama"},
    "llava:latest": {"capabilities": ["completion", "vision"], "ctx": 4096, "family": "llama"},
    "qwen2.5-coder:latest": {"capabilities": ["completion", "tools"], "ctx": 32768, "family": "qwen2"},
    "nomic-embed-text:latest": {"capabilities": ["embedding"], "ctx": 2048, "family": "nomic-bert"},
}


def _reply_for(messages: list[dict]) -> str:
    last = next((m for m in reversed(messages) if m["role"] == "user"), {"content": ""})
    content = last.get("content", "")
    if "images" in last:
        return f"Je vois {len(last['images'])} image(s)."
    return f"Réponse à : {content[:80]}"


class FakeOllamaHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    state: dict

    def log_message(self, *a):
        pass

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        if self.path == "/api/version":
            return self._json({"version": "0.12.0-fake"})
        if self.path == "/api/tags":
            return self._json({"models": [{"name": n, "model": n, "size": 2_000_000_000,
                                           "details": {"family": v["family"]}} for n, v in OLLAMA_MODELS.items()]})
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        body = self._body()
        if self.path == "/api/show":
            m = OLLAMA_MODELS.get(body.get("model"))
            if not m:
                return self._json({"error": f"model '{body.get('model')}' not found"}, 404)
            return self._json({"capabilities": m["capabilities"], "model_info": {"general.architecture": m["family"],
                                                                                 f"{m['family']}.context_length": m["ctx"]}})
        if self.path == "/api/pull":
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            for done in (0, 50, 100):
                self.wfile.write((json.dumps({"status": "pulling", "total": 100, "completed": done}) + "\n").encode())
                self.wfile.flush()
            self.wfile.write(b'{"status":"success"}\n')
            return
        if self.path == "/api/chat":
            self.state.setdefault("requests", []).append(body)
            model = body.get("model")
            if model not in OLLAMA_MODELS:
                return self._json({"error": f"model '{model}' not found, try pulling it first"}, 404)
            msgs = body.get("messages", [])
            last_user = next((m for m in reversed(msgs) if m["role"] == "user"), {"content": ""})
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Connection", "close")
            self.end_headers()

            def line(obj):
                self.wfile.write((json.dumps(obj) + "\n").encode())
                self.wfile.flush()

            try:
                text = last_user.get("content", "")
                if "ERREUR_MODELE" in text:
                    line({"error": "model runner has unexpectedly stopped"})
                    return
                # Demande d'outil : seulement si des outils sont fournis et qu'aucun résultat n'est encore revenu.
                if body.get("tools") and "OUTIL:" in text and msgs[-1]["role"] != "tool":
                    spec = json.loads(text.split("OUTIL:", 1)[1].strip())
                    line({"message": {"role": "assistant", "content": "",
                                      "tool_calls": [{"function": spec}]}, "done": False})
                    line({"message": {"role": "assistant", "content": ""}, "done": True, "eval_count": 1,
                          "eval_duration": 1_000_000})
                    return
                if msgs and msgs[0]["role"] == "system" and msgs[0]["content"].startswith("Tu es l'assistant de programmation"):
                    original = text.split("```\n", 1)[1].rsplit("\n```", 1)[0]
                    new = original.replace("</body>", "  <footer>Pied de page</footer>\n</body>")
                    reply = "Ajout d'un pied de page.\n```html\n" + new + "\n```"
                    line({"message": {"role": "assistant", "content": reply}, "done": False})
                    line({"message": {"role": "assistant", "content": ""}, "done": True, "eval_count": 30,
                          "eval_duration": 300_000_000})
                    return
                if msgs[-1]["role"] == "tool":
                    reply = f"Résultat de l'outil reçu : {msgs[-1]['content'][:120]}"
                else:
                    reply = _reply_for(msgs)
                delay = 0.25 if "LENT" in text else 0.0
                words = reply.split(" ")
                if "LENT" in text:
                    words = words + [f"mot{i}" for i in range(40)]
                for i, word in enumerate(words):
                    line({"message": {"role": "assistant", "content": word + (" " if i < len(words) - 1 else "")},
                          "done": False})
                    if delay:
                        time.sleep(delay)
                line({"message": {"role": "assistant", "content": ""}, "done": True, "eval_count": len(words),
                      "eval_duration": 500_000_000, "prompt_eval_count": 12, "total_duration": 600_000_000,
                      "load_duration": 50_000_000})
            except (BrokenPipeError, ConnectionResetError):
                self.state["client_disconnected"] = True
            return
        self._json({"error": "not found"}, 404)


class FakeOpenAIHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    state: dict
    key = "sk-test-1234567890"

    def log_message(self, *a):
        pass

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        if self.headers.get("Authorization") != f"Bearer {self.key}":
            self._json({"error": {"message": "Invalid API key"}}, 401)
            return False
        return True

    def do_GET(self):
        if not self._auth():
            return
        if self.path.endswith("/models"):
            return self._json({"data": [{"id": "remote-chat"}, {"id": "remote-vision-gpt-4o"},
                                        {"id": "text-embedding-3-small"}]})
        self._json({"error": {"message": "not found"}}, 404)

    def do_POST(self):
        if not self._auth():
            return
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        self.state.setdefault("requests", []).append(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        last = body["messages"][-1]
        content = last["content"] if isinstance(last["content"], str) else last["content"][0]["text"]
        for word in f"Distant : {content[:60]}".split(" "):
            chunk = {"choices": [{"delta": {"content": word + " "}}]}
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")


def start(handler_cls, port: int = 0):
    state: dict = {}
    handler = type("H", (handler_cls,), {"state": state})
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, state


def stop_server(server) -> None:
    server.shutdown()
    server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=11434)
    parser.add_argument("--openai-port", type=int, default=0)
    a = parser.parse_args()
    srv, _ = start(FakeOllamaHandler, a.port)
    print(f"Faux Ollama sur http://127.0.0.1:{srv.server_address[1]}")
    if a.openai_port:
        o, _ = start(FakeOpenAIHandler, a.openai_port)
        print(f"Faux fournisseur distant sur http://127.0.0.1:{o.server_address[1]}/v1 (clé {FakeOpenAIHandler.key})")
    threading.Event().wait()
