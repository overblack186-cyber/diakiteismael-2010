"""Réglages de NexaAI, enregistrés dans settings.json.

Chaque réglage listé ici est réellement utilisé par l'application : aucun
réglage décoratif. Les clés API ne sont PAS stockées ici (voir secrets_store).
"""
from __future__ import annotations

import copy
import json
import threading
from pathlib import Path
from typing import Any

from .paths import data_dir

DEFAULT_SETTINGS: dict[str, Any] = {
    "general": {
        "theme": "dark",                 # dark | light
        "reply_language": "fr",          # langue imposée aux réponses du modèle
        "startup": "last",               # last | new : conversation ouverte au démarrage
        "window": "app",                 # app | browser | none
        "notifications": True,           # notification système quand une réponse se termine en arrière-plan
        "reduced_motion": False,
        "sidebar_collapsed": False,
        "context_panel": False,
    },
    "ai": {
        "mode": "local",                 # local | remote | auto
        "local_model": "",               # "<provider_id>:<model>"
        "remote_model": "",              # "<provider_id>:<model>"
        "auto_allow_remote": False,      # le mode auto peut-il utiliser un fournisseur distant ?
        "temperature": 0.7,
        "num_ctx": 0,                    # 0 = valeur par défaut du modèle
        "system_prompt_extra": "",
        "agent_tools": True,             # proposer des outils aux modèles compatibles
    },
    "providers": {
        "ollama": {"base_url": "http://127.0.0.1:11434", "enabled": True},
        "remote": [],                    # [{id, name, preset, base_url, is_local, enabled, daily_limit}]
    },
    "voice": {
        "stt_lang": "fr-FR",
        "tts_voice": "",
        "tts_rate": 1.0,
        "tts_volume": 1.0,
        "auto_read": False,
        "continuous": False,
        "mic_device": "",
    },
    "vision": {
        "camera_device": "",
        "show_landmarks": True,
        "test_mode": True,
        "confidence": 0.8,
        "stability_ms": 600,
        "cooldown_ms": 1500,
        "max_fps": 15,
    },
    "memory": {"enabled": True, "inject": True},
    "files": {"allowed_folders": []},    # [{path, access: read|read_write}]
    "pc": {"allowed_apps": [], "confirm_actions": True},  # [{id, name, path, args}]
    "shortcuts": {
        "palette": "Ctrl+K",
        "new_chat": "Ctrl+Shift+O",
        "toggle_sidebar": "Ctrl+B",
        "search": "Ctrl+Shift+F",
        "stop": "Escape",
    },
}

ENUMS = {
    ("general", "theme"): {"dark", "light"},
    ("general", "startup"): {"last", "new"},
    ("general", "window"): {"app", "browser", "none"},
    ("general", "reply_language"): {"fr", "en", "es", "de", "auto"},
    ("ai", "mode"): {"local", "remote", "auto"},
}

RANGES = {
    ("ai", "temperature"): (0.0, 2.0),
    ("ai", "num_ctx"): (0, 1_048_576),
    ("voice", "tts_rate"): (0.5, 2.0),
    ("voice", "tts_volume"): (0.0, 1.0),
    ("vision", "confidence"): (0.3, 0.99),
    ("vision", "stability_ms"): (0, 5000),
    ("vision", "cooldown_ms"): (0, 30000),
    ("vision", "max_fps"): (5, 30),
}


class SettingsError(ValueError):
    pass


def _validate(section: str, key: str, value: Any, default: Any) -> Any:
    if isinstance(default, bool):
        if not isinstance(value, bool):
            raise SettingsError(f"{section}.{key} doit être vrai ou faux")
    elif isinstance(default, (int, float)) and not isinstance(default, bool):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise SettingsError(f"{section}.{key} doit être un nombre")
        lo, hi = RANGES.get((section, key), (float("-inf"), float("inf")))
        if not lo <= value <= hi:
            raise SettingsError(f"{section}.{key} doit être compris entre {lo} et {hi}")
        if isinstance(default, int) and not isinstance(default, bool):
            value = int(value)
    elif isinstance(default, str):
        if not isinstance(value, str):
            raise SettingsError(f"{section}.{key} doit être du texte")
        allowed = ENUMS.get((section, key))
        if allowed and value not in allowed:
            raise SettingsError(f"{section}.{key} : valeur « {value} » non autorisée")
    elif isinstance(default, list):
        if not isinstance(value, list):
            raise SettingsError(f"{section}.{key} doit être une liste")
    elif isinstance(default, dict):
        if not isinstance(value, dict):
            raise SettingsError(f"{section}.{key} doit être un objet")
    return value


class Settings:
    """Accès thread-safe aux réglages, avec écriture atomique sur disque."""

    def __init__(self, path: Path | None = None):
        self.path = path or (data_dir() / "settings.json")
        self._lock = threading.RLock()
        self._data = copy.deepcopy(DEFAULT_SETTINGS)
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            stored = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            # Fichier corrompu : on le met de côté au lieu de l'écraser silencieusement.
            self.path.replace(self.path.with_suffix(".json.corrupt"))
            return
        for section, values in stored.items():
            if section not in self._data or not isinstance(values, dict):
                continue
            for key, value in values.items():
                default = DEFAULT_SETTINGS[section].get(key)
                if default is None and key not in DEFAULT_SETTINGS[section]:
                    continue
                try:
                    self._data[section][key] = _validate(section, key, value, default)
                except SettingsError:
                    pass  # on garde la valeur par défaut

    def _save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.path)

    def all(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._data)

    def get(self, section: str, key: str) -> Any:
        with self._lock:
            return copy.deepcopy(self._data[section][key])

    def update(self, patch: dict[str, Any]) -> dict[str, Any]:
        """Applique un patch partiel {section: {clé: valeur}} après validation complète."""
        with self._lock:
            candidate = copy.deepcopy(self._data)
            for section, values in patch.items():
                if section not in DEFAULT_SETTINGS:
                    raise SettingsError(f"Section inconnue : {section}")
                if not isinstance(values, dict):
                    raise SettingsError(f"La section {section} doit être un objet")
                for key, value in values.items():
                    if key not in DEFAULT_SETTINGS[section]:
                        raise SettingsError(f"Réglage inconnu : {section}.{key}")
                    candidate[section][key] = _validate(section, key, value, DEFAULT_SETTINGS[section][key])
            self._data = candidate
            self._save()
            return copy.deepcopy(self._data)

    def reset_section(self, section: str) -> None:
        with self._lock:
            self._data[section] = copy.deepcopy(DEFAULT_SETTINGS[section])
            self._save()
