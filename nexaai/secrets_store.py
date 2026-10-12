"""Stockage des clés API.

* Windows : chiffrement DPAPI (CryptProtectData), lié à la session Windows de
  l'utilisateur. Le fichier copié sur un autre compte est illisible.
* Autres systèmes : fichier JSON avec droits 600 (lecture réservée à l'utilisateur).
* Variables d'environnement : NEXAAI_KEY_<ID_FOURNISSEUR> a priorité si définie.

Les clés ne sont jamais renvoyées à l'interface : seule une empreinte (4 derniers
caractères) est exposée.
"""
from __future__ import annotations

import base64
import json
import os
import sys
import threading
from pathlib import Path

from .paths import data_dir


def _dpapi(data: bytes, protect: bool) -> bytes:
    import ctypes
    from ctypes import wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = DATA_BLOB()
    crypt32 = ctypes.windll.crypt32
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    ok = fn(ctypes.byref(blob_in), None, None, None, None, 0x1, ctypes.byref(blob_out))
    if not ok:
        raise OSError("Échec du chiffrement DPAPI")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


class SecretStore:
    def __init__(self, path: Path | None = None):
        self.path = path or (data_dir() / "secrets.bin")
        self._lock = threading.Lock()
        self.encrypted = sys.platform == "win32"

    def _read(self) -> dict[str, str]:
        if not self.path.exists():
            return {}
        raw = self.path.read_bytes()
        try:
            if self.encrypted:
                raw = _dpapi(base64.b64decode(raw), protect=False)
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _write(self, values: dict[str, str]) -> None:
        raw = json.dumps(values).encode("utf-8")
        if self.encrypted:
            raw = base64.b64encode(_dpapi(raw, protect=True))
        tmp = self.path.with_suffix(".tmp")
        tmp.write_bytes(raw)
        if not self.encrypted:
            os.chmod(tmp, 0o600)
        tmp.replace(self.path)

    @staticmethod
    def env_name(provider_id: str) -> str:
        return "NEXAAI_KEY_" + "".join(c if c.isalnum() else "_" for c in provider_id).upper()

    def get(self, provider_id: str) -> str | None:
        env = os.environ.get(self.env_name(provider_id))
        if env:
            return env
        with self._lock:
            return self._read().get(provider_id)

    def set(self, provider_id: str, key: str) -> None:
        with self._lock:
            values = self._read()
            values[provider_id] = key.strip()
            self._write(values)

    def delete(self, provider_id: str) -> None:
        with self._lock:
            values = self._read()
            values.pop(provider_id, None)
            self._write(values)

    def describe(self, provider_id: str) -> dict:
        key = self.get(provider_id)
        source = "env" if os.environ.get(self.env_name(provider_id)) else ("file" if key else None)
        return {"configured": bool(key), "hint": f"…{key[-4:]}" if key and len(key) > 8 else ("…" if key else ""),
                "source": source, "encrypted": self.encrypted}
