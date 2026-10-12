"""Tests : moteur de conversation (envoi, streaming, arrêt, erreurs, historique, mémoire, outils)."""
import time

from .fakes import FakeOpenAIHandler
from .helpers import AppTest, free_port


def collect(job, timeout=15):
    events = []
    deadline = time.time() + timeout
    for ev in job.subscribe(poll=0.2):
        if ev is not None:
            events.append(ev)
        if time.time() > deadline:
            raise AssertionError("génération trop longue")
    return events


class ChatTests(AppTest):
    def setUp(self):
        super().setUp()
        self.chat = self.app.chat
        self.st = self.app.storage
        self.conv = self.st.create_conversation()

    def test_send_stream_and_persist(self):
        job, user = self.chat.send(self.conv["id"], "Bonjour NexaAI")
        self.assertEqual(user["content"], "Bonjour NexaAI")
        events = collect(job)
        types = [e["type"] for e in events]
        self.assertEqual(types[0], "start")
        self.assertGreater(types.count("delta"), 1)
        self.assertEqual(types[-1], "done")
        msgs = self.st.list_messages(self.conv["id"])
        self.assertEqual([m["role"] for m in msgs], ["user", "assistant"])
        self.assertEqual(msgs[1]["content"], "Réponse à : Bonjour NexaAI")
        self.assertEqual(msgs[1]["model"], "llama3.2:latest", "le modèle réellement utilisé est enregistré")
        self.assertTrue(msgs[1]["meta"]["resolution"]["is_local"])
        self.assertEqual(self.st.get_conversation(self.conv["id"])["title"], "Bonjour NexaAI")

    def test_empty_message_refused(self):
        with self.assertRaises(ValueError):
            self.chat.send(self.conv["id"], "   ")

    def test_one_generation_at_a_time(self):
        job, _ = self.chat.send(self.conv["id"], "LENT")
        with self.assertRaises(RuntimeError):
            self.chat.send(self.conv["id"], "encore")
        job.cancel.cancel()
        collect(job)

    def test_stop_keeps_partial_answer(self):
        job, _ = self.chat.send(self.conv["id"], "LENT")
        time.sleep(0.8)
        self.chat.cancel(job.id)
        events = collect(job)
        self.assertEqual(events[-1]["type"], "stopped")
        msgs = self.st.list_messages(self.conv["id"])
        self.assertEqual(msgs[-1]["status"], "stopped")
        self.assertTrue(msgs[-1]["content"].startswith("Réponse"), "le texte déjà reçu est conservé")
        self.assertEqual(msgs[0]["content"], "LENT")

    def test_error_keeps_user_message_and_is_retryable(self):
        self.app.settings.update({"providers": {"ollama": {"base_url": f"http://127.0.0.1:{free_port()}", "enabled": True}}})
        job, _ = self.chat.send(self.conv["id"], "Message important")
        events = collect(job)
        self.assertEqual(events[-1]["type"], "error")
        msgs = self.st.list_messages(self.conv["id"])
        self.assertEqual(msgs[0]["content"], "Message important", "le message de l'utilisateur n'est jamais perdu")
        self.assertEqual(msgs[1]["status"], "error")
        self.assertTrue(msgs[1]["meta"]["retryable"])
        # retour du moteur → réessayer
        self.app.settings.update({"providers": {"ollama": {"base_url": self.ollama_url, "enabled": True}}})
        events = collect(self.chat.regenerate(self.conv["id"]))
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual([m["status"] for m in self.st.list_messages(self.conv["id"])], ["ok", "ok"])

    def test_model_error_message(self):
        events = collect(self.chat.send(self.conv["id"], "ERREUR_MODELE")[0])
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("Ollama", events[-1]["error"])

    def test_edit_and_resend(self):
        collect(self.chat.send(self.conv["id"], "Première version")[0])
        user = self.st.list_messages(self.conv["id"])[0]
        collect(self.chat.edit_and_resend(user["id"], "Seconde version"))
        msgs = self.st.list_messages(self.conv["id"])
        self.assertEqual([m["content"] for m in msgs], ["Seconde version", "Réponse à : Seconde version"])
        self.assertTrue(msgs[0]["meta"]["edited"])

    def test_history_is_sent_as_context(self):
        collect(self.chat.send(self.conv["id"], "Je m'appelle Awa")[0])
        collect(self.chat.send(self.conv["id"], "Comment je m'appelle ?")[0])
        sent = self.fake_state["requests"][-1]["messages"]
        self.assertEqual(sent[0]["role"], "system")
        self.assertIn("Je m'appelle Awa", [m["content"] for m in sent])

    def test_memory_injection_and_disable(self):
        self.st.add_memory("preference", "Réponds avec des exemples concrets")
        self.st.add_memory("fact", "Mon robot s'appelle Zéphyr")
        self.st.add_memory("fact", "J'aime le football")
        events = collect(self.chat.send(self.conv["id"], "Parle-moi de mon robot")[0])
        used = [m["content"] for m in events[0]["memories"]]
        self.assertIn("Réponds avec des exemples concrets", used)
        self.assertIn("Mon robot s'appelle Zéphyr", used)
        self.assertNotIn("J'aime le football", used, "seuls les faits pertinents sont fournis")
        self.assertIn("Zéphyr", self.fake_state["requests"][-1]["messages"][0]["content"])
        self.app.settings.update({"memory": {"enabled": False}})
        collect(self.chat.send(self.conv["id"], "Et mon robot ?")[0])
        self.assertNotIn("Zéphyr", self.fake_state["requests"][-1]["messages"][0]["content"])

    def test_project_context(self):
        p = self.st.create_project("Club robotique", "Site web du club")
        self.st.update_project(p["id"], notes="Couleurs : bleu et blanc")
        conv = self.st.create_conversation(project_id=p["id"])
        collect(self.chat.send(conv["id"], "Propose un titre")[0])
        system = self.fake_state["requests"][-1]["messages"][0]["content"]
        self.assertIn("Club robotique", system)
        self.assertIn("bleu et blanc", system)

    def test_image_routes_to_vision_model(self):
        att = self.app.save_attachment("photo.png", b"\x89PNG\r\n\x1a\nfake")
        self.assertEqual(att["kind"], "image")
        events = collect(self.chat.send(self.conv["id"], "Que vois-tu ?", [att["id"]])[0])
        self.assertEqual(events[0]["resolution"]["model"], "llava:latest")
        self.assertEqual(self.fake_state["requests"][-1]["messages"][-1]["images"].__len__(), 1)
        self.assertEqual(self.st.list_messages(self.conv["id"])[-1]["content"], "Je vois 1 image(s).")

    def test_text_attachment_is_read(self):
        att = self.app.save_attachment("notes.txt", "Le code secret du club est 42".encode())
        collect(self.chat.send(self.conv["id"], "Résume", [att["id"]])[0])
        self.assertIn("Le code secret du club est 42", self.fake_state["requests"][-1]["messages"][-1]["content"])
        bad = self.app.save_attachment("doc.pdf", b"%PDF-1.4")
        self.assertEqual(bad["kind"], "unsupported")

    def test_remote_files_need_explicit_consent(self):
        url, _ = self.start_remote()
        from nexaai.providers.registry import make_remote_config
        cfg = make_remote_config("custom", "Distant", url, is_local=False)
        self.app.settings.update({"providers": {"remote": [cfg]}, "ai": {"mode": "remote", "remote_model": f"{cfg['id']}:remote-chat"}})
        self.app.secrets.set(cfg["id"], FakeOpenAIHandler.key)
        att = self.app.save_attachment("notes.txt", b"contenu")
        events = collect(self.chat.send(self.conv["id"], "Résume", [att["id"]])[0])
        self.assertEqual(events[-1]["error_kind"], "remote_files")
        events = collect(self.chat.regenerate(self.conv["id"], allow_remote_files=True))
        self.assertEqual(events[-1]["type"], "done")
        self.assertFalse(events[-1]["message"]["meta"]["resolution"]["is_local"])
        self.assertEqual(self.app.storage.usage_today(cfg["id"]), 1, "les requêtes distantes sont comptées")

    def test_auto_mode_falls_back_only_when_allowed(self):
        url, _ = self.start_remote()
        from nexaai.providers.registry import make_remote_config
        cfg = make_remote_config("custom", "Distant", url, is_local=False)
        self.app.secrets.set(cfg["id"], FakeOpenAIHandler.key)
        dead = f"http://127.0.0.1:{free_port()}"
        self.app.settings.update({"providers": {"remote": [cfg], "ollama": {"base_url": dead, "enabled": True}},
                                  "ai": {"mode": "auto", "remote_model": f"{cfg['id']}:remote-chat"}})
        events = collect(self.chat.send(self.conv["id"], "Bonjour")[0])
        self.assertEqual(events[-1]["type"], "error", "pas de bascule silencieuse vers un service distant")
        self.app.settings.update({"ai": {"auto_allow_remote": True}})
        events = collect(self.chat.regenerate(self.conv["id"]))
        self.assertEqual(events[-1]["type"], "done")
        res = events[-1]["message"]["meta"]["resolution"]
        self.assertFalse(res["is_local"])
        self.assertTrue(res["notes"], "la bascule est expliquée dans la réponse")

    def test_agent_tool_loop_with_real_result(self):
        events = collect(self.chat.send(self.conv["id"], 'OUTIL: {"name":"get_datetime","arguments":{}}')[0])
        actions = [e["action"] for e in events if e["type"] == "action"]
        self.assertEqual(actions[-1]["status"], "done")
        final = events[-1]["message"]
        self.assertIn("Nous sommes le", final["content"], "le résultat réel de l'outil est renvoyé au modèle")
        self.assertEqual(final["meta"]["action_details"][0]["tool"], "get_datetime")

    def test_agent_tool_denied_is_reported(self):
        events = collect(self.chat.send(self.conv["id"], 'OUTIL: {"name":"read_text_file","arguments":{"path":"/etc/passwd"}}')[0])
        action = [e["action"] for e in events if e["type"] == "action"][-1]
        self.assertEqual(action["status"], "denied")
        self.assertIn("statut : denied", events[-1]["message"]["content"])

    def test_tools_disabled(self):
        self.app.settings.update({"ai": {"agent_tools": False}})
        collect(self.chat.send(self.conv["id"], "Bonjour")[0])
        self.assertNotIn("tools", self.fake_state["requests"][-1])

    def test_reattach_to_running_job(self):
        job, _ = self.chat.send(self.conv["id"], "LENT")
        time.sleep(0.6)
        snap = job.snapshot()
        self.assertTrue(snap["text"])
        replay = [e for e in job.subscribe(poll=0.1) if e is not None]   # nouveau client : rejoue tout
        self.assertEqual("".join(e.get("text", "") for e in replay if e["type"] == "delta").strip(),
                         self.st.list_messages(self.conv["id"])[-1]["content"])
