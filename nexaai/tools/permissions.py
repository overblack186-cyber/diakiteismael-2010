"""Permissions d'accès aux fichiers et aux applications.

* Seuls les dossiers déclarés dans Paramètres › Fichiers sont accessibles.
* Chaque dossier est en lecture seule (« read ») ou lecture-écriture (« read_write »).
* Les chemins sont résolus (liens symboliques, « .. ») AVANT la vérification :
  impossible de sortir d'un dossier autorisé avec « ../ ».
* Seules les applications déclarées dans Paramètres › Contrôle du PC peuvent être lancées.
"""
from __future__ import annotations

import os
import re
import time
from pathlib import Path

from ..config import Settings


class PermissionDenied(Exception):
    pass


def _norm(path: str | Path) -> Path:
    return Path(os.path.realpath(os.path.expanduser(str(path))))


def _inside(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


class Permissions:
    def __init__(self, settings: Settings):
        self.settings = settings

    # -- dossiers ---------------------------------------------------------
    def folders(self) -> list[dict]:
        return self.settings.get("files", "allowed_folders")

    def add_folder(self, path: str, access: str = "read") -> list[dict]:
        if access not in ("read", "read_write"):
            raise ValueError("Accès inconnu (read ou read_write)")
        p = _norm(path)
        if not p.is_dir():
            raise ValueError(f"Ce dossier n'existe pas : {path}")
        if p == Path(p.anchor):
            raise ValueError("Autoriser la racine d'un disque entier n'est pas permis : choisissez un dossier précis.")
        folders = [f for f in self.folders() if _norm(f["path"]) != p]
        folders.append({"path": str(p), "access": access})
        self.settings.update({"files": {"allowed_folders": folders}})
        return folders

    def remove_folder(self, path: str) -> list[dict]:
        p = _norm(path)
        folders = [f for f in self.folders() if _norm(f["path"]) != p]
        self.settings.update({"files": {"allowed_folders": folders}})
        return folders

    def check(self, path: str | Path, write: bool = False) -> Path:
        """Renvoie le chemin résolu s'il est autorisé, sinon lève PermissionDenied."""
        p = _norm(path)
        for folder in self.folders():
            root = _norm(folder["path"])
            if _inside(p, root):
                if write and folder.get("access") != "read_write":
                    raise PermissionDenied(f"Le dossier « {root} » est autorisé en lecture seule.")
                return p
        raise PermissionDenied(f"« {path} » n'est pas dans un dossier autorisé. "
                               "Ajoutez le dossier dans Fichiers › Dossiers autorisés.")

    # -- applications -----------------------------------------------------
    def apps(self) -> list[dict]:
        return self.settings.get("pc", "allowed_apps")

    def add_app(self, name: str, path: str, args: str = "") -> list[dict]:
        name = name.strip()
        if not name:
            raise ValueError("Le nom de l'application est obligatoire")
        target = os.path.expanduser(path.strip().strip('"'))
        if not target:
            raise ValueError("Le chemin de l'application est obligatoire")
        if not (os.path.isfile(target) or os.path.isdir(target)):
            raise ValueError(f"Fichier introuvable : {target}")
        if re.search(r"[|&;<>`$]", args):
            raise ValueError("Les arguments ne peuvent pas contenir de caractères de chaînage de commandes.")
        apps = self.apps()
        app_id = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:30] or "app"
        if any(a["id"] == app_id for a in apps):
            app_id += f"-{int(time.time()) % 10000}"
        apps.append({"id": app_id, "name": name[:60], "path": target, "args": args.strip()})
        self.settings.update({"pc": {"allowed_apps": apps}})
        return apps

    def remove_app(self, app_id: str) -> list[dict]:
        apps = [a for a in self.apps() if a["id"] != app_id]
        self.settings.update({"pc": {"allowed_apps": apps}})
        return apps

    def app(self, app_id: str) -> dict:
        for app in self.apps():
            if app["id"] == app_id:
                return app
        raise PermissionDenied(f"L'application « {app_id} » ne figure pas dans la liste des applications autorisées.")
