"""Journalisation avec masquage des secrets.

Les clés API ne doivent jamais apparaître dans les journaux : un filtre remplace
toute valeur ressemblant à une clé (sk-..., Bearer ..., api_key=...) par « *** ».
"""
from __future__ import annotations

import logging
import re
from logging.handlers import RotatingFileHandler

from .paths import sub_dir

_SECRET_PATTERNS = [
    re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]+", re.I),
    re.compile(r"\b(sk|gsk|pk|rk|xai|or)-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"((?:api[_-]?key|token|secret|password)[\"']?\s*[:=]\s*[\"']?)[^\s\"',}]+", re.I),
]


def redact(text: str) -> str:
    for pattern in _SECRET_PATTERNS:
        if pattern.groups:
            text = pattern.sub(lambda m: m.group(1) + "***", text)
        else:
            text = pattern.sub("***", text)
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        record.msg = redact(message)
        record.args = ()
        return True


def log_file():
    return sub_dir("logs") / "nexaai.log"


def setup_logging(level: int = logging.INFO) -> None:
    root = logging.getLogger("nexaai")
    if root.handlers:
        return
    root.setLevel(level)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s — %(message)s", "%Y-%m-%d %H:%M:%S")
    file_handler = RotatingFileHandler(log_file(), maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    file_handler.setFormatter(fmt)
    file_handler.addFilter(RedactingFilter())
    console = logging.StreamHandler()
    console.setFormatter(fmt)
    console.addFilter(RedactingFilter())
    root.addHandler(file_handler)
    root.addHandler(console)


def tail(lines: int = 200) -> list[str]:
    path = log_file()
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        return [redact(line.rstrip("\n")) for line in fh.readlines()[-lines:]]
