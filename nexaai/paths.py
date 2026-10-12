"""Emplacements des données de NexaAI.

Toutes les données utilisateur (base SQLite, réglages, clés chiffrées, journaux,
pièces jointes, modèles de vision) vivent dans un seul dossier :

* Windows : %APPDATA%\\NexaAI
* autres systèmes : ~/.nexaai
* ou le dossier indiqué par la variable d'environnement NEXAAI_HOME.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = PACKAGE_DIR.parent
WEB_DIR = PROJECT_DIR / "web"


def data_dir() -> Path:
    override = os.environ.get("NEXAAI_HOME")
    if override:
        base = Path(override)
    elif sys.platform == "win32" and os.environ.get("APPDATA"):
        base = Path(os.environ["APPDATA"]) / "NexaAI"
    else:
        base = Path.home() / ".nexaai"
    base.mkdir(parents=True, exist_ok=True)
    return base


def sub_dir(name: str) -> Path:
    path = data_dir() / name
    path.mkdir(parents=True, exist_ok=True)
    return path
