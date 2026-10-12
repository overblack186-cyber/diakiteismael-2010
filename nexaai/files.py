"""Accès aux fichiers, toujours filtré par les permissions.

Formats lisibles par NexaAI sans dépendance : texte et code (UTF-8), images
(PNG, JPEG, GIF, WebP — transmises aux modèles « vision »). Les autres formats
(PDF, DOCX, ...) sont signalés comme non pris en charge plutôt que mal lus.
"""
from __future__ import annotations

import mimetypes
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from .paths import sub_dir
from .tools.permissions import Permissions

TEXT_EXT = {".txt", ".md", ".markdown", ".py", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".json", ".html", ".htm",
            ".css", ".scss", ".csv", ".tsv", ".xml", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".log", ".java",
            ".c", ".h", ".cpp", ".hpp", ".cs", ".go", ".rs", ".rb", ".php", ".sh", ".bat", ".ps1", ".sql", ".kt",
            ".swift", ".lua", ".r", ".tex", ".vue", ".svelte", ".env.example", ".gitignore", ".dart"}
IMAGE_EXT = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
             ".webp": "image/webp"}
MAX_TEXT_BYTES = 400_000


def kind_of(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in IMAGE_EXT:
        return "image"
    if ext in TEXT_EXT or path.name.lower() in {"readme", "license", "makefile", "dockerfile"}:
        return "text"
    return "unsupported"


def describe(path: Path) -> dict:
    st = path.stat()
    is_dir = path.is_dir()
    return {"name": path.name or str(path), "path": str(path), "is_dir": is_dir,
            "size": None if is_dir else st.st_size, "modified": st.st_mtime,
            "kind": "folder" if is_dir else kind_of(path),
            "mime": None if is_dir else (mimetypes.guess_type(path.name)[0] or "application/octet-stream")}


class Files:
    def __init__(self, permissions: Permissions):
        self.perm = permissions

    def list_dir(self, path: str, limit: int = 500) -> dict:
        p = self.perm.check(path)
        if not p.is_dir():
            raise ValueError("Ce chemin n'est pas un dossier")
        entries = []
        with os.scandir(p) as it:
            for entry in it:
                if entry.name.startswith(".") and entry.name not in (".gitignore",):
                    continue
                try:
                    entries.append(describe(Path(entry.path)))
                except OSError:
                    continue
        entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
        return {"path": str(p), "entries": entries[:limit], "truncated": len(entries) > limit}

    def info(self, path: str) -> dict:
        p = self.perm.check(path)
        if not p.exists():
            raise FileNotFoundError(f"Introuvable : {path}")
        info = describe(p)
        info["writable"] = self._writable(p)
        return info

    def _writable(self, p: Path) -> bool:
        try:
            self.perm.check(p, write=True)
            return True
        except Exception:
            return False

    def read_text(self, path: str, max_bytes: int = MAX_TEXT_BYTES) -> dict:
        p = self.perm.check(path)
        if not p.is_file():
            raise FileNotFoundError(f"Fichier introuvable : {path}")
        if kind_of(p) != "text":
            raise ValueError(f"Le format « {p.suffix or p.name} » n'est pas lisible comme texte par NexaAI.")
        raw = p.read_bytes()[:max_bytes + 1]
        truncated = len(raw) > max_bytes
        try:
            text = raw[:max_bytes].decode("utf-8")
        except UnicodeDecodeError:
            text = raw[:max_bytes].decode("latin-1")
        return {"path": str(p), "content": text, "truncated": truncated, "writable": self._writable(p)}

    def search(self, folder: str, query: str, limit: int = 50) -> list[dict]:
        root = self.perm.check(folder)
        q = query.lower().strip()
        out = []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in ("node_modules", "__pycache__")]
            for name in filenames:
                if q in name.lower():
                    out.append(describe(Path(dirpath) / name))
                    if len(out) >= limit:
                        return out
        return out

    def write_text(self, path: str, content: str) -> dict:
        """Écrit un fichier texte après avoir sauvegardé la version précédente."""
        p = self.perm.check(path, write=True)
        if p.exists() and kind_of(p) != "text":
            raise ValueError("Seuls les fichiers texte peuvent être modifiés par NexaAI.")
        backup = None
        if p.exists():
            backup = self.backup(p)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".nexaai-tmp")
        tmp.write_text(content, encoding="utf-8", newline="")
        tmp.replace(p)
        return {"path": str(p), "backup": backup, "size": p.stat().st_size}

    # -- sauvegardes --------------------------------------------------------
    @staticmethod
    def _backup_dir(p: Path) -> Path:
        key = "".join(c if c.isalnum() else "_" for c in str(p))[-150:]
        d = sub_dir("backups") / key
        d.mkdir(parents=True, exist_ok=True)
        return d

    def backup(self, p: Path) -> str:
        dest = self._backup_dir(p) / f"{time.strftime('%Y%m%d-%H%M%S')}-{int(time.time() * 1000) % 1000:03d}{p.suffix}"
        shutil.copy2(p, dest)
        return str(dest)

    def list_backups(self, path: str) -> list[dict]:
        p = self.perm.check(path)
        d = self._backup_dir(p)
        items = sorted(d.iterdir(), reverse=True)
        return [{"id": b.name, "created": b.stat().st_mtime, "size": b.stat().st_size} for b in items]

    def restore_backup(self, path: str, backup_id: str) -> dict:
        p = self.perm.check(path, write=True)
        d = self._backup_dir(p)
        src = (d / backup_id).resolve()
        if src.parent != d.resolve() or not src.is_file():
            raise FileNotFoundError("Sauvegarde introuvable")
        current_backup = self.backup(p) if p.exists() else None
        shutil.copy2(src, p)
        return {"path": str(p), "restored": backup_id, "backup_of_current": current_backup}

    # -- ouverture ----------------------------------------------------------
    def open_with_default_app(self, path: str) -> str:
        p = self.perm.check(path)
        if not p.exists():
            raise FileNotFoundError(f"Introuvable : {path}")
        launch_path(str(p))
        return str(p)


def launch_path(target: str, args: list[str] | None = None) -> None:
    """Ouvre un fichier/dossier avec l'application associée, ou lance un exécutable.

    Aucun shell n'est utilisé : les arguments ne peuvent pas être interprétés comme commandes.
    """
    if sys.platform == "win32":
        if args:
            subprocess.Popen([target, *args], close_fds=True)
        else:
            os.startfile(target)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", target, *([] if not args else ["--args", *args])])
    else:
        if args or os.access(target, os.X_OK) and not os.path.isdir(target):
            subprocess.Popen([target, *(args or [])], start_new_session=True)
        else:
            subprocess.Popen(["xdg-open", target], start_new_session=True)
