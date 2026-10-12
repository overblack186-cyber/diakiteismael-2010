"""Serveur HTTP local de NexaAI (bibliothèque standard uniquement).

Sécurité :
* écoute uniquement sur 127.0.0.1 ;
* chaque appel /api exige le jeton de session injecté dans la page
  (empêche un site web ouvert dans le navigateur de piloter NexaAI) ;
* l'en-tête Host est vérifié (protection contre le « DNS rebinding »).
"""
from __future__ import annotations

import json
import logging
import mimetypes
import re
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, unquote, urlsplit

from . import __version__, logs, studio, system, vision_assets
from .chat import ChatService
from .config import Settings, SettingsError
from .files import IMAGE_EXT, Files, kind_of
from .paths import WEB_DIR, sub_dir
from .providers.base import CancelToken, ProviderError
from .providers.openai_compat import PRESETS
from .providers.registry import Registry, make_remote_config
from .secrets_store import SecretStore
from .storage import NotFound, Storage
from .tools.executor import Executor
from .tools.permissions import PermissionDenied, Permissions

log = logging.getLogger("nexaai.server")
MAX_UPLOAD = 20 * 1024 * 1024
MAX_JSON = 2 * 1024 * 1024


class ApiError(Exception):
    def __init__(self, status: int, message: str, kind: str = "error"):
        super().__init__(message)
        self.status = status
        self.kind = kind


class App:
    """Regroupe tous les services de l'application."""

    def __init__(self, settings: Settings | None = None, storage: Storage | None = None,
                 secrets_store: SecretStore | None = None):
        self.settings = settings or Settings()
        self.storage = storage or Storage()
        self.storage.purge_empty_conversations()
        self.secrets = secrets_store or SecretStore()
        self.permissions = Permissions(self.settings)
        self.files = Files(self.permissions)
        self.registry = Registry(self.settings, self.secrets, self.storage)
        self.executor = Executor(self.settings, self.storage, self.permissions, self.files)
        self.chat = ChatService(self.settings, self.storage, self.registry, self.executor)
        self.vision = vision_assets.Installer()
        self.token = secrets.token_urlsafe(24)
        self.port = 0
        self.last_heartbeat = time.time()
        self.shutdown_requested = threading.Event()
        self.routes: list[tuple[str, re.Pattern, Callable]] = []
        self.previews: dict[str, tuple[str, bool]] = {}
        self._register_routes()

    # -- routage ------------------------------------------------------------
    def route(self, method: str, pattern: str):
        regex = re.compile("^" + re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", pattern) + "$")

        def deco(fn):
            self.routes.append((method, regex, fn))
            return fn
        return deco

    def match(self, method: str, path: str):
        allowed = False
        for m, regex, fn in self.routes:
            found = regex.match(path)
            if found:
                if m == method:
                    return fn, found.groupdict()
                allowed = True
        if allowed:
            raise ApiError(405, "Méthode non autorisée")
        raise ApiError(404, "Route inconnue")

    # -- routes ---------------------------------------------------------------
    def _register_routes(self) -> None:  # noqa: C901 — table de routage volontairement explicite
        r = self.route
        st, chat = self.storage, self.chat

        @r("GET", "/api/bootstrap")
        def bootstrap(req):
            return {"version": __version__, "settings": self.settings.all(), "token_ok": True,
                    "presets": {k: v for k, v in PRESETS.items()}, "tk": system.tk_available(),
                    "vision": self.vision.status(), "tools": self.executor.catalog()}

        @r("POST", "/api/system/heartbeat")
        def heartbeat(req):
            self.last_heartbeat = time.time()
            return {"ok": True}

        @r("GET", "/api/system/info")
        def sys_info(req):
            return system.info(self.registry, st, self.port)

        @r("GET", "/api/system/logs")
        def sys_logs(req):
            return {"lines": logs.tail(int(req.query.get("lines", 200)))}

        @r("GET", "/api/system/export")
        def sys_export(req):
            return {"exported_at": time.time(), "version": __version__, "settings": self.settings.all(),
                    **st.export_all()}

        @r("POST", "/api/system/pick")
        def sys_pick(req):
            try:
                return {"path": system.pick_path(req.json.get("kind", "folder"))}
            except (RuntimeError, ValueError, OSError) as exc:
                raise ApiError(400, str(exc))

        @r("POST", "/api/system/shutdown")
        def sys_shutdown(req):
            self.shutdown_requested.set()
            return {"ok": True}

        # réglages ------------------------------------------------------------
        @r("GET", "/api/settings")
        def get_settings(req):
            return self.settings.all()

        @r("PATCH", "/api/settings")
        def patch_settings(req):
            patch = req.json
            for protected in ("providers", "files"):
                if protected in patch:
                    raise ApiError(400, f"La section {protected} se modifie via son API dédiée.")
            if "pc" in patch and "allowed_apps" in patch["pc"]:
                raise ApiError(400, "Les applications autorisées se modifient via /api/pc/apps.")
            try:
                return self.settings.update(patch)
            except SettingsError as exc:
                raise ApiError(400, str(exc))

        # modèles et fournisseurs --------------------------------------------
        @r("GET", "/api/models")
        def models(req):
            return self.registry.catalog(refresh=req.query.get("refresh") == "1")

        @r("POST", "/api/models/resolve")
        def resolve(req):
            try:
                res = self.registry.resolve(req.json.get("model_pref", ""), set(req.json.get("need", [])),
                                            req.json.get("text", ""))
                return {"ok": True, **res.describe()}
            except ProviderError as exc:
                return {"ok": False, "error": str(exc), "kind": exc.kind}

        @r("POST", "/api/providers/ollama/test")
        def ollama_test(req):
            oll = self.registry.ollama()
            if not oll:
                return {"ok": False, "detail": "Ollama est désactivé."}
            started = time.time()
            health = oll.health()
            return {**health, "latency_ms": round((time.time() - started) * 1000)}

        @r("PATCH", "/api/providers/ollama")
        def ollama_patch(req):
            cfg = self.settings.get("providers", "ollama")
            if "base_url" in req.json:
                url = str(req.json["base_url"]).strip().rstrip("/")
                if not url.startswith(("http://", "https://")):
                    raise ApiError(400, "L'adresse doit commencer par http:// ou https://")
                cfg["base_url"] = url
            if "enabled" in req.json:
                cfg["enabled"] = bool(req.json["enabled"])
            self.settings.update({"providers": {"ollama": cfg}})
            return cfg

        @r("POST", "/api/ollama/pull")
        def ollama_pull(req):
            name = str(req.json.get("model", "")).strip()
            if not re.fullmatch(r"[A-Za-z0-9._:/\-]{1,100}", name):
                raise ApiError(400, "Nom de modèle invalide")
            oll = self.registry.ollama()
            if not oll:
                raise ApiError(400, "Ollama est désactivé.")
            token = CancelToken()

            def gen():
                try:
                    for item in oll.pull(name, token):
                        yield {"type": "progress", **item}
                    yield {"type": "done"}
                except ProviderError as exc:
                    yield {"type": "error", "error": str(exc)}
            return Stream(gen(), on_close=token.cancel)

        @r("POST", "/api/providers")
        def add_provider(req):
            body = req.json
            try:
                cfg = make_remote_config(body.get("preset", "custom"), body.get("name", ""), body.get("base_url", ""),
                                         body.get("daily_limit", 0),
                                         body.get("is_local") if body.get("preset") == "custom" else None)
            except ValueError as exc:
                raise ApiError(400, str(exc))
            remote = self.settings.get("providers", "remote") + [cfg]
            self.settings.update({"providers": {"remote": remote}})
            if body.get("api_key"):
                self.secrets.set(cfg["id"], body["api_key"])
            return cfg

        @r("PATCH", "/api/providers/{pid}")
        def patch_provider(req, pid):
            remote = self.settings.get("providers", "remote")
            cfg = next((c for c in remote if c["id"] == pid), None)
            if not cfg:
                raise ApiError(404, "Fournisseur introuvable")
            body = req.json
            for key in ("name", "enabled", "daily_limit", "base_url"):
                if key in body:
                    cfg[key] = body[key]
            if not str(cfg["base_url"]).startswith(("http://", "https://")):
                raise ApiError(400, "Adresse invalide")
            self.settings.update({"providers": {"remote": remote}})
            if body.get("api_key"):
                self.secrets.set(pid, body["api_key"])
            if body.get("delete_key"):
                self.secrets.delete(pid)
            self.registry._remote_cache.pop(pid, None)
            return {**cfg, "key": self.secrets.describe(pid)}

        @r("DELETE", "/api/providers/{pid}")
        def delete_provider(req, pid):
            remote = [c for c in self.settings.get("providers", "remote") if c["id"] != pid]
            self.settings.update({"providers": {"remote": remote}})
            self.secrets.delete(pid)
            ai = self.settings.get("ai", "remote_model")
            if ai.startswith(pid + ":"):
                self.settings.update({"ai": {"remote_model": ""}})
            return {"ok": True}

        @r("POST", "/api/providers/{pid}/test")
        def test_provider(req, pid):
            try:
                prov = self.registry.provider(pid)
                started = time.time()
                models = self.registry.models_for(prov, refresh=True)
                return {"ok": True, "detail": f"{len(models)} modèle(s) accessible(s).",
                        "latency_ms": round((time.time() - started) * 1000)}
            except ProviderError as exc:
                return {"ok": False, "detail": str(exc)}

        # conversations ---------------------------------------------------------
        @r("GET", "/api/conversations")
        def list_convs(req):
            archived = {"0": False, "1": True, "all": None}.get(req.query.get("archived", "0"), False)
            return {"items": st.list_conversations(archived, int(req.query.get("limit", 50)),
                                                   int(req.query.get("offset", 0)), req.query.get("project_id"))}

        @r("POST", "/api/conversations")
        def create_conv(req):
            return st.create_conversation(req.json.get("title") or "Nouvelle conversation",
                                          req.json.get("project_id") or None)

        @r("GET", "/api/conversations/{cid}")
        def get_conv(req, cid):
            conv = st.get_conversation(cid)
            job = chat.active_job(cid)
            return {**conv, "messages": st.list_messages(cid), "active_job": job.snapshot() if job else None}

        @r("PATCH", "/api/conversations/{cid}")
        def patch_conv(req, cid):
            try:
                return st.update_conversation(cid, **req.json)
            except ValueError as exc:
                raise ApiError(400, str(exc))

        @r("DELETE", "/api/conversations/{cid}")
        def delete_conv(req, cid):
            job = chat.active_job(cid)
            if job:
                job.cancel.cancel()
                job.finished.wait(5)
            st.delete_conversation(cid)
            return {"ok": True}

        @r("POST", "/api/conversations/{cid}/messages")
        def send(req, cid):
            body = req.json
            try:
                job, user_msg = chat.send(cid, body.get("content", ""), body.get("attachments", []),
                                          bool(body.get("allow_remote_files")))
            except ValueError as exc:
                raise ApiError(400, str(exc))
            except RuntimeError as exc:
                raise ApiError(409, str(exc))
            return job_stream(job, {"type": "accepted", "job_id": job.id, "user_message": user_msg})

        @r("POST", "/api/conversations/{cid}/regenerate")
        def regenerate(req, cid):
            try:
                job = chat.regenerate(cid, bool(req.json.get("allow_remote_files")))
            except ValueError as exc:
                raise ApiError(400, str(exc))
            except RuntimeError as exc:
                raise ApiError(409, str(exc))
            return job_stream(job, {"type": "accepted", "job_id": job.id})

        @r("GET", "/api/jobs/{jid}/stream")
        def attach(req, jid):
            job = chat.jobs.get(jid)
            if not job:
                raise ApiError(404, "Tâche terminée ou introuvable")
            return job_stream(job, {"type": "attached", "job_id": jid}, close_cancels=False)

        @r("POST", "/api/jobs/{jid}/cancel")
        def cancel(req, jid):
            return {"ok": chat.cancel(jid)}

        @r("POST", "/api/messages/{mid}/edit")
        def edit(req, mid):
            try:
                job = chat.edit_and_resend(mid, req.json.get("content", ""), bool(req.json.get("allow_remote_files")))
            except ValueError as exc:
                raise ApiError(400, str(exc))
            except RuntimeError as exc:
                raise ApiError(409, str(exc))
            return job_stream(job, {"type": "accepted", "job_id": job.id})

        @r("DELETE", "/api/messages/{mid}")
        def delete_msg(req, mid):
            msg = st.get_message(mid)
            if chat.active_job(msg["conversation_id"]):
                raise ApiError(409, "Impossible de supprimer un message pendant une génération.")
            st.delete_message(mid)
            return {"ok": True}

        @r("POST", "/api/messages/{mid}/report")
        def report(req, mid):
            reason = str(req.json.get("reason", "")).strip()[:500] or "Réponse incorrecte"
            msg = st.update_message(mid, meta={"reported": {"reason": reason, "at": time.time()}})
            log.info("Réponse signalée (message %s, modèle %s) : %s", mid, msg["model"], reason)
            return msg

        @r("GET", "/api/search")
        def search(req):
            return {"query": req.query.get("q", ""), "results": st.search(req.query.get("q", ""))}

        # pièces jointes ------------------------------------------------------
        @r("POST", "/api/attachments")
        def upload(req):
            name = Path(unquote(req.query.get("name", "fichier"))).name[:180] or "fichier"
            data = req.raw_body(MAX_UPLOAD)
            return self.save_attachment(name, data)

        @r("POST", "/api/files/attach")
        def attach_file(req):
            path = self.permissions.check(req.json.get("path", ""))
            if not path.is_file():
                raise ApiError(400, "Ce chemin n'est pas un fichier")
            if path.stat().st_size > MAX_UPLOAD:
                raise ApiError(400, "Fichier trop volumineux (20 Mo maximum)")
            return self.save_attachment(path.name, path.read_bytes())

        @r("GET", "/api/attachments/{aid}/raw")
        def attachment_raw(req, aid):
            att = st.get_attachment(aid)
            return FileResponse(Path(att["path"]), att["mime"])

        # projets ------------------------------------------------------------------
        @r("GET", "/api/projects")
        def list_projects(req):
            return {"items": st.list_projects()}

        @r("POST", "/api/projects")
        def create_project(req):
            try:
                return st.create_project(req.json.get("name", ""), req.json.get("description", ""))
            except ValueError as exc:
                raise ApiError(400, str(exc))

        @r("GET", "/api/projects/{pid}")
        def get_project(req, pid):
            p = st.get_project(pid)
            files = []
            for f in st.list_project_files(pid):
                entry = {**f, "exists": Path(f["path"]).exists(), "kind": kind_of(Path(f["path"]))}
                files.append(entry)
            return {**p, "conversations": st.list_conversations(None, 200, 0, pid), "files": files,
                    "notes_memory": st.list_memory("project_note", project_id=pid)}

        @r("PATCH", "/api/projects/{pid}")
        def patch_project(req, pid):
            try:
                return st.update_project(pid, **req.json)
            except ValueError as exc:
                raise ApiError(400, str(exc))

        @r("DELETE", "/api/projects/{pid}")
        def delete_project(req, pid):
            st.delete_project(pid)
            return {"ok": True}

        @r("POST", "/api/projects/{pid}/files")
        def add_project_file(req, pid):
            path = self.permissions.check(req.json.get("path", ""))
            if not path.exists():
                raise ApiError(400, "Chemin introuvable")
            return st.add_project_file(pid, str(path))

        @r("DELETE", "/api/projects/{pid}/files/{fid}")
        def remove_project_file(req, pid, fid):
            st.remove_project_file(pid, fid)
            return {"ok": True}

        # mémoire -------------------------------------------------------------------
        @r("GET", "/api/memory")
        def list_memory(req):
            return {"items": st.list_memory(req.query.get("kind") or None), "settings": self.settings.get("memory", "enabled")}

        @r("POST", "/api/memory")
        def add_memory(req):
            try:
                return st.add_memory(req.json.get("kind", "fact"), req.json.get("content", ""),
                                     req.json.get("project_id") or None, req.json.get("source", "manual"))
            except ValueError as exc:
                raise ApiError(400, str(exc))

        @r("PATCH", "/api/memory/{mid}")
        def patch_memory(req, mid):
            try:
                return st.update_memory(mid, **req.json)
            except ValueError as exc:
                raise ApiError(400, str(exc))

        @r("DELETE", "/api/memory/{mid}")
        def delete_memory(req, mid):
            st.delete_memory(mid)
            return {"ok": True}

        @r("POST", "/api/memory/clear")
        def clear_memory(req):
            if req.json.get("confirm") != "EFFACER":
                raise ApiError(400, "Confirmation manquante")
            return {"deleted": st.clear_memory()}

        # fichiers -------------------------------------------------------------------
        @r("GET", "/api/files/folders")
        def folders(req):
            return {"items": self.permissions.folders()}

        @r("POST", "/api/files/folders")
        def add_folder(req):
            try:
                return {"items": self.permissions.add_folder(req.json.get("path", ""), req.json.get("access", "read"))}
            except ValueError as exc:
                raise ApiError(400, str(exc))

        @r("POST", "/api/files/folders/remove")
        def remove_folder(req):
            return {"items": self.permissions.remove_folder(req.json.get("path", ""))}

        @r("GET", "/api/files/list")
        def list_files(req):
            return self.files.list_dir(req.query.get("path", ""))

        @r("GET", "/api/files/info")
        def file_info(req):
            return self.files.info(req.query.get("path", ""))

        @r("GET", "/api/files/read")
        def file_read(req):
            try:
                return self.files.read_text(req.query.get("path", ""))
            except ValueError as exc:
                raise ApiError(415, str(exc))

        @r("GET", "/api/files/raw")
        def file_raw(req):
            path = self.permissions.check(req.query.get("path", ""))
            if path.suffix.lower() not in IMAGE_EXT:
                raise ApiError(415, "Aperçu disponible uniquement pour les images")
            return FileResponse(path, IMAGE_EXT[path.suffix.lower()])

        @r("POST", "/api/files/open")
        def file_open(req):
            action = self.executor.run("open_path", {"path": req.json.get("path", "")}, origin="user")
            return action

        @r("POST", "/api/files/write")
        def file_write(req):
            try:
                return self.files.write_text(req.json.get("path", ""), req.json.get("content", ""))
            except ValueError as exc:
                raise ApiError(400, str(exc))

        @r("GET", "/api/files/backups")
        def backups(req):
            return {"items": self.files.list_backups(req.query.get("path", ""))}

        @r("POST", "/api/files/restore")
        def restore(req):
            return self.files.restore_backup(req.json.get("path", ""), req.json.get("backup_id", ""))

        # studio ----------------------------------------------------------------------
        @r("POST", "/api/studio/propose")
        def studio_propose(req):
            body = req.json
            content, instruction = body.get("content", ""), str(body.get("instruction", "")).strip()
            if not instruction:
                raise ApiError(400, "Décrivez la modification souhaitée.")
            try:
                res = self.registry.resolve("", set(), "```code " + instruction)
            except ProviderError as exc:
                raise ApiError(503, str(exc), exc.kind)
            if res.is_remote and not body.get("allow_remote"):
                raise ApiError(409, f"Le fichier serait envoyé à {res.provider.name} (service distant). "
                                    f"Confirmez pour continuer.", "remote_files")
            token = CancelToken()

            def gen():
                yield {"type": "start", "resolution": res.describe()}
                answer = ""
                try:
                    if not res.model.is_local:
                        st.count_request(res.provider.id)
                    for ev in res.provider.chat(res.model.name, studio.build_messages(body.get("filename", ""), content,
                                                                                       instruction),
                                                {"temperature": 0.2}, None, token):
                        if ev.type == "delta":
                            answer += ev.text
                            yield {"type": "delta", "text": ev.text}
                    code = studio.extract_code(answer)
                    if code is None:
                        yield {"type": "error", "error": "La réponse ne contient pas de bloc de code complet : "
                                                         "aucune modification proposée.", "answer": answer}
                        return
                    yield {"type": "proposal", "code": code, "diff": studio.diff_lines(content, code)}
                except ProviderError as exc:
                    yield {"type": "error", "error": str(exc)}
            return Stream(gen(), on_close=token.cancel)

        @r("POST", "/api/studio/preview")
        def studio_preview(req):
            html = str(req.json.get("html", ""))[:2_000_000]
            pid = secrets.token_urlsafe(16)
            self.previews[pid] = (html, bool(req.json.get("allow_scripts")))
            while len(self.previews) > 10:
                self.previews.pop(next(iter(self.previews)))
            return {"url": f"/preview/{pid}"}

        @r("POST", "/api/studio/diff")
        def studio_diff(req):
            return studio.diff_lines(req.json.get("old", ""), req.json.get("new", ""))

        # contrôle du PC ---------------------------------------------------------------
        @r("GET", "/api/pc/apps")
        def apps(req):
            return {"items": self.permissions.apps(), "confirm_actions": self.settings.get("pc", "confirm_actions")}

        @r("POST", "/api/pc/apps")
        def add_app(req):
            try:
                return {"items": self.permissions.add_app(req.json.get("name", ""), req.json.get("path", ""),
                                                          req.json.get("args", ""))}
            except ValueError as exc:
                raise ApiError(400, str(exc))

        @r("DELETE", "/api/pc/apps/{app_id}")
        def remove_app(req, app_id):
            return {"items": self.permissions.remove_app(app_id)}

        @r("POST", "/api/pc/apps/{app_id}/launch")
        def launch_app(req, app_id):
            return self.executor.run("launch_app", {"app_id": app_id}, origin=req.json.get("origin", "user"))

        @r("GET", "/api/tools")
        def tools(req):
            return {"items": self.executor.catalog()}

        @r("GET", "/api/actions")
        def actions(req):
            return {"items": st.list_actions(int(req.query.get("limit", 100))), "pending": self.executor.hub.pending_ids()}

        @r("POST", "/api/actions/{aid}/decide")
        def decide(req, aid):
            ok = self.executor.hub.decide(aid, bool(req.json.get("approve")))
            if not ok:
                raise ApiError(404, "Cette action n'attend plus de décision.")
            return {"ok": True}

        # gestes ------------------------------------------------------------------------
        @r("GET", "/api/gestures")
        def gestures(req):
            return {"items": st.list_gestures(with_samples=req.query.get("samples") == "1")}

        @r("POST", "/api/gestures")
        def create_gesture(req):
            body = req.json
            try:
                g = st.create_gesture(body.get("name", ""), body.get("action", ""), body.get("sensitivity", 1.0))
                if body.get("samples"):
                    g = st.add_gesture_samples(g["id"], body["samples"])
                return g
            except ValueError as exc:
                raise ApiError(400, str(exc))

        @r("PATCH", "/api/gestures/{gid}")
        def patch_gesture(req, gid):
            try:
                return st.update_gesture(gid, **req.json)
            except ValueError as exc:
                raise ApiError(400, str(exc))

        @r("DELETE", "/api/gestures/{gid}")
        def delete_gesture(req, gid):
            st.delete_gesture(gid)
            return {"ok": True}

        @r("POST", "/api/gestures/{gid}/samples")
        def add_samples(req, gid):
            try:
                return st.add_gesture_samples(gid, req.json.get("samples", []))
            except ValueError as exc:
                raise ApiError(400, str(exc))

        @r("DELETE", "/api/gestures/{gid}/samples/{sid}")
        def delete_sample(req, gid, sid):
            st.delete_gesture_sample(gid, sid)
            return {"ok": True}

        # vision ------------------------------------------------------------------------
        @r("GET", "/api/vision/status")
        def vision_status(req):
            return self.vision.status()

        @r("POST", "/api/vision/install")
        def vision_install(req):
            return self.vision.start()

    def save_attachment(self, name: str, data: bytes) -> dict:
        path = Path(name)
        kind = kind_of(path)
        mime = mimetypes.guess_type(name)[0] or ("text/plain" if kind == "text" else "application/octet-stream")
        if kind == "text":
            try:
                data.decode("utf-8")
            except UnicodeDecodeError:
                kind = "unsupported"
        target = sub_dir("attachments") / f"{secrets.token_hex(8)}{path.suffix.lower()[:10]}"
        target.write_bytes(data)
        return self.storage.add_attachment(name, mime, len(data), kind, str(target))


# -- réponses spéciales -------------------------------------------------------

class Stream:
    """Réponse NDJSON diffusée progressivement."""

    def __init__(self, generator, on_close: Callable[[], None] | None = None):
        self.generator = generator
        self.on_close = on_close


class FileResponse:
    def __init__(self, path: Path, mime: str):
        self.path = path
        self.mime = mime


def job_stream(job, first: dict, close_cancels: bool = False) -> Stream:
    def gen():
        yield first
        for event in job.subscribe():
            yield {"type": "ping"} if event is None else event
    # La déconnexion du navigateur n'annule pas la génération : elle est enregistrée
    # et peut être reprise (bouton Arrêter pour annuler explicitement).
    return Stream(gen(), on_close=job.cancel.cancel if close_cancels else None)


class Request:
    def __init__(self, handler: "Handler", query: dict):
        self.handler = handler
        self.query = query
        self._json: Any = None

        self._consumed = False

    def raw_body(self, limit: int) -> bytes:
        length = int(self.handler.headers.get("Content-Length") or 0)
        if length > limit:
            self.handler.close_connection = True  # corps non lu : la connexion ne peut pas être réutilisée
            raise ApiError(413, f"Contenu trop volumineux (maximum {limit // (1024 * 1024)} Mo)")
        self._consumed = True
        return self.handler.rfile.read(length) if length else b""

    def drain(self) -> None:
        """Lit le corps non utilisé pour garder la connexion HTTP/1.1 réutilisable."""
        if not self._consumed:
            length = int(self.handler.headers.get("Content-Length") or 0)
            if 0 < length <= MAX_UPLOAD:
                self.handler.rfile.read(length)
            elif length:
                self.handler.close_connection = True
            self._consumed = True

    @property
    def json(self) -> dict:
        if self._json is None:
            raw = self.raw_body(MAX_JSON)
            try:
                self._json = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                raise ApiError(400, "JSON invalide")
            if not isinstance(self._json, dict):
                raise ApiError(400, "Un objet JSON est attendu")
        return self._json


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "NexaAI"
    app: App

    def log_message(self, fmt, *args):  # journal HTTP silencieux (évite le bruit)
        pass

    # -- utilitaires d'envoi -------------------------------------------------
    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload: Any) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _error(self, status: int, message: str, kind: str = "error") -> None:
        self._json(status, {"error": message, "kind": kind})

    # -- sécurité ---------------------------------------------------------------
    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").lower()
        return host in {f"127.0.0.1:{self.app.port}", f"localhost:{self.app.port}"}

    def _token_ok(self, query: dict) -> bool:
        supplied = self.headers.get("X-NexaAI-Token") or query.get("t", "")
        return secrets.compare_digest(supplied, self.app.token)

    # -- méthodes HTTP -----------------------------------------------------------
    def do_GET(self):
        self._dispatch()

    def do_POST(self):
        self._dispatch()

    def do_PATCH(self):
        self._dispatch()

    def do_DELETE(self):
        self._dispatch()

    def _dispatch(self):
        parts = urlsplit(self.path)
        path = unquote(parts.path)
        query = {k: v[-1] for k, v in parse_qs(parts.query).items()}
        if not self._host_ok():
            self.close_connection = True
            return self._error(403, "Hôte non autorisé")
        if not path.startswith("/api/"):
            if self.command != "GET":
                return self._error(405, "Méthode non autorisée")
            try:
                return self._static(path)
            except (BrokenPipeError, ConnectionResetError):
                return None
            except OSError as exc:
                log.error("Fichier statique illisible %s : %s", path, exc)
                return self._error(500, "Fichier de l'interface manquant ou illisible.")
        if not self._token_ok(query):
            self.close_connection = True
            return self._error(401, "Jeton de session invalide. Rechargez la page.")
        req = Request(self, query)
        try:
            fn, params = self.app.match(self.command, path)
            result = fn(req, **params)
            if isinstance(result, Stream):
                return self._stream(result)
            if isinstance(result, FileResponse):
                if not result.path.is_file():
                    raise ApiError(404, "Fichier introuvable")
                return self._send(200, result.path.read_bytes(), result.mime)
            self._json(200, result)
        except ApiError as exc:
            self._error(exc.status, str(exc), exc.kind)
        except NotFound as exc:
            self._error(404, str(exc.args[0]) if exc.args else "Introuvable", "not_found")
        except PermissionDenied as exc:
            self._error(403, str(exc), "permission")
        except FileNotFoundError as exc:
            self._error(404, str(exc), "not_found")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            log.exception("Erreur interne sur %s %s", self.command, path)
            self._error(500, f"Erreur interne : {exc}", "internal")
        finally:
            try:
                req.drain()
            except OSError:
                self.close_connection = True

    def _stream(self, stream: Stream) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            for event in stream.generator:
                self.wfile.write((json.dumps(event, ensure_ascii=False, default=str) + "\n").encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            if stream.on_close:
                stream.on_close()
        finally:
            close = getattr(stream.generator, "close", None)
            if close:
                close()

    def _static(self, path: str) -> None:
        if path in ("/", "/index.html"):
            html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
            html = html.replace("__NEXAAI_TOKEN__", self.app.token)
            return self._send(200, html.encode("utf-8"), "text/html; charset=utf-8", {
                "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
                                           "style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; "
                                           "connect-src 'self'; frame-src 'self' blob: data:; worker-src 'self' blob:",
                "Referrer-Policy": "no-referrer"})
        if path.startswith("/preview/"):
            entry = self.app.previews.get(path[len("/preview/"):])
            if not entry:
                return self._error(404, "Aperçu expiré")
            html, scripts = entry
            # Page isolée : aucune requête réseau, scripts seulement si l'utilisateur l'a autorisé.
            csp = ("default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; "
                   + ("script-src 'unsafe-inline'; " if scripts else "") + "sandbox" + (" allow-scripts" if scripts else ""))
            return self._send(200, html.encode("utf-8"), "text/html; charset=utf-8", {"Content-Security-Policy": csp})
        if path.startswith("/vision-assets/"):
            base = vision_assets.asset_dir().resolve()
            target = (base / path[len("/vision-assets/"):]).resolve()
        else:
            base = WEB_DIR.resolve()
            target = (base / path.lstrip("/")).resolve()
        if base not in target.parents or not target.is_file():
            return self._error(404, "Introuvable")
        ctype = {".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm",
                 ".woff2": "font/woff2", ".svg": "image/svg+xml", ".task": "application/octet-stream",
                 ".png": "image/png", ".ico": "image/x-icon"}.get(target.suffix, "application/octet-stream")
        self._send(200, target.read_bytes(), ctype)


class NexaServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = sys.platform != "win32"  # sous Windows, SO_REUSEADDR permettrait un double bind


def make_server(app: App, port: int = 8765) -> NexaServer:
    handler = type("BoundHandler", (Handler,), {"app": app})
    last_error: OSError | None = None
    for candidate in [port, *range(port + 1, port + 20), 0]:
        try:
            server = NexaServer(("127.0.0.1", candidate), handler)
            app.port = server.server_address[1]
            return server
        except OSError as exc:
            last_error = exc
    raise last_error or OSError("Aucun port disponible")
