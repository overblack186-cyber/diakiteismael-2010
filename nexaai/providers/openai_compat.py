"""Fournisseur générique compatible avec l'API « OpenAI Chat Completions ».

Couvre de nombreux services distants (OpenAI, Mistral, Groq, OpenRouter, ...)
et des serveurs locaux de modèles ouverts (LM Studio, llama.cpp server, vLLM).

Ces services ne déclarent pas toujours les capacités de leurs modèles : elles
sont alors estimées à partir du nom et signalées comme « estimées » à l'interface.
"""
from __future__ import annotations

import json
import re
from typing import Iterator

from .base import CancelToken, ChatEvent, ModelInfo, Provider, ProviderError, http_json, stream_lines

PRESETS = {
    "openai": {"name": "OpenAI", "base_url": "https://api.openai.com/v1", "is_local": False},
    "mistral": {"name": "Mistral AI", "base_url": "https://api.mistral.ai/v1", "is_local": False},
    "groq": {"name": "Groq", "base_url": "https://api.groq.com/openai/v1", "is_local": False},
    "openrouter": {"name": "OpenRouter", "base_url": "https://openrouter.ai/api/v1", "is_local": False},
    "lmstudio": {"name": "LM Studio (local)", "base_url": "http://127.0.0.1:1234/v1", "is_local": True},
    "llamacpp": {"name": "llama.cpp server (local)", "base_url": "http://127.0.0.1:8080/v1", "is_local": True},
    "custom": {"name": "Personnalisé", "base_url": "", "is_local": False},
}

VISION_HINT = re.compile(r"(vision|-vl|vl-|llava|pixtral|gpt-4o|gpt-4\.1|gpt-5|gemini|claude|gemma-3|llama-4|qwen2\.5-vl)", re.I)
CODE_HINT = re.compile(r"(code|coder|codestral|devstral)", re.I)
EXCLUDE_HINT = re.compile(r"(embed|whisper|tts|dall-e|moderation|image|audio|transcribe|rerank)", re.I)


class OpenAICompatProvider(Provider):
    def __init__(self, provider_id: str, name: str, base_url: str, api_key: str | None, is_local: bool):
        self.id = provider_id
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.is_local = is_local

    def _headers(self) -> dict:
        if not self.api_key:
            if self.is_local:
                return {}
            raise ProviderError(f"Aucune clé API n'est configurée pour {self.name}. "
                                f"Ajoutez-la dans Paramètres › Intelligence artificielle.", kind="auth", retryable=False)
        return {"Authorization": f"Bearer {self.api_key}"}

    def health(self) -> dict:
        try:
            self.list_models()
            return {"ok": True, "version": None, "detail": f"{self.name} répond."}
        except ProviderError as exc:
            return {"ok": False, "version": None, "detail": str(exc)}

    def list_models(self) -> list[ModelInfo]:
        data = http_json("GET", f"{self.base_url}/models", headers=self._headers(), timeout=8.0)
        models = []
        for entry in data.get("data", []):
            mid = entry.get("id")
            if not mid or EXCLUDE_HINT.search(mid):
                continue
            caps = ["text", "streaming", "tools"]
            if VISION_HINT.search(mid):
                caps.append("vision")
            if CODE_HINT.search(mid):
                caps.append("code")
            ctx = entry.get("context_length") or entry.get("max_context_length")
            models.append(ModelInfo(provider_id=self.id, name=mid, label=mid, is_local=self.is_local,
                                    capabilities=caps, capability_source="estimated",
                                    context_length=ctx if isinstance(ctx, int) else None))
        return sorted(models, key=lambda m: m.name)

    def chat(self, model: str, messages: list[dict], options: dict, tools: list[dict] | None,
             cancel: CancelToken) -> Iterator[ChatEvent]:
        payload = {"model": model, "messages": [self._convert(m) for m in messages], "stream": True}
        if options.get("temperature") is not None:
            payload["temperature"] = options["temperature"]
        if tools:
            payload["tools"] = tools
        pending: dict[int, dict] = {}
        for line in stream_lines("POST", f"{self.base_url}/chat/completions", payload, self._headers(), cancel):
            if not line.startswith(b"data:"):
                continue
            chunk = line[5:].strip()
            if chunk == b"[DONE]":
                break
            data = json.loads(chunk)
            if "error" in data:
                raise ProviderError(f"{self.name} : {data['error'].get('message', data['error'])}")
            for choice in data.get("choices", []):
                delta = choice.get("delta") or {}
                if delta.get("reasoning_content"):
                    yield ChatEvent("thinking", text=delta["reasoning_content"])
                if delta.get("content"):
                    yield ChatEvent("delta", text=delta["content"])
                for tc in delta.get("tool_calls") or []:
                    slot = pending.setdefault(tc.get("index", 0), {"id": tc.get("id"), "name": "", "args": ""})
                    fn = tc.get("function") or {}
                    slot["name"] += fn.get("name") or ""
                    slot["args"] += fn.get("arguments") or ""
        if pending:
            calls = []
            for slot in pending.values():
                try:
                    args = json.loads(slot["args"] or "{}")
                except json.JSONDecodeError:
                    args = {"_raw": slot["args"]}
                calls.append({"id": slot["id"], "name": slot["name"], "arguments": args})
            yield ChatEvent("tool_calls", tool_calls=calls)
        yield ChatEvent("done", stats={})

    @staticmethod
    def _convert(message: dict) -> dict:
        role = message["role"]
        if role == "tool":
            return {"role": "tool", "tool_call_id": message.get("tool_call_id") or message.get("name", "tool"),
                    "content": message.get("content", "")}
        if message.get("images"):
            parts = [{"type": "text", "text": message.get("content", "")}]
            for img in message["images"]:
                parts.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img}"}})
            return {"role": role, "content": parts}
        out = {"role": role, "content": message.get("content", "")}
        if message.get("tool_calls"):
            out["tool_calls"] = [{"id": c.get("id") or f"call_{i}", "type": "function",
                                  "function": {"name": c["name"], "arguments": json.dumps(c["arguments"])}}
                                 for i, c in enumerate(message["tool_calls"])]
        return out
