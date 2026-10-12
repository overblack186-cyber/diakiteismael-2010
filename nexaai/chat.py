"""Moteur de conversation.

Une génération est un « job » exécuté dans un thread dédié : l'interface n'est
jamais bloquée. Les événements (texte progressif, actions, fin, erreur) sont
placés dans une file que le serveur HTTP transmet au navigateur en NDJSON.
Si le navigateur se déconnecte, la génération continue et le résultat est
enregistré ; le bouton Arrêter annule réellement la requête en cours.
"""
from __future__ import annotations

import base64
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any

from .config import Settings
from .providers.base import CancelToken, ProviderError
from .providers.registry import Registry, Resolution
from .storage import Storage
from .tools.executor import Executor

log = logging.getLogger("nexaai.chat")

LANG_NAMES = {"fr": "français", "en": "anglais", "es": "espagnol", "de": "allemand"}
MAX_TOOL_ROUNDS = 5
MAX_TEXT_ATTACHMENT = 60_000

SYSTEM_PROMPT = """Tu es NexaAI, l'assistant personnel de l'utilisateur, exécuté via le logiciel NexaAI sur son ordinateur.
Règles :
- Réponds de façon exacte, claire et structurée. Utilise le Markdown (titres courts, listes, blocs de code avec langage).
- Si tu ne sais pas, dis-le. N'invente ni faits, ni sources, ni résultats.
- Ne prétends jamais avoir effectué une action (envoyer un email, modifier un fichier, ouvrir une application...) si un outil ne l'a pas réellement fait et confirmé.
- Tu n'as pas accès à Internet sauf si un outil te le permet explicitement.
{language}{tools}{memory}{project}{extra}"""


def _memory_block(items: list[dict]) -> str:
    if not items:
        return ""
    lines = "\n".join(f"- [{ {'preference': 'préférence', 'fact': 'fait', 'project_note': 'note de projet'}[i['kind']] }] {i['content']}"
                      for i in items)
    return ("\nInformations que l'utilisateur a demandé de mémoriser (à utiliser seulement si pertinent ; "
            "si tu t'en sers, mentionne-le brièvement) :\n" + lines + "\n")


def _tokens(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-zà-ÿ0-9]{4,}", text.lower())}


def select_memories(items: list[dict], query: str, limit: int = 12) -> list[dict]:
    """Toutes les préférences + les faits/notes partageant des mots avec la demande."""
    prefs = [i for i in items if i["kind"] == "preference"][:limit]
    q = _tokens(query)
    scored = []
    for item in items:
        if item["kind"] == "preference":
            continue
        overlap = len(q & _tokens(item["content"]))
        if overlap:
            scored.append((overlap, item))
    scored.sort(key=lambda s: -s[0])
    return (prefs + [i for _, i in scored])[:limit]


def make_title(text: str, limit: int = 60) -> str:
    """Titre lisible à partir du premier message : sans syntaxe Markdown ni blocs de code."""
    text = re.sub(r"```.*?(```|$)", " ", text, flags=re.S)
    text = re.sub(r"[`*_#>~\[\]|]+", "", text)
    text = re.sub(r"\s+", " ", text).strip() or "Conversation"
    return text[:limit].rstrip() + ("…" if len(text) > limit else "")


class Job:
    """Génération en cours. Plusieurs clients peuvent suivre ses événements."""

    def __init__(self, job_id: str, conversation_id: str):
        self.id = job_id
        self.conversation_id = conversation_id
        self.cancel = CancelToken()
        self.started = time.time()
        self.finished = threading.Event()
        self._events: list[dict] = []
        self._cond = threading.Condition()

    def emit(self, event: dict | None) -> None:
        with self._cond:
            if event is not None:
                self._events.append(event)
            self._cond.notify_all()

    def subscribe(self, start: int = 0, poll: float = 15.0):
        """Produit les événements depuis l'indice `start`, jusqu'à la fin du job.

        Produit None périodiquement (toutes les `poll` secondes sans événement) pour
        permettre au serveur d'envoyer un signe de vie.
        """
        index = start
        while True:
            with self._cond:
                while index >= len(self._events) and not self.finished.is_set():
                    if not self._cond.wait(poll):
                        break
                batch = self._events[index:]
                done = self.finished.is_set()
            index += len(batch)
            if not batch and not done:
                yield None
                continue
            yield from batch
            if done and index >= len(self._events):
                return

    def snapshot(self) -> dict:
        with self._cond:
            text = "".join(e.get("text", "") for e in self._events if e["type"] == "delta")
            start = next((e for e in self._events if e["type"] == "start"), None)
            return {"job_id": self.id, "text": text, "events": len(self._events), "start": start}


class ChatService:
    def __init__(self, settings: Settings, storage: Storage, registry: Registry, executor: Executor):
        self.settings = settings
        self.storage = storage
        self.registry = registry
        self.executor = executor
        self.jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    # -- jobs ---------------------------------------------------------------
    def active_job(self, conversation_id: str) -> Job | None:
        with self._lock:
            for job in self.jobs.values():
                if job.conversation_id == conversation_id and not job.finished.is_set():
                    return job
        return None

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self.jobs.get(job_id)
        if not job:
            return False
        job.cancel.cancel()
        return True

    def cancel_all(self) -> None:
        with self._lock:
            jobs = list(self.jobs.values())
        for job in jobs:
            job.cancel.cancel()

    def wait_all(self, timeout: float = 5.0) -> None:
        deadline = time.time() + timeout
        with self._lock:
            jobs = list(self.jobs.values())
        for job in jobs:
            job.finished.wait(max(0.0, deadline - time.time()))

    # -- envoi ----------------------------------------------------------------
    def send(self, conversation_id: str, content: str, attachment_ids: list[str] | None = None,
             allow_remote_files: bool = False) -> tuple[Job, dict]:
        content = (content or "").strip()
        attachment_ids = attachment_ids or []
        if not content and not attachment_ids:
            raise ValueError("Le message est vide.")
        if self.active_job(conversation_id):
            raise RuntimeError("Une réponse est déjà en cours dans cette conversation.")
        conv = self.storage.get_conversation(conversation_id)
        attachments = [self.storage.get_attachment(a) for a in attachment_ids]
        meta = {"attachments": [{k: a[k] for k in ("id", "name", "mime", "size", "kind")} for a in attachments]}
        user_msg = self.storage.add_message(conversation_id, "user", content, meta=meta)
        if conv["message_count"] == 0 and conv["title"] in ("Nouvelle conversation", ""):
            self.storage.update_conversation(conversation_id, title=make_title(content or attachments[0]["name"]))
        job = self._start(conversation_id, allow_remote_files)
        return job, user_msg

    def regenerate(self, conversation_id: str, allow_remote_files: bool = False) -> Job:
        """Supprime la dernière réponse de l'assistant et relance la génération."""
        if self.active_job(conversation_id):
            raise RuntimeError("Une réponse est déjà en cours dans cette conversation.")
        messages = self.storage.list_messages(conversation_id)
        last_user = next((m for m in reversed(messages) if m["role"] == "user"), None)
        if not last_user:
            raise ValueError("Aucun message à reprendre.")
        self.storage.delete_messages_after(last_user["id"])
        return self._start(conversation_id, allow_remote_files)

    def edit_and_resend(self, message_id: str, content: str, allow_remote_files: bool = False) -> Job:
        msg = self.storage.get_message(message_id)
        if msg["role"] != "user":
            raise ValueError("Seuls vos messages peuvent être modifiés.")
        if not content.strip():
            raise ValueError("Le message est vide.")
        if self.active_job(msg["conversation_id"]):
            raise RuntimeError("Une réponse est déjà en cours dans cette conversation.")
        self.storage.update_message(message_id, content=content.strip(), meta={"edited": True})
        self.storage.delete_messages_after(message_id)
        return self._start(msg["conversation_id"], allow_remote_files)

    def _start(self, conversation_id: str, allow_remote_files: bool) -> Job:
        job = Job(f"job_{int(time.time() * 1000)}_{len(self.jobs)}", conversation_id)
        with self._lock:
            # on ne garde que les jobs récents en mémoire
            for jid in [j for j, v in self.jobs.items() if v.finished.is_set() and time.time() - v.started > 600]:
                del self.jobs[jid]
            self.jobs[job.id] = job
        threading.Thread(target=self._run, args=(job, allow_remote_files), name=job.id, daemon=True).start()
        return job

    # -- préparation du contexte ---------------------------------------------
    def _need_and_text(self, history: list[dict]) -> tuple[set[str], str]:
        last = next((m for m in reversed(history) if m["role"] == "user"), None)
        need: set[str] = set()
        if last:
            for att in last["meta"].get("attachments", []):
                if att["kind"] == "image":
                    need.add("vision")
        return need, (last or {}).get("content", "")

    def _build_messages(self, conv: dict, history: list[dict], res: Resolution, use_tools: bool,
                        query: str) -> tuple[list[dict], list[dict]]:
        lang = self.settings.get("general", "reply_language")
        language = "" if lang == "auto" else f"- Réponds en {LANG_NAMES.get(lang, 'français')}, sauf demande contraire.\n"
        tools = ("- Tu disposes d'outils. Utilise-les seulement quand c'est utile ; certaines actions demandent la "
                 "confirmation de l'utilisateur. Rapporte fidèlement leur résultat, y compris les échecs.\n"
                 "- N'utilise l'outil « remember » que si l'utilisateur demande explicitement de retenir quelque chose.\n"
                 if use_tools else "")
        memories: list[dict] = []
        if self.settings.get("memory", "enabled") and self.settings.get("memory", "inject"):
            pool = self.storage.list_memory(enabled_only=True)
            pool = [m for m in pool if m["kind"] != "project_note" or m["project_id"] == conv.get("project_id")]
            memories = select_memories(pool, query)
        project = ""
        if conv.get("project_id"):
            try:
                p = self.storage.get_project(conv["project_id"])
                files = self.storage.list_project_files(p["id"])
                project = (f"\nCette conversation appartient au projet « {p['name']} ».\n"
                           + (f"Description : {p['description']}\n" if p["description"] else "")
                           + (f"Notes du projet : {p['notes']}\n" if p["notes"] else "")
                           + ("Fichiers associés (contenu non lu sauf pièce jointe ou outil) : "
                              + ", ".join(Path(f['path']).name for f in files[:30]) + "\n" if files else ""))
            except KeyError:
                pass
        extra = self.settings.get("ai", "system_prompt_extra").strip()
        system = SYSTEM_PROMPT.format(language=language, tools=tools, memory=_memory_block(memories), project=project,
                                      extra=f"\nConsignes de l'utilisateur :\n{extra}\n" if extra else "")
        out = [{"role": "system", "content": system}]

        # Budget de contexte approximatif (≈ 3,5 caractères par jeton).
        ctx = self.settings.get("ai", "num_ctx") or res.model.context_length or 8192
        budget = int(min(ctx, 128_000) * 3.5 * 0.75) - len(system)
        selected: list[dict] = []
        used = 0
        for msg in reversed(history):
            if msg["role"] not in ("user", "assistant") or (msg["role"] == "assistant" and msg["status"] == "error"):
                continue
            converted = self._convert(msg, res, is_last=not selected)
            size = len(converted["content"]) + 1500 * len(converted.get("images", []))
            if selected and used + size > budget:
                break
            used += size
            selected.append(converted)
        out.extend(reversed(selected))
        return out, memories

    def _convert(self, msg: dict, res: Resolution, is_last: bool) -> dict:
        content = msg["content"]
        images = []
        for att in msg["meta"].get("attachments", []):
            try:
                stored = self.storage.get_attachment(att["id"])
            except KeyError:
                content += f"\n\n[Pièce jointe « {att['name']} » supprimée]"
                continue
            path = Path(stored["path"])
            if stored["kind"] == "text" and path.exists():
                text = path.read_text(encoding="utf-8", errors="replace")[:MAX_TEXT_ATTACHMENT]
                content += f"\n\n--- Fichier joint : {stored['name']} ---\n{text}\n--- Fin du fichier ---"
            elif stored["kind"] == "image" and path.exists():
                if is_last and "vision" in res.model.capabilities:
                    images.append(base64.b64encode(path.read_bytes()).decode("ascii"))
                else:
                    content += f"\n\n[Image jointe « {stored['name']} » — non transmise]"
            else:
                content += f"\n\n[Fichier « {stored['name']} » : format non pris en charge, contenu non transmis]"
        out = {"role": msg["role"], "content": content}
        if images:
            out["images"] = images
        return out

    # -- exécution ------------------------------------------------------------
    def _run(self, job: Job, allow_remote_files: bool) -> None:
        conv_id = job.conversation_id
        text = ""
        thinking = ""
        actions: list[dict] = []
        res: Resolution | None = None
        assistant_meta: dict[str, Any] = {}
        try:
            conv = self.storage.get_conversation(conv_id)
            history = self.storage.list_messages(conv_id)
            need, query = self._need_and_text(history)
            res = self.registry.resolve(conv.get("model_pref", ""), need, query)
            last_user = next((m for m in reversed(history) if m["role"] == "user"), None)
            has_files = bool(last_user and last_user["meta"].get("attachments"))
            if res.is_remote and has_files and not allow_remote_files:
                raise ProviderError(f"Ce message contient des pièces jointes et serait envoyé à {res.provider.name} "
                                    f"(service distant). Confirmez l'envoi pour continuer.", kind="remote_files",
                                    retryable=True)
            use_tools = bool(self.settings.get("ai", "agent_tools") and "tools" in res.model.capabilities)
            messages, memories = self._build_messages(conv, history, res, use_tools, query)
            assistant_meta = {"resolution": res.describe(), "memories": [{"id": m["id"], "content": m["content"],
                                                                          "kind": m["kind"]} for m in memories]}
            job.emit({"type": "start", "job_id": job.id, **assistant_meta})

            attempts = [(res.provider, res.model)] + list(res.fallbacks)
            stats: dict = {}
            for attempt, (provider, model) in enumerate(attempts):
                try:
                    if attempt:
                        note = (f"{res.model.name} a échoué : bascule vers {model.name} ({provider.name}, "
                                f"{'local' if model.is_local else 'distant'}), autorisée dans vos réglages.")
                        assistant_meta["resolution"]["notes"].append(note)
                        assistant_meta["resolution"].update({"provider_id": provider.id, "provider_name": provider.name,
                                                             "model": model.name, "is_local": model.is_local})
                        job.emit({"type": "notice", "text": note, "resolution": assistant_meta["resolution"]})
                    self.registry.check_limit(provider)
                    stats = {}
                    for round_no in range(MAX_TOOL_ROUNDS + 1):
                        tools = self.executor.schemas() if use_tools and round_no < MAX_TOOL_ROUNDS else None
                        calls = None
                        if not model.is_local:
                            self.storage.count_request(provider.id)
                        for event in provider.chat(model.name, messages, {
                                "temperature": self.settings.get("ai", "temperature"),
                                "num_ctx": self.settings.get("ai", "num_ctx") or None}, tools, job.cancel):
                            if event.type == "delta":
                                text += event.text
                                job.emit({"type": "delta", "text": event.text})
                            elif event.type == "thinking":
                                thinking += event.text
                                job.emit({"type": "thinking", "text": event.text})
                            elif event.type == "tool_calls":
                                calls = event.tool_calls
                            elif event.type == "done":
                                stats = event.stats or {}
                        if not calls:
                            break
                        messages.append({"role": "assistant", "content": text, "tool_calls": calls})
                        for call in calls:
                            action = self.executor.run(call["name"], call.get("arguments", {}), origin="agent",
                                                       conversation_id=conv_id, cancel=job.cancel,
                                                       on_update=lambda a: job.emit({"type": "action", "action": a}))
                            actions.append(action)
                            messages.append({"role": "tool", "name": call["name"], "tool_call_id": call.get("id"),
                                             "content": f"[statut : {action['status']}] {action['result']}"})
                        if job.cancel.cancelled:
                            raise ProviderError("Génération interrompue.", kind="cancelled")
                        if text and not text.endswith("\n"):
                            text += "\n\n"
                            job.emit({"type": "delta", "text": "\n\n"})
                    break
                except ProviderError as exc:
                    if (exc.kind != "unreachable" or text or attempt == len(attempts) - 1 or job.cancel.cancelled):
                        raise
            assistant_meta.update({"stats": stats, "actions": [a["id"] for a in actions], "thinking": thinking,
                                   "duration": round(time.time() - job.started, 2)})
            if not text.strip() and not actions:
                raise ProviderError("Le modèle a renvoyé une réponse vide.", kind="provider")
            final = res_final = assistant_meta["resolution"]
            msg = self.storage.add_message(conv_id, "assistant", text.strip(), "ok", res_final["provider_id"],
                                           res_final["model"], {**assistant_meta, "action_details": actions})
            job.emit({"type": "done", "message": msg})
            log.info("Réponse générée (%s/%s, %.1fs)", final["provider_id"], final["model"], time.time() - job.started)
        except ProviderError as exc:
            cancelled = exc.kind == "cancelled" or job.cancel.cancelled
            status = "stopped" if cancelled else "error"
            meta = {**assistant_meta, "error": None if cancelled else str(exc), "error_kind": exc.kind,
                    "retryable": exc.retryable, "thinking": thinking, "action_details": actions,
                    "duration": round(time.time() - job.started, 2)}
            if not meta.get("resolution") and res:
                meta["resolution"] = res.describe()
            r = meta.get("resolution") or {}
            msg = self.storage.add_message(conv_id, "assistant", text.strip(), status, r.get("provider_id", ""),
                                           r.get("model", ""), meta)
            job.emit({"type": "stopped" if cancelled else "error", "message": msg, "error": str(exc),
                      "error_kind": exc.kind})
            if not cancelled:
                log.warning("Échec de génération : %s", exc)
        except Exception as exc:  # erreur interne : jamais silencieuse
            log.exception("Erreur interne pendant la génération")
            msg = self.storage.add_message(conv_id, "assistant", text.strip(), "error", "", "",
                                           {**assistant_meta, "error": f"Erreur interne : {exc}", "error_kind": "internal",
                                            "retryable": True})
            job.emit({"type": "error", "message": msg, "error": f"Erreur interne : {exc}", "error_kind": "internal"})
        finally:
            job.finished.set()
            job.emit(None)
