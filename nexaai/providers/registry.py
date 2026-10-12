"""Registre des fournisseurs et sélection du modèle (modes local, distant, auto).

Règles de transparence :
* le mode local n'utilise QUE des modèles exécutés sur cet ordinateur ;
* le mode distant n'utilise que le fournisseur choisi, avec clé configurée ;
* le mode automatique privilégie le local et ne bascule vers un service distant
  que si l'utilisateur l'a explicitement autorisé (ai.auto_allow_remote) ;
* le modèle réellement utilisé et la raison du choix sont toujours renvoyés.
"""
from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field

from ..config import Settings
from ..secrets_store import SecretStore
from .base import ModelInfo, Provider, ProviderError
from .ollama import OllamaProvider
from .openai_compat import PRESETS, OpenAICompatProvider

CODE_REQUEST = re.compile(r"```|\b(code|python|javascript|typescript|java|c\+\+|rust|html|css|sql|bug|fonction|"
                          r"function|compile|erreur de syntaxe|stack ?trace|regex|script|débogu)", re.I)


@dataclass
class Resolution:
    provider: Provider
    model: ModelInfo
    reason: str
    notes: list[str] = field(default_factory=list)
    fallbacks: list[tuple[Provider, ModelInfo]] = field(default_factory=list)

    @property
    def is_remote(self) -> bool:
        return not self.model.is_local

    def describe(self) -> dict:
        return {"provider_id": self.provider.id, "provider_name": self.provider.name, "model": self.model.name,
                "is_local": self.model.is_local, "reason": self.reason, "notes": self.notes,
                "capabilities": self.model.capabilities}


class Registry:
    def __init__(self, settings: Settings, secrets: SecretStore, storage=None):
        self.settings = settings
        self.secrets = secrets
        self.storage = storage
        self._ollama: OllamaProvider | None = None
        self._remote_cache: dict[str, tuple[float, list[ModelInfo]]] = {}
        self._lock = threading.Lock()

    # -- fournisseurs -----------------------------------------------------
    def ollama(self) -> OllamaProvider | None:
        cfg = self.settings.get("providers", "ollama")
        if not cfg.get("enabled", True):
            return None
        with self._lock:
            if not self._ollama or self._ollama.base_url != cfg["base_url"].rstrip("/"):
                self._ollama = OllamaProvider(cfg["base_url"])
            return self._ollama

    def remote_configs(self) -> list[dict]:
        return self.settings.get("providers", "remote")

    def provider(self, provider_id: str) -> Provider:
        if provider_id == "ollama":
            prov = self.ollama()
            if not prov:
                raise ProviderError("Ollama est désactivé dans les réglages.", kind="provider", retryable=False)
            return prov
        for cfg in self.remote_configs():
            if cfg["id"] == provider_id:
                if not cfg.get("enabled", True):
                    raise ProviderError(f"Le fournisseur {cfg['name']} est désactivé.", retryable=False)
                return OpenAICompatProvider(cfg["id"], cfg["name"], cfg["base_url"], self.secrets.get(cfg["id"]),
                                            bool(cfg.get("is_local")))
        raise ProviderError(f"Fournisseur inconnu : {provider_id}", kind="not_found", retryable=False)

    def all_providers(self) -> list[Provider]:
        out: list[Provider] = []
        if self.ollama():
            out.append(self.ollama())
        for cfg in self.remote_configs():
            if cfg.get("enabled", True):
                out.append(self.provider(cfg["id"]))
        return out

    # -- modèles ----------------------------------------------------------
    def models_for(self, provider: Provider, refresh: bool = False) -> list[ModelInfo]:
        if isinstance(provider, OllamaProvider):
            if refresh:
                provider.invalidate()
            return provider.list_models()
        cached = self._remote_cache.get(provider.id)
        if cached and not refresh and time.time() - cached[0] < 120:
            return cached[1]
        models = provider.list_models()
        self._remote_cache[provider.id] = (time.time(), models)
        return models

    def catalog(self, refresh: bool = False) -> dict:
        """Liste des modèles réellement accessibles, fournisseur par fournisseur."""
        providers = []
        for prov in self.all_providers():
            entry = {"id": prov.id, "name": prov.name, "is_local": prov.is_local, "ok": True, "error": None,
                     "models": []}
            if not prov.is_local:
                entry["key"] = self.secrets.describe(prov.id)
            try:
                entry["models"] = [m.to_dict() for m in self.models_for(prov, refresh)]
            except ProviderError as exc:
                entry["ok"], entry["error"] = False, str(exc)
            providers.append(entry)
        return {"providers": providers}

    def _available(self, local: bool | None) -> list[tuple[Provider, ModelInfo]]:
        out = []
        for prov in self.all_providers():
            if local is not None and prov.is_local != local:
                continue
            try:
                out.extend((prov, m) for m in self.models_for(prov))
            except ProviderError:
                continue
        return out

    def _find(self, ref: str, pool: list[tuple[Provider, ModelInfo]]):
        for prov, model in pool:
            if model.ref == ref:
                return prov, model
        return None

    # -- sélection --------------------------------------------------------
    def check_limit(self, provider: Provider) -> None:
        if provider.is_local or not self.storage:
            return
        for cfg in self.remote_configs():
            if cfg["id"] == provider.id and cfg.get("daily_limit"):
                used = self.storage.usage_today(provider.id)
                if used >= int(cfg["daily_limit"]):
                    raise ProviderError(f"Limite quotidienne fixée pour {provider.name} atteinte ({used} requêtes). "
                                        f"Modifiable dans Paramètres › Intelligence artificielle.", kind="limit",
                                        retryable=False)

    def resolve(self, model_pref: str = "", need: set[str] | None = None, text: str = "") -> Resolution:
        need = set(need or ())
        ai = self.settings.get("ai", "mode")
        allow_remote_auto = self.settings.get("ai", "auto_allow_remote")
        notes: list[str] = []

        if ai == "local":
            pool = self._available(local=True)
            if not pool:
                health = self.ollama().health() if self.ollama() else {"ok": False, "detail": "Ollama est désactivé."}
                if not health["ok"]:
                    raise ProviderError(health["detail"], kind="unreachable")
                raise ProviderError("Aucun modèle local n'est installé. Installez-en un depuis Paramètres › "
                                    "Intelligence artificielle (par exemple « llama3.2 »).", kind="not_found",
                                    retryable=False)
            default = model_pref or self.settings.get("ai", "local_model")
            return self._pick(pool, default, need, notes, "Mode local", fallbacks=[])

        if ai == "remote":
            pool = self._available(local=False)
            default = model_pref or self.settings.get("ai", "remote_model")
            if not default and not pool:
                raise ProviderError("Aucun fournisseur distant n'est configuré ou joignable. Ajoutez-en un dans "
                                    "Paramètres › Intelligence artificielle.", kind="not_found", retryable=False)
            if default and not self._find(default, pool):
                pid = default.split(":", 1)[0]
                prov = self.provider(pid)  # lève une erreur claire si inconnu/désactivé
                prov.list_models()          # lève l'erreur réelle (clé manquante, réseau...)
                raise ProviderError(f"Le modèle « {default.split(':', 1)[1]} » n'est pas proposé par {prov.name}.",
                                    kind="not_found", retryable=False)
            res = self._pick(pool, default, need, notes, "Mode distant", fallbacks=[])
            self.check_limit(res.provider)
            return res

        # mode automatique
        local_pool = self._available(local=True)
        remote_pool = self._available(local=False) if allow_remote_auto else []
        if model_pref:
            found = self._find(model_pref, local_pool + remote_pool)
            if found and need <= set(found[1].capabilities):
                return Resolution(found[0], found[1], "Modèle choisi pour cette conversation", notes)
        if local_pool:
            preferred = self.settings.get("ai", "local_model")
            if "vision" not in need and CODE_REQUEST.search(text or ""):
                coder = next((m for p, m in local_pool if "code" in m.capabilities), None)
                if coder:
                    preferred = coder.ref
                    notes.append(f"Demande de programmation : modèle spécialisé « {coder.name} » choisi.")
            try:
                res = self._pick(local_pool, preferred, need, notes, "Mode automatique (local privilégié)",
                                 fallbacks=remote_pool)
                return res
            except ProviderError:
                if not remote_pool:
                    raise
        if remote_pool:
            notes.append("Aucun modèle local adapté n'est disponible : utilisation d'un fournisseur distant, "
                         "autorisée dans vos réglages.")
            res = self._pick(remote_pool, self.settings.get("ai", "remote_model"), need, notes,
                             "Mode automatique (bascule distante autorisée)", fallbacks=[])
            self.check_limit(res.provider)
            return res
        health = self.ollama().health() if self.ollama() else {"ok": False, "detail": "Ollama est désactivé."}
        detail = health["detail"] if not health["ok"] else "Aucun modèle local n'est installé."
        raise ProviderError(detail + " Le mode automatique n'est pas autorisé à utiliser un service distant "
                                     "(réglable dans Paramètres › Intelligence artificielle).", kind="unreachable")

    def _pick(self, pool, preferred: str, need: set[str], notes: list[str], reason: str,
              fallbacks: list) -> Resolution:
        chosen = self._find(preferred, pool) if preferred else None
        if preferred and not chosen:
            notes.append(f"Le modèle « {preferred.split(':', 1)[-1]} » n'est pas disponible ; un autre modèle a été choisi.")
        if not chosen:
            chosen = pool[0]
        prov, model = chosen
        missing = need - set(model.capabilities)
        if missing:
            alt = next(((p, m) for p, m in pool if need <= set(m.capabilities)), None)
            if not alt:
                labels = {"vision": "l'analyse d'images", "tools": "les outils"}
                what = ", ".join(labels.get(c, c) for c in sorted(missing))
                raise ProviderError(f"Aucun modèle disponible dans ce mode ne prend en charge {what}. "
                                    f"Le modèle « {model.name} » ne le permet pas. "
                                    + ("Installez par exemple « llava » ou « gemma3 » avec Ollama."
                                       if "vision" in missing else ""), kind="capability", retryable=False)
            notes.append(f"« {model.name} » ne prend pas en charge {', '.join(sorted(missing))} : "
                         f"« {alt[1].name} » est utilisé pour ce message.")
            prov, model = alt
        fb = [(p, m) for p, m in fallbacks if need <= set(m.capabilities)][:1]
        return Resolution(prov, model, reason, notes, fallbacks=fb)


def make_remote_config(preset: str, name: str = "", base_url: str = "", daily_limit: int = 0,
                       is_local: bool | None = None) -> dict:
    """Configuration d'un fournisseur. is_local : le serveur tourne-t-il sur cet ordinateur ?
    (déduit du type, ou de l'adresse pour « Personnalisé », sauf indication explicite)."""
    if preset not in PRESETS:
        raise ValueError("Modèle de fournisseur inconnu")
    p = PRESETS[preset]
    base_url = (base_url or p["base_url"]).strip()
    if not base_url.startswith(("http://", "https://")):
        raise ValueError("L'adresse du fournisseur doit commencer par http:// ou https://")
    slug = re.sub(r"[^a-z0-9]+", "-", (name or p["name"]).lower()).strip("-")[:24] or preset
    if is_local is None:
        is_local = p["is_local"] if preset != "custom" else base_url.startswith(("http://127.", "http://localhost"))
    return {"id": f"{slug}-{int(time.time() * 1000) % 10_000_000}", "name": (name or p["name"]).strip(), "preset": preset,
            "base_url": base_url, "is_local": bool(is_local), "enabled": True, "daily_limit": int(daily_limit or 0)}
