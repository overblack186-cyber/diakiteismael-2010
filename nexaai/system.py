"""Informations système, diagnostics et sélecteur de fichiers natif."""
from __future__ import annotations

import importlib.util
import platform
import subprocess
import sys

from . import __version__, vision_assets
from .logs import log_file
from .paths import data_dir

PICKER_SCRIPT = r"""
import sys, tkinter as tk
from tkinter import filedialog
root = tk.Tk(); root.withdraw(); root.attributes('-topmost', True)
kind = sys.argv[1]
path = filedialog.askdirectory() if kind == 'folder' else filedialog.askopenfilename()
sys.stdout.write(path or '')
"""


def tk_available() -> bool:
    return importlib.util.find_spec("tkinter") is not None


def pick_path(kind: str) -> str:
    """Ouvre la boîte de dialogue native (processus séparé, n'affecte pas le serveur)."""
    if kind not in ("folder", "file"):
        raise ValueError("Type de sélection inconnu")
    if not tk_available():
        raise RuntimeError("Le sélecteur natif nécessite Tkinter (inclus dans Python pour Windows). "
                           "Saisissez le chemin manuellement.")
    out = subprocess.run([sys.executable, "-c", PICKER_SCRIPT, kind], capture_output=True, text=True, timeout=600)
    if out.returncode != 0:
        raise RuntimeError("Impossible d'ouvrir le sélecteur de fichiers sur ce système.")
    return out.stdout.strip()


def info(registry, storage, port: int) -> dict:
    oll = registry.ollama()
    return {
        "version": __version__,
        "python": sys.version.split()[0],
        "platform": f"{platform.system()} {platform.release()}",
        "data_dir": str(data_dir()),
        "log_file": str(log_file()),
        "url": f"http://127.0.0.1:{port}",
        "launch_command": "start_nexaai.bat" if sys.platform == "win32" else "python3 -m nexaai",
        "stats": storage.stats(),
        "dependencies": [
            {"name": "Python ≥ 3.10", "ok": sys.version_info >= (3, 10), "detail": sys.version.split()[0]},
            {"name": "Ollama", **({"ok": False, "detail": "désactivé"} if not oll else
                                  {k: v for k, v in oll.health().items() if k in ("ok", "detail")})},
            {"name": "Moteur de vision (MediaPipe)", "ok": vision_assets.installed(),
             "detail": "installé localement" if vision_assets.installed() else
             "non installé — installable depuis Vision et gestes"},
            {"name": "Sélecteur de fichiers natif (Tkinter)", "ok": tk_available(),
             "detail": "disponible" if tk_available() else "indisponible — saisie manuelle des chemins"},
        ],
    }
