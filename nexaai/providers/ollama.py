"""Fournisseur Ollama (modèles locaux).

API utilisée : /api/version, /api/tags, /api/show, /api/chat, /api/pull.
Les capacités (vision, outils, raisonnement) sont lues dans la réponse de
/api/show : ce sont les capacités déclarées par Ollama pour le modèle installé.
"""
from __future__ import annotations

import json
import re
import threading
import time
from typing import Iterator

from .base import (CancelToken, ChatEvent, ModelInfo, Provider, ProviderError, http_json, stream_lines)

CODE_HINT = re.compile(r"(code|coder|starcoder|codestral|devstral|deepseek-coder|qwen.*coder)", re.I)


class OllamaProvider(Provider):
    id = "ollama"
    name = "Ollama"
    is_local = True

    def __init__(self, base_url: str = "http://127.0.0.1:11434"):
        self.base_url = base_url.rstrip("/")
        self._cache: tuple[float, list[ModelInfo]] | None = None
        self._lock = threading.Lock()

    def health(self) -> dict:
        try:
            info = http_json("GET", f"{self.base_url}/api/version", timeout=2.0)
            return {"ok": True, "version": info.get("version", "?"), "detail": "Ollama répond."}
        except ProviderError as exc:
            return {"ok": False, "version": None,
                    "detail": f"Ollama ne répond pas à {self.base_url}. Lancez l'application Ollama "
                              f"ou la commande « ollama serve ». ({exc})"}

    def invalidate(self) -> None:
        with self._lock:
            self._cache = None

    def list_models(self, max_age: float = 30.0) -> list[ModelInfo]:
        with self._lock:
            if self._cache and time.time() - self._cache[0] < max_age:
                return list(self._cache[1])
        tags = http_json("GET", f"{self.base_url}/api/tags", timeout=4.0)
        models: list[ModelInfo] = []
        for entry in tags.get("models", []):
            name = entry.get("model") or entry.get("name")
            caps, ctx, family = ["text", "streaming"], None, entry.get("details", {}).get("family", "")
            try:
                show = http_json("POST", f"{self.base_url}/api/show", {"model": name}, timeout=6.0)
                declared = show.get("capabilities")
                if declared is not None:
                    if "completion" not in declared:
                        continue  # modèle d'embeddings : inutilisable pour la conversation
                    caps = ["text", "streaming"]
                    caps += [c for c in ("vision", "tools", "thinking") if c in declared]
                for key, value in (show.get("model_info") or {}).items():
                    if key.endswith(".context_length") and isinstance(value, int):
                        ctx = value
            except ProviderError:
                pass
            if CODE_HINT.search(name):
                caps.append("code")
            models.append(ModelInfo(provider_id=self.id, name=name, label=name, is_local=True,
                                    capabilities=caps, capability_source="declared", context_length=ctx,
                                    size_bytes=entry.get("size"), family=family))
        with self._lock:
            self._cache = (time.time(), models)
        return list(models)

    def chat(self, model: str, messages: list[dict], options: dict, tools: list[dict] | None,
             cancel: CancelToken) -> Iterator[ChatEvent]:
        payload = {"model": model, "messages": [self._convert(m) for m in messages], "stream": True}
        opts = {}
        if options.get("temperature") is not None:
            opts["temperature"] = options["temperature"]
        if options.get("num_ctx"):
            opts["num_ctx"] = options["num_ctx"]
        if opts:
            payload["options"] = opts
        if tools:
            payload["tools"] = tools
        try:
            for line in stream_lines("POST", f"{self.base_url}/api/chat", payload, None, cancel):
                data = json.loads(line)
                if "error" in data:
                    raise self._error(data["error"], model)
                msg = data.get("message") or {}
                if msg.get("thinking"):
                    yield ChatEvent("thinking", text=msg["thinking"])
                if msg.get("content"):
                    yield ChatEvent("delta", text=msg["content"])
                if msg.get("tool_calls"):
                    calls = []
                    for call in msg["tool_calls"]:
                        fn = call.get("function", {})
                        args = fn.get("arguments", {})
                        if isinstance(args, str):
                            try:
                                args = json.loads(args)
                            except json.JSONDecodeError:
                                args = {"_raw": args}
                        calls.append({"name": fn.get("name", ""), "arguments": args})
                    yield ChatEvent("tool_calls", tool_calls=calls)
                if data.get("done"):
                    yield ChatEvent("done", stats=self._stats(data))
                    return
        except ProviderError as exc:
            if exc.kind == "not_found":
                raise ProviderError(f"Le modèle « {model} » n'est pas installé dans Ollama. "
                                    f"Installez-le avec « ollama pull {model} » ou choisissez un autre modèle.",
                                    kind="not_found", retryable=False)
            if exc.kind == "unreachable":
                raise ProviderError(f"Ollama est injoignable ({self.base_url}). Vérifiez qu'il est lancé.",
                                    kind="unreachable")
            raise

    def pull(self, model: str, cancel: CancelToken) -> Iterator[dict]:
        for line in stream_lines("POST", f"{self.base_url}/api/pull", {"model": model, "stream": True}, None, cancel,
                                 read_timeout=120):
            data = json.loads(line)
            if "error" in data:
                raise ProviderError(f"Téléchargement impossible : {data['error']}", kind="provider", retryable=False)
            yield {"status": data.get("status", ""), "total": data.get("total"), "completed": data.get("completed")}
        self.invalidate()

    @staticmethod
    def _convert(message: dict) -> dict:
        out = {"role": message["role"], "content": message.get("content", "")}
        if message.get("images"):
            out["images"] = message["images"]
        if message.get("tool_calls"):
            out["tool_calls"] = [{"function": {"name": c["name"], "arguments": c["arguments"]}}
                                 for c in message["tool_calls"]]
        if message["role"] == "tool" and message.get("name"):
            out["tool_name"] = message["name"]
        return out

    @staticmethod
    def _error(text: str, model: str) -> ProviderError:
        if "not found" in text:
            return ProviderError(f"Le modèle « {model} » n'est pas installé dans Ollama.", kind="not_found", retryable=False)
        if "does not support tools" in text:
            return ProviderError("Ce modèle ne prend pas en charge les outils.", kind="capability", retryable=False)
        return ProviderError(f"Ollama : {text}", kind="provider")

    @staticmethod
    def _stats(data: dict) -> dict:
        eval_count = data.get("eval_count") or 0
        eval_ns = data.get("eval_duration") or 0
        return {
            "output_tokens": eval_count,
            "input_tokens": data.get("prompt_eval_count"),
            "tokens_per_second": round(eval_count / (eval_ns / 1e9), 1) if eval_ns else None,
            "load_seconds": round((data.get("load_duration") or 0) / 1e9, 2),
            "total_seconds": round((data.get("total_duration") or 0) / 1e9, 2),
        }
