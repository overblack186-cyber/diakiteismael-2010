"""Interface commune à tous les fournisseurs de modèles.

Pour ajouter un fournisseur : créer une classe dérivée de Provider qui implémente
health(), list_models() et chat(), puis l'enregistrer dans registry.py.
L'interface graphique ne connaît jamais un fournisseur directement.
"""
from __future__ import annotations

import http.client
import json
import socket
import threading
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Iterator
from urllib.parse import urlsplit

# Capacités connues : text, vision, tools, code, streaming, audio, thinking
CAPABILITIES = ("text", "vision", "tools", "code", "streaming", "audio", "thinking")


@dataclass
class ModelInfo:
    provider_id: str
    name: str
    label: str
    is_local: bool
    capabilities: list[str] = field(default_factory=lambda: ["text", "streaming"])
    capability_source: str = "declared"   # declared (fourni par le fournisseur) | estimated (déduit du nom)
    context_length: int | None = None
    size_bytes: int | None = None
    family: str = ""

    @property
    def ref(self) -> str:
        return f"{self.provider_id}:{self.name}"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["ref"] = self.ref
        return d


class ProviderError(Exception):
    """Erreur compréhensible pour l'utilisateur (message en français)."""

    def __init__(self, message: str, kind: str = "provider", retryable: bool = True):
        super().__init__(message)
        self.kind = kind          # unreachable | auth | not_found | limit | capability | provider | cancelled
        self.retryable = retryable


class Cancelled(ProviderError):
    def __init__(self):
        super().__init__("Génération interrompue.", kind="cancelled", retryable=True)


class CancelToken:
    """Jeton d'annulation partagé entre le thread de génération et l'interface."""

    def __init__(self):
        self._event = threading.Event()
        self._callbacks: list[Callable[[], None]] = []
        self._lock = threading.Lock()

    def cancel(self) -> None:
        with self._lock:
            if self._event.is_set():
                return
            self._event.set()
            callbacks = list(self._callbacks)
        for cb in callbacks:
            try:
                cb()
            except Exception:
                pass

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def on_cancel(self, cb: Callable[[], None]) -> None:
        with self._lock:
            if not self._event.is_set():
                self._callbacks.append(cb)
                return
        cb()

    def wait(self, timeout: float) -> bool:
        return self._event.wait(timeout)


@dataclass
class ChatEvent:
    type: str                      # delta | thinking | tool_calls | done
    text: str = ""
    tool_calls: list[dict] | None = None
    stats: dict | None = None


class Provider:
    id: str = ""
    name: str = ""
    is_local: bool = True

    def health(self) -> dict:
        raise NotImplementedError

    def list_models(self) -> list[ModelInfo]:
        raise NotImplementedError

    def chat(self, model: str, messages: list[dict], options: dict, tools: list[dict] | None,
             cancel: CancelToken) -> Iterator[ChatEvent]:
        raise NotImplementedError


# -- HTTP en streaming, annulable ---------------------------------------------

def http_json(method: str, url: str, body: Any = None, headers: dict | None = None, timeout: float = 10.0) -> Any:
    status, data = http_raw(method, url, body, headers, timeout)
    if status >= 400:
        raise http_error(status, data)
    return json.loads(data or b"null")


def http_raw(method: str, url: str, body: Any = None, headers: dict | None = None,
             timeout: float = 10.0) -> tuple[int, bytes]:
    conn = open_connection(url, timeout)
    try:
        conn.request(method, _path(url), body=None if body is None else json.dumps(body),
                     headers={"Content-Type": "application/json", **(headers or {})})
        resp = conn.getresponse()
        return resp.status, resp.read()
    except (socket.timeout, TimeoutError):
        raise ProviderError("Le fournisseur n'a pas répondu à temps.", kind="unreachable")
    except (ConnectionError, OSError) as exc:
        raise ProviderError(f"Connexion impossible : {exc.__class__.__name__}.", kind="unreachable")
    finally:
        conn.close()


def open_connection(url: str, timeout: float) -> http.client.HTTPConnection:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise ProviderError("Adresse invalide : seules http:// et https:// sont acceptées.", kind="provider", retryable=False)
    cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    return cls(parts.hostname, parts.port, timeout=timeout)


def _path(url: str) -> str:
    parts = urlsplit(url)
    return (parts.path or "/") + (f"?{parts.query}" if parts.query else "")


def http_error(status: int, data: bytes) -> ProviderError:
    detail = ""
    try:
        payload = json.loads(data)
        err = payload.get("error", payload)
        detail = err.get("message") if isinstance(err, dict) else str(err)
    except Exception:
        detail = data[:200].decode("utf-8", "replace")
    if status in (401, 403):
        return ProviderError(f"Clé API refusée par le fournisseur ({status}). {detail}".strip(), kind="auth", retryable=False)
    if status == 404:
        return ProviderError(f"Ressource introuvable chez le fournisseur : {detail}".strip(), kind="not_found", retryable=False)
    if status == 429:
        return ProviderError(f"Limite de requêtes du fournisseur atteinte. {detail}".strip(), kind="limit")
    return ProviderError(f"Erreur du fournisseur ({status}) : {detail}".strip(), kind="provider")


def stream_lines(method: str, url: str, body: Any, headers: dict | None, cancel: CancelToken,
                 connect_timeout: float = 10.0, read_timeout: float = 600.0) -> Iterator[bytes]:
    """Envoie une requête et produit la réponse ligne par ligne.

    L'annulation ferme immédiatement le socket, ce qui débloque la lecture en cours.
    """
    if cancel.cancelled:
        raise Cancelled()
    conn = open_connection(url, connect_timeout)

    def _abort():
        try:
            if conn.sock:
                conn.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        conn.close()

    cancel.on_cancel(_abort)
    try:
        conn.request(method, _path(url), body=json.dumps(body),
                     headers={"Content-Type": "application/json", **(headers or {})})
        if conn.sock:
            conn.sock.settimeout(read_timeout)
        resp = conn.getresponse()
        if resp.status >= 400:
            raise http_error(resp.status, resp.read())
        while True:
            line = resp.readline()
            if not line:
                break
            if cancel.cancelled:
                raise Cancelled()
            line = line.strip()
            if line:
                yield line
    except ProviderError:
        if cancel.cancelled:
            raise Cancelled()
        raise
    except (socket.timeout, TimeoutError):
        raise ProviderError("Le modèle n'a rien renvoyé pendant trop longtemps.", kind="unreachable")
    except (ConnectionError, OSError, http.client.HTTPException, ValueError) as exc:
        if cancel.cancelled:
            raise Cancelled()
        raise ProviderError(f"Connexion interrompue : {exc.__class__.__name__}.", kind="unreachable")
    finally:
        conn.close()
    if cancel.cancelled:
        raise Cancelled()
