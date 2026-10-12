"""Couche d'exécution des actions proposées par un modèle (ou par l'utilisateur).

Le modèle ne fait que PROPOSER une action structurée {nom, arguments}.
Cette couche, indépendante du modèle :
  1. vérifie que l'outil existe et que les arguments sont valides ;
  2. contrôle les permissions (dossiers, applications autorisées) ;
  3. demande une confirmation explicite pour les actions sensibles ;
  4. exécute, journalise, et renvoie le résultat RÉEL (succès ou échec).

États d'une action : pending (attend confirmation) → running → done | failed,
ou denied (refusée par l'utilisateur / les permissions), cancelled.
"""
from __future__ import annotations

import datetime as dt
import logging
import threading
from dataclasses import dataclass
from typing import Any, Callable

from ..config import Settings
from ..files import Files, launch_path
from ..storage import Storage
from .permissions import PermissionDenied, Permissions

log = logging.getLogger("nexaai.tools")


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    risk: str                                  # low | medium | high
    handler: Callable[[dict], str]
    summarize: Callable[[dict], str]
    precheck: Callable[[dict], Any] | None = None   # contrôle des permissions AVANT toute confirmation

    def schema(self) -> dict:
        return {"type": "function", "function": {"name": self.name, "description": self.description,
                                                 "parameters": self.parameters}}


class ConfirmationHub:
    """Actions en attente d'une décision de l'utilisateur."""

    def __init__(self):
        self._pending: dict[str, dict] = {}
        self._lock = threading.Lock()

    def open(self, action_id: str) -> threading.Event:
        ev = threading.Event()
        with self._lock:
            self._pending[action_id] = {"event": ev, "approved": None}
        return ev

    def decide(self, action_id: str, approved: bool) -> bool:
        with self._lock:
            entry = self._pending.get(action_id)
            if not entry:
                return False
            entry["approved"] = approved
            entry["event"].set()
            return True

    def result(self, action_id: str) -> bool | None:
        with self._lock:
            entry = self._pending.pop(action_id, None)
        return entry["approved"] if entry else None

    def pending_ids(self) -> list[str]:
        with self._lock:
            return list(self._pending)


class Executor:
    def __init__(self, settings: Settings, storage: Storage, permissions: Permissions, files: Files):
        self.settings = settings
        self.storage = storage
        self.perm = permissions
        self.files = files
        self.hub = ConfirmationHub()
        self.tools: dict[str, Tool] = {}
        self._register_builtin()

    # -- catalogue --------------------------------------------------------
    def register(self, tool: Tool) -> None:
        self.tools[tool.name] = tool

    def schemas(self) -> list[dict]:
        return [t.schema() for t in self.tools.values()]

    def catalog(self) -> list[dict]:
        return [{"name": t.name, "description": t.description, "risk": t.risk,
                 "needs_confirmation": self.needs_confirmation(t)} for t in self.tools.values()]

    def needs_confirmation(self, tool: Tool) -> bool:
        if tool.risk == "high":
            return True       # jamais désactivable
        if tool.risk == "medium":
            return bool(self.settings.get("pc", "confirm_actions"))
        return False

    # -- validation -------------------------------------------------------
    def validate(self, name: str, args: Any) -> tuple[Tool, dict]:
        tool = self.tools.get(name)
        if not tool:
            raise ValueError(f"Outil inconnu : « {name} »")
        if not isinstance(args, dict):
            raise ValueError("Les arguments doivent être un objet")
        props = tool.parameters.get("properties", {})
        clean = {}
        for key in tool.parameters.get("required", []):
            if key not in args or args[key] in (None, ""):
                raise ValueError(f"Argument manquant : {key}")
        for key, spec in props.items():
            if key not in args:
                continue
            value = args[key]
            expected = spec.get("type")
            if expected == "string" and not isinstance(value, str):
                value = str(value)
            elif expected == "integer":
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    raise ValueError(f"L'argument {key} doit être un entier")
            if "enum" in spec and value not in spec["enum"]:
                raise ValueError(f"Valeur non autorisée pour {key} : {value}")
            clean[key] = value
        return tool, clean

    # -- exécution --------------------------------------------------------
    def run(self, name: str, args: Any, origin: str, conversation_id: str | None = None,
            on_update: Callable[[dict], None] | None = None, cancel=None, timeout: float = 300.0) -> dict:
        notify = on_update or (lambda action: None)
        try:
            tool, clean = self.validate(name, args)
        except ValueError as exc:
            action = self.storage.log_action(name or "?", args if isinstance(args, dict) else {"_raw": str(args)},
                                             origin, "failed", "Action invalide", conversation_id)
            action = self.storage.update_action(action["id"], "failed", str(exc))
            notify(action)
            return action
        summary = tool.summarize(clean)
        action = self.storage.log_action(tool.name, clean, origin, "proposed", summary, conversation_id)
        action["risk"] = tool.risk
        if tool.precheck:
            # On ne demande jamais à l'utilisateur de confirmer une action que les permissions refuseront.
            try:
                tool.precheck(clean)
            except PermissionDenied as exc:
                action = {**self.storage.update_action(action["id"], "denied", f"Permission refusée : {exc}"), "risk": tool.risk}
                notify(action)
                return action

        if self.needs_confirmation(tool) and origin != "user":
            event = self.hub.open(action["id"])
            action = {**self.storage.update_action(action["id"], "pending"), "risk": tool.risk}
            notify(action)
            if cancel is not None:
                cancel.on_cancel(lambda: self.hub.decide(action["id"], False))
            event.wait(timeout)
            approved = self.hub.result(action["id"])
            if cancel is not None and cancel.cancelled:
                action = {**self.storage.update_action(action["id"], "cancelled", "Tâche interrompue."), "risk": tool.risk}
                notify(action)
                return action
            if not approved:
                reason = "Refusée par l'utilisateur." if approved is False else "Aucune réponse : action abandonnée."
                action = {**self.storage.update_action(action["id"], "denied", reason), "risk": tool.risk}
                notify(action)
                return action

        action = {**self.storage.update_action(action["id"], "running"), "risk": tool.risk}
        notify(action)
        try:
            result = tool.handler(clean)
            action = {**self.storage.update_action(action["id"], "done", result), "risk": tool.risk}
        except PermissionDenied as exc:
            action = {**self.storage.update_action(action["id"], "denied", f"Permission refusée : {exc}"), "risk": tool.risk}
        except Exception as exc:  # l'échec réel est renvoyé, jamais masqué
            log.warning("Échec de l'outil %s : %s", tool.name, exc)
            action = {**self.storage.update_action(action["id"], "failed", f"Échec : {exc}"), "risk": tool.risk}
        notify(action)
        return action

    # -- outils intégrés --------------------------------------------------
    def _register_builtin(self) -> None:
        f, perm, storage = self.files, self.perm, self.storage

        def list_directory(a):
            data = f.list_dir(a["path"], limit=200)
            lines = [("[dossier] " if e["is_dir"] else "") + e["name"] for e in data["entries"]]
            return f"Contenu de {data['path']} ({len(lines)} éléments) :\n" + "\n".join(lines)

        def read_text_file(a):
            data = f.read_text(a["path"], max_bytes=min(int(a.get("max_chars", 20000)), 60000))
            return data["content"] + ("\n[… fichier tronqué]" if data["truncated"] else "")

        def search_files(a):
            res = f.search(a["folder"], a["query"], limit=40)
            return "\n".join(r["path"] for r in res) or "Aucun fichier correspondant."

        def open_path(a):
            return f"Ouvert avec l'application par défaut : {f.open_with_default_app(a['path'])}"

        def launch_app(a):
            app = perm.app(a["app_id"])
            launch_path(app["path"], app["args"].split() if app.get("args") else None)
            return f"Application lancée : {app['name']}"

        def write_text_file(a):
            res = f.write_text(a["path"], a["content"])
            return f"Fichier écrit : {res['path']} ({res['size']} octets)" + (
                ". Version précédente sauvegardée." if res["backup"] else ". Nouveau fichier.")

        def remember(a):
            if not self.settings.get("memory", "enabled"):
                raise PermissionDenied("La mémoire est désactivée dans les réglages.")
            item = storage.add_memory(a["kind"], a["content"], source="agent")
            return f"Mémorisé ({item['kind']}) : {item['content']}"

        def memory_enabled(a):
            if not self.settings.get("memory", "enabled"):
                raise PermissionDenied("La mémoire est désactivée dans les réglages.")

        def get_datetime(a):
            now = dt.datetime.now()
            days = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
            months = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre",
                      "octobre", "novembre", "décembre"]
            return (f"Nous sommes le {days[now.weekday()]} {now.day} {months[now.month - 1]} {now.year}, "
                    f"il est {now:%H:%M} (heure locale).")

        def list_allowed(a):
            folders = "\n".join(f"- {x['path']} ({'lecture-écriture' if x['access'] == 'read_write' else 'lecture'})"
                                for x in perm.folders()) or "(aucun)"
            apps = "\n".join(f"- {x['id']} : {x['name']}" for x in perm.apps()) or "(aucune)"
            return f"Dossiers autorisés :\n{folders}\nApplications autorisées :\n{apps}"

        s = {"type": "string"}
        self.register(Tool("list_allowed_resources", "Liste les dossiers et applications que l'utilisateur a autorisés.",
                           {"type": "object", "properties": {}}, "low", list_allowed,
                           lambda a: "Consulter les ressources autorisées"))
        self.register(Tool("get_datetime", "Donne la date et l'heure locales.", {"type": "object", "properties": {}},
                           "low", get_datetime, lambda a: "Lire la date et l'heure"))
        self.register(Tool("list_directory", "Liste le contenu d'un dossier autorisé.",
                           {"type": "object", "properties": {"path": {**s, "description": "Chemin absolu"}},
                            "required": ["path"]}, "low", list_directory, lambda a: f"Lister {a['path']}"))
        self.register(Tool("read_text_file", "Lit un fichier texte situé dans un dossier autorisé.",
                           {"type": "object", "properties": {"path": s, "max_chars": {"type": "integer"}},
                            "required": ["path"]}, "low", read_text_file, lambda a: f"Lire {a['path']}"))
        self.register(Tool("search_files", "Cherche des fichiers par nom dans un dossier autorisé.",
                           {"type": "object", "properties": {"folder": s, "query": s}, "required": ["folder", "query"]},
                           "low", search_files, lambda a: f"Chercher « {a['query']} » dans {a['folder']}"))
        self.register(Tool("open_path", "Ouvre un fichier ou dossier autorisé avec l'application par défaut.",
                           {"type": "object", "properties": {"path": s}, "required": ["path"]}, "medium", open_path,
                           lambda a: f"Ouvrir {a['path']}", precheck=lambda a: perm.check(a["path"])))
        self.register(Tool("launch_app", "Lance une application de la liste autorisée (voir list_allowed_resources).",
                           {"type": "object", "properties": {"app_id": s}, "required": ["app_id"]}, "medium",
                           launch_app, lambda a: f"Lancer l'application « {a['app_id']} »",
                           precheck=lambda a: perm.app(a["app_id"])))
        self.register(Tool("write_text_file", "Crée ou remplace un fichier texte dans un dossier autorisé en "
                                              "lecture-écriture. La version précédente est sauvegardée.",
                           {"type": "object", "properties": {"path": s, "content": s}, "required": ["path", "content"]},
                           "high", write_text_file, lambda a: f"Écrire {a['path']} ({len(a['content'])} caractères)",
                           precheck=lambda a: perm.check(a["path"], write=True)))
        self.register(Tool("remember", "Mémorise une information que l'utilisateur a EXPLICITEMENT demandé de retenir.",
                           {"type": "object", "properties": {
                               "kind": {"type": "string", "enum": ["preference", "fact"]}, "content": s},
                            "required": ["kind", "content"]}, "high", remember,
                           lambda a: f"Mémoriser : « {a['content']} »", precheck=memory_enabled))
