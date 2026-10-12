"""Tests : fournisseurs (Ollama, compatible OpenAI), sélection du modèle, modes local/distant/auto."""
import threading
import time

from .fakes import FakeOllamaHandler, FakeOpenAIHandler, start, stop_server
from .helpers import TempHomeTest, free_port


class OllamaProviderTests(TempHomeTest):
    def setUp(self):
        super().setUp()
        from nexaai.providers.ollama import OllamaProvider
        self.fake, self.state = start(FakeOllamaHandler)
        self.addCleanup(stop_server, self.fake)
        self.p = OllamaProvider(f"http://127.0.0.1:{self.fake.server_address[1]}")

    def test_detection_and_models(self):
        self.assertTrue(self.p.health()["ok"])
        models = {m.name: m for m in self.p.list_models()}
        self.assertNotIn("nomic-embed-text:latest", models, "les modèles d'embeddings sont exclus de la conversation")
        self.assertIn("vision", models["llava:latest"].capabilities)
        self.assertNotIn("vision", models["llama3.2:latest"].capabilities, "pas de capacité inventée")
        self.assertIn("tools", models["llama3.2:latest"].capabilities)
        self.assertIn("code", models["qwen2.5-coder:latest"].capabilities)
        self.assertEqual(models["llama3.2:latest"].context_length, 131072)

    def test_streaming_chat(self):
        from nexaai.providers.base import CancelToken
        events = list(self.p.chat("llama3.2:latest", [{"role": "user", "content": "Salut"}], {"temperature": 0.2}, None, CancelToken()))
        text = "".join(e.text for e in events if e.type == "delta")
        self.assertEqual(text, "Réponse à : Salut")
        self.assertGreater(sum(e.type == "delta" for e in events), 1, "la réponse arrive progressivement")
        self.assertEqual(events[-1].type, "done")
        self.assertEqual(events[-1].stats["output_tokens"], 4)
        self.assertEqual(self.state["requests"][-1]["options"]["temperature"], 0.2)

    def test_missing_model(self):
        from nexaai.providers.base import CancelToken, ProviderError
        with self.assertRaises(ProviderError) as ctx:
            list(self.p.chat("absent:7b", [{"role": "user", "content": "x"}], {}, None, CancelToken()))
        self.assertEqual(ctx.exception.kind, "not_found")
        self.assertIn("ollama pull absent:7b", str(ctx.exception))

    def test_model_runtime_error(self):
        from nexaai.providers.base import CancelToken, ProviderError
        with self.assertRaises(ProviderError):
            list(self.p.chat("llama3.2:latest", [{"role": "user", "content": "ERREUR_MODELE"}], {}, None, CancelToken()))

    def test_unreachable(self):
        from nexaai.providers.base import CancelToken, ProviderError
        from nexaai.providers.ollama import OllamaProvider
        dead = OllamaProvider(f"http://127.0.0.1:{free_port()}")
        self.assertFalse(dead.health()["ok"])
        self.assertIn("ollama serve", dead.health()["detail"])
        with self.assertRaises(ProviderError) as ctx:
            list(dead.chat("llama3.2:latest", [{"role": "user", "content": "x"}], {}, None, CancelToken()))
        self.assertEqual(ctx.exception.kind, "unreachable")

    def test_cancel_interrupts_quickly(self):
        from nexaai.providers.base import Cancelled, CancelToken
        token = CancelToken()
        received = []

        def run():
            try:
                for e in self.p.chat("llama3.2:latest", [{"role": "user", "content": "LENT"}], {}, None, token):
                    received.append(e)
            except Cancelled:
                received.append("cancelled")
        t = threading.Thread(target=run)
        t.start()
        time.sleep(0.6)
        started = time.time()
        token.cancel()
        t.join(3)
        self.assertFalse(t.is_alive())
        self.assertLess(time.time() - started, 1.0, "l'annulation ne doit pas attendre la fin de la réponse")
        self.assertEqual(received[-1], "cancelled")

    def test_pull_progress(self):
        from nexaai.providers.base import CancelToken
        steps = list(self.p.pull("llama3.2", CancelToken()))
        self.assertEqual(steps[-1]["status"], "success")


class OpenAICompatTests(TempHomeTest):
    def setUp(self):
        super().setUp()
        self.fake, self.state = start(FakeOpenAIHandler)
        self.addCleanup(stop_server, self.fake)
        self.url = f"http://127.0.0.1:{self.fake.server_address[1]}/v1"

    def test_missing_and_wrong_key(self):
        from nexaai.providers.base import ProviderError
        from nexaai.providers.openai_compat import OpenAICompatProvider
        with self.assertRaises(ProviderError) as ctx:
            OpenAICompatProvider("x", "Distant", self.url, None, False).list_models()
        self.assertEqual(ctx.exception.kind, "auth")
        self.assertIn("Aucune clé API", str(ctx.exception))
        with self.assertRaises(ProviderError) as ctx:
            OpenAICompatProvider("x", "Distant", self.url, "sk-mauvaise", False).list_models()
        self.assertEqual(ctx.exception.kind, "auth")

    def test_models_and_chat(self):
        from nexaai.providers.base import CancelToken
        from nexaai.providers.openai_compat import OpenAICompatProvider
        p = OpenAICompatProvider("x", "Distant", self.url, FakeOpenAIHandler.key, False)
        models = {m.name: m for m in p.list_models()}
        self.assertNotIn("text-embedding-3-small", models)
        self.assertEqual(models["remote-chat"].capability_source, "estimated", "capacités signalées comme estimées")
        self.assertIn("vision", models["remote-vision-gpt-4o"].capabilities)
        text = "".join(e.text for e in p.chat("remote-chat", [{"role": "user", "content": "Bonjour"}], {}, None, CancelToken())
                       if e.type == "delta")
        self.assertEqual(text.strip(), "Distant : Bonjour")

    def test_local_server_without_key(self):
        from nexaai.providers.openai_compat import OpenAICompatProvider
        p = OpenAICompatProvider("lm", "LM Studio", self.url, None, True)
        self.assertEqual(p._headers(), {}, "un serveur local n'exige pas de clé")


class RoutingTests(TempHomeTest):
    def setUp(self):
        super().setUp()
        from nexaai.config import Settings
        from nexaai.providers.registry import Registry, make_remote_config
        from nexaai.secrets_store import SecretStore
        from nexaai.storage import Storage
        self.fake, _ = start(FakeOllamaHandler)
        self.addCleanup(stop_server, self.fake)
        self.remote, _ = start(FakeOpenAIHandler)
        self.addCleanup(stop_server, self.remote)
        self.settings = Settings()
        self.storage = Storage()
        self.addCleanup(self.storage.close)
        self.secrets = SecretStore()
        self.settings.update({"providers": {"ollama": {"base_url": f"http://127.0.0.1:{self.fake.server_address[1]}", "enabled": True}}})
        cfg = make_remote_config("custom", "Distant", f"http://127.0.0.1:{self.remote.server_address[1]}/v1", is_local=False)
        self.assertFalse(cfg["is_local"])
        self.rid = cfg["id"]
        self.settings.update({"providers": {"remote": [cfg]}})
        self.secrets.set(self.rid, FakeOpenAIHandler.key)
        self.reg = Registry(self.settings, self.secrets, self.storage)

    def kill_ollama(self):
        self.settings.update({"providers": {"ollama": {"base_url": f"http://127.0.0.1:{free_port()}", "enabled": True}}})

    def test_local_mode_never_uses_remote(self):
        res = self.reg.resolve()
        self.assertTrue(res.model.is_local)
        self.kill_ollama()
        from nexaai.providers.base import ProviderError
        with self.assertRaises(ProviderError) as ctx:
            self.reg.resolve()
        self.assertEqual(ctx.exception.kind, "unreachable")

    def test_vision_selects_capable_model(self):
        res = self.reg.resolve(need={"vision"})
        self.assertEqual(res.model.name, "llava:latest")
        self.assertTrue(any("images" in n or "vision" in n for n in res.notes))

    def test_preferred_model_missing(self):
        res = self.reg.resolve(model_pref="ollama:absent:1b")
        self.assertTrue(res.notes and "n'est pas disponible" in res.notes[0])

    def test_auto_prefers_coder_for_code(self):
        self.settings.update({"ai": {"mode": "auto"}})
        res = self.reg.resolve(text="Corrige cette fonction python")
        self.assertEqual(res.model.name, "qwen2.5-coder:latest")

    def test_auto_fallback_requires_consent(self):
        from nexaai.providers.base import ProviderError
        self.settings.update({"ai": {"mode": "auto"}})
        self.kill_ollama()
        with self.assertRaises(ProviderError) as ctx:
            self.reg.resolve()
        self.assertIn("n'est pas autorisé à utiliser un service distant", str(ctx.exception))
        self.settings.update({"ai": {"auto_allow_remote": True, "remote_model": f"{self.rid}:remote-chat"}})
        res = self.reg.resolve()
        self.assertFalse(res.model.is_local)
        self.assertTrue(any("distant" in n for n in res.notes), "la bascule est toujours signalée")

    def test_remote_mode_and_limits(self):
        from nexaai.providers.base import ProviderError
        self.settings.update({"ai": {"mode": "remote", "remote_model": f"{self.rid}:remote-chat"}})
        self.assertEqual(self.reg.resolve().model.name, "remote-chat")
        remote = self.settings.get("providers", "remote")
        remote[0]["daily_limit"] = 2
        self.settings.update({"providers": {"remote": remote}})
        self.storage.count_request(self.rid)
        self.storage.count_request(self.rid)
        with self.assertRaises(ProviderError) as ctx:
            self.reg.resolve()
        self.assertEqual(ctx.exception.kind, "limit")

    def test_remote_mode_missing_key(self):
        from nexaai.providers.base import ProviderError
        self.secrets.delete(self.rid)
        self.reg._remote_cache.clear()
        self.settings.update({"ai": {"mode": "remote", "remote_model": f"{self.rid}:remote-chat"}})
        with self.assertRaises(ProviderError) as ctx:
            self.reg.resolve()
        self.assertEqual(ctx.exception.kind, "auth")

    def test_catalog_reports_errors_per_provider(self):
        self.kill_ollama()
        cat = self.reg.catalog()
        oll = next(p for p in cat["providers"] if p["id"] == "ollama")
        self.assertFalse(oll["ok"])
        self.assertEqual(oll["models"], [], "aucun modèle présenté comme disponible s'il ne l'est pas")
        remote = next(p for p in cat["providers"] if p["id"] == self.rid)
        self.assertTrue(remote["ok"])
        self.assertEqual(remote["key"]["hint"], "…7890")
