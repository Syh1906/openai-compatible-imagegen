from __future__ import annotations

from dataclasses import dataclass, field
import os
from typing import Any


DEFAULT_MODEL = "gpt-image-2"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
DEFAULT_POSTPROCESS = {"enabled": False}
DEFAULT_URL_DOWNLOAD = {"proxy_mode": "environment"}
PLACEHOLDER_API_KEYS = {
    "",
    "replace-with-temporary-local-key",
    "replace-with-your-api-key",
    "your-api-key",
    "changeme",
}


class ProviderConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Config:
    base_url: str
    api_key: str
    api_key_source: str
    model: str
    defaults: dict[str, Any]
    capabilities: dict[str, Any]
    postprocess: dict[str, Any]
    user_agent: str = DEFAULT_USER_AGENT
    url_download: dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_URL_DOWNLOAD))


def parse_config(
    raw: dict[str, Any],
    *,
    require_api_key: bool,
    model_profile_id: str,
) -> Config:
    if "providers" in raw or "models" in raw:
        return parse_v2_config(raw, require_api_key=require_api_key, model_profile_id=model_profile_id)
    return parse_legacy_config(raw, require_api_key=require_api_key)


def parse_v2_config(
    raw: dict[str, Any],
    *,
    require_api_key: bool,
    model_profile_id: str,
) -> Config:
    providers = raw.get("providers")
    models = raw.get("models")
    if not isinstance(providers, dict) or not isinstance(models, dict):
        raise ProviderConfigError("V2 config requires providers and models objects")
    profile = models.get(model_profile_id)
    if not isinstance(profile, dict):
        raise ProviderConfigError(f"V2 config missing model profile: {model_profile_id}")
    provider_id = str(profile.get("provider") or model_profile_id.split("/", 1)[0]).strip()
    provider = providers.get(provider_id)
    if not isinstance(provider, dict):
        raise ProviderConfigError(f"V2 config missing provider: {provider_id}")
    if provider.get("protocol") != "openai-compatible":
        raise ProviderConfigError(f"unsupported provider protocol: {provider.get('protocol')}")

    base_url = str(provider.get("base_url") or "").strip().rstrip("/")
    file_api_key = str(provider.get("api_key") or "").strip()
    api_key_env = str(provider.get("api_key_env") or "").strip()
    api_key, api_key_source = resolve_api_key(file_api_key, api_key_env)
    model = str(profile.get("model") or "").strip()
    if not base_url:
        raise ProviderConfigError(f"V2 provider {provider_id} missing base_url")
    if require_api_key and not api_key:
        raise ProviderConfigError(auth_setup_message(file_api_key, api_key_env))
    if not model:
        raise ProviderConfigError(f"V2 model profile {model_profile_id} missing model")
    return Config(
        base_url=base_url,
        api_key=api_key,
        api_key_source=api_key_source,
        model=model,
        defaults=raw.get("defaults") if isinstance(raw.get("defaults"), dict) else {},
        capabilities=profile.get("capabilities") if isinstance(profile.get("capabilities"), dict) else {},
        postprocess=resolve_postprocess_config(raw.get("postprocess")),
        user_agent=resolve_user_agent(provider.get("user_agent")),
        url_download=resolve_url_download_config(provider.get("url_download")),
    )


def parse_legacy_config(raw: dict[str, Any], *, require_api_key: bool) -> Config:
    base_url = str(raw.get("base_url") or "").strip().rstrip("/")
    file_api_key = str(raw.get("api_key") or "").strip()
    api_key_env = str(raw.get("api_key_env") or "").strip()
    api_key, api_key_source = resolve_api_key(file_api_key, api_key_env)
    model = str(raw.get("model") or DEFAULT_MODEL).strip()
    if not base_url:
        raise ProviderConfigError("auth.json missing base_url")
    if require_api_key and not api_key:
        raise ProviderConfigError(auth_setup_message(file_api_key, api_key_env))
    if not model:
        raise ProviderConfigError("auth.json missing model")
    return Config(
        base_url=base_url,
        api_key=api_key,
        api_key_source=api_key_source,
        model=model,
        defaults=raw.get("defaults") if isinstance(raw.get("defaults"), dict) else {},
        capabilities=raw.get("capabilities") if isinstance(raw.get("capabilities"), dict) else {},
        postprocess=resolve_postprocess_config(raw.get("postprocess")),
        user_agent=resolve_user_agent(raw.get("user_agent")),
        url_download=resolve_url_download_config(raw.get("url_download")),
    )


def resolve_postprocess_config(value: Any) -> dict[str, Any]:
    config = dict(DEFAULT_POSTPROCESS)
    if isinstance(value, dict):
        for key in DEFAULT_POSTPROCESS:
            if key in value:
                config[key] = bool(value[key])
    return config


def resolve_url_download_config(value: Any) -> dict[str, Any]:
    config = dict(DEFAULT_URL_DOWNLOAD)
    if value is None:
        return config
    if not isinstance(value, dict):
        raise ProviderConfigError("url_download must be an object")
    proxy_mode = value.get("proxy_mode", "environment")
    if proxy_mode not in {"environment", "direct"}:
        raise ProviderConfigError("url_download.proxy_mode must be environment or direct")
    config["proxy_mode"] = proxy_mode
    return config


def resolve_user_agent(value: Any) -> str:
    user_agent = str(value or DEFAULT_USER_AGENT).strip()
    if any(ord(char) < 32 or ord(char) == 127 for char in user_agent):
        raise ProviderConfigError("auth.json user_agent must not contain control characters")
    return user_agent


def resolve_api_key(file_api_key: str, api_key_env: str) -> tuple[str, str]:
    if file_api_key and not is_placeholder_api_key(file_api_key):
        return file_api_key, "auth.json api_key"
    if api_key_env:
        env_value = os.environ.get(api_key_env, "").strip()
        if env_value:
            return env_value, f"env:{api_key_env}"
    return "", "missing"


def is_placeholder_api_key(value: str) -> bool:
    return value.strip().lower() in PLACEHOLDER_API_KEYS


def auth_setup_message(file_api_key: str, api_key_env: str) -> str:
    if file_api_key and is_placeholder_api_key(file_api_key):
        if api_key_env:
            return (
                f"auth.json api_key is still a placeholder and {api_key_env} is not set.\n"
                "Edit auth.json api_key directly, or set that environment variable."
            )
        return "auth.json api_key is still a placeholder. Edit auth.json api_key or add api_key_env."
    if api_key_env:
        return f"auth.json missing api_key and environment variable {api_key_env} is not set."
    return "auth.json missing api_key. Edit auth.json api_key or add api_key_env."
