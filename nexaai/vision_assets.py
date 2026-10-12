"""Installation locale du moteur de détection des mains (MediaPipe Hand Landmarker).

Les fichiers (~27 Mo) sont téléchargés UNE fois, sur demande explicite de
l'utilisateur, puis servis localement : la détection fonctionne ensuite hors
ligne et aucune image ne quitte l'ordinateur. L'intégrité est vérifiée par
empreinte cryptographique avant installation.
"""
from __future__ import annotations

import base64
import hashlib
import io
import tarfile
import threading
import urllib.request
from pathlib import Path

from .paths import sub_dir

MP_VERSION = "0.10.14"
MP_TARBALL = f"https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-{MP_VERSION}.tgz"
MP_SHA512 = "vOifgZhkndgybdvoRITzRkIueWWSiCKuEUXXK6Q4FaJsFvRJuwgg++vqFUMlL0Uox62U5aEXFhHxlhV7Ja5e3Q=="
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
MODEL_SHA256 = "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1"
NEEDED = {
    "package/vision_bundle.mjs": "vision_bundle.mjs",
    "package/wasm/vision_wasm_internal.js": "wasm/vision_wasm_internal.js",
    "package/wasm/vision_wasm_internal.wasm": "wasm/vision_wasm_internal.wasm",
    "package/wasm/vision_wasm_nosimd_internal.js": "wasm/vision_wasm_nosimd_internal.js",
    "package/wasm/vision_wasm_nosimd_internal.wasm": "wasm/vision_wasm_nosimd_internal.wasm",
}


def asset_dir() -> Path:
    return sub_dir("vision")


def installed() -> bool:
    d = asset_dir()
    return all((d / dest).exists() for dest in NEEDED.values()) and (d / "hand_landmarker.task").exists()


class Installer:
    def __init__(self):
        self.state = {"running": False, "step": "", "progress": 0.0, "error": None}
        self._lock = threading.Lock()

    def status(self) -> dict:
        with self._lock:
            return {**self.state, "installed": installed(), "version": MP_VERSION, "dir": str(asset_dir())}

    def start(self) -> dict:
        with self._lock:
            if self.state["running"]:
                return self.status()
            self.state = {"running": True, "step": "Démarrage", "progress": 0.0, "error": None}
        threading.Thread(target=self._run, daemon=True).start()
        return self.status()

    def _set(self, **kw):
        with self._lock:
            self.state.update(kw)

    def _download(self, url: str, label: str, start: float, span: float) -> bytes:
        req = urllib.request.Request(url, headers={"User-Agent": "NexaAI"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            total = int(resp.headers.get("Content-Length") or 0)
            buf = io.BytesIO()
            while True:
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                buf.write(chunk)
                if total:
                    self._set(step=label, progress=round(start + span * buf.tell() / total, 3))
            return buf.getvalue()

    def _run(self):
        try:
            d = asset_dir()
            data = self._download(MP_TARBALL, "Téléchargement du moteur MediaPipe", 0.0, 0.7)
            digest = base64.b64encode(hashlib.sha512(data).digest()).decode()
            if digest != MP_SHA512:
                raise ValueError("Empreinte du moteur MediaPipe invalide : fichier refusé.")
            self._set(step="Extraction", progress=0.7)
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
                for member, dest in NEEDED.items():
                    src = tar.extractfile(member)
                    if src is None:
                        raise ValueError(f"Fichier manquant dans l'archive : {member}")
                    target = d / dest
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(src.read())
            model = self._download(MODEL_URL, "Téléchargement du modèle de la main", 0.72, 0.27)
            if hashlib.sha256(model).hexdigest() != MODEL_SHA256:
                raise ValueError("Empreinte du modèle de la main invalide : fichier refusé.")
            (d / "hand_landmarker.task").write_bytes(model)
            self._set(running=False, step="Installé", progress=1.0)
        except Exception as exc:
            self._set(running=False, step="Échec", error=f"{exc}")
