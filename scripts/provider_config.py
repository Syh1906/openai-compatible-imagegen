from __future__ import annotations

from dataclasses import dataclass, field
import os
from typing import Any
import urllib.parse
import re

from image_transparency import TransparencyPolicy, resolve_policy as resolve_transparency_policy


DEFAULT_MODEL = "gpt-image-2"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
DEFAULT_POSTPROCESS = {"enabled": False}
DEFAULT_URL_DOWNLOAD = {"proxy_mode": "environment"}
MODEL_CAPABILITY_KEYS = (
    "generate",
    "edit",
    "mask",
    "multi_reference",
)
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
class EffectiveImageConfig:
    base_url: str
    api_key: str
    api_key_source: str
    model: str
    defaults: dict[str, Any]
    postprocess: dict[str, Any]
    provider_id: str = "primary"
    capabilities: dict[str, Any] = field(default_factory=dict)
    transparency: TransparencyPolicy = field(default_factory=TransparencyPolicy)
    user_agent: str = DEFAULT_USER_AGENT
    url_download: dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_URL_DOWNLOAD))


Config = EffectiveImageConfig


def parse_standalone_config(
    raw: dict[str, Any],
    *,
    require_api_key: bool,
    model_profile_id: str = "primary/gpt-image-2",
) -> EffectiveImageConfig:
    del model_profile_id
    return _parse_standalone_config(raw, require_api_key=require_api_key)


def parse_plugin_config(
    raw: dict[str, Any],
    *,
    require_api_key: bool,
    model_profile_id: str,
) -> EffectiveImageConfig:
    if raw.get("config_version") != 1:
        raise ProviderConfigError("image config requires config_version 1")
    if raw.get("active_profile") != model_profile_id:
        raise ProviderConfigError(f"image config active_profile must be {model_profile_id}")
    providers = raw.get("providers")
    models = raw.get("models")
    if not isinstance(providers, dict) or not isinstance(models, dict):
        raise ProviderConfigError("image config requires providers and models objects")
    profile = models.get(model_profile_id)
    if not isinstance(profile, dict):
        raise ProviderConfigError(f"image config missing model profile: {model_profile_id}")
    provider_value = profile.get("provider")
    if not isinstance(provider_value, str) or not provider_value.strip():
        raise ProviderConfigError(f"image config model profile {model_profile_id} missing provider")
    provider_id = provider_value.strip()
    provider = providers.get(provider_id)
    if not isinstance(provider, dict):
        raise ProviderConfigError(f"image config missing provider: {provider_id}")
    if provider.get("protocol") != "openai-compatible":
        raise ProviderConfigError(f"unsupported provider protocol: {provider.get('protocol')}")

    base_url = str(provider.get("base_url") or "").strip().rstrip("/")
    file_api_key = str(provider.get("api_key") or "").strip()
    api_key_env = str(provider.get("api_key_env") or "").strip()
    api_key, api_key_source = resolve_api_key(file_api_key, api_key_env, source_label="user config")
    model = str(profile.get("model") or "").strip()
    if not is_valid_base_url(base_url):
        raise ProviderConfigError(f"image config provider {provider_id} has invalid base_url")
    if require_api_key and not api_key:
        raise ProviderConfigError(auth_setup_message(file_api_key, api_key_env, config_label="user config"))
    if not model:
        raise ProviderConfigError(f"image config model profile {model_profile_id} missing model")
    try:
        transparency = resolve_transparency_policy(raw.get("transparency"))
    except ValueError as exc:
        raise ProviderConfigError(str(exc)) from exc
    return EffectiveImageConfig(
        base_url=base_url,
        api_key=api_key,
        api_key_source=api_key_source,
        model=model,
        defaults=raw.get("defaults") if isinstance(raw.get("defaults"), dict) else {},
        provider_id=provider_id,
        capabilities=normalize_model_capabilities(profile.get("capabilities")),
        postprocess=resolve_postprocess_config(raw.get("postprocess")),
        transparency=transparency,
        user_agent=resolve_user_agent(provider.get("user_agent"), config_label="user config"),
        url_download=resolve_url_download_config(provider.get("url_download")),
    )


def _parse_standalone_config(raw: dict[str, Any], *, require_api_key: bool) -> EffectiveImageConfig:
    base_url = str(raw.get("base_url") or "").strip().rstrip("/")
    file_api_key = str(raw.get("api_key") or "").strip()
    api_key_env = str(raw.get("api_key_env") or "").strip()
    api_key, api_key_source = resolve_api_key(file_api_key, api_key_env, source_label="auth.json")
    model = str(raw.get("model") or DEFAULT_MODEL).strip()
    if not base_url:
        raise ProviderConfigError("auth.json missing base_url")
    if require_api_key and not api_key:
        raise ProviderConfigError(auth_setup_message(file_api_key, api_key_env))
    if not model:
        raise ProviderConfigError("auth.json missing model")
    try:
        transparency = resolve_transparency_policy(raw.get("transparency"))
    except ValueError as exc:
        raise ProviderConfigError(str(exc)) from exc
    capabilities = raw.get("capabilities")
    if isinstance(capabilities, dict) and "transparent_background" in capabilities:
        raise ProviderConfigError(
            "auth.json capabilities.transparent_background is obsolete. Remove it; "
            "use postprocess.enabled or transparency.prompt_only_allow instead."
        )
    return EffectiveImageConfig(
        base_url=base_url,
        api_key=api_key,
        api_key_source=api_key_source,
        model=model,
        defaults=raw.get("defaults") if isinstance(raw.get("defaults"), dict) else {},
        capabilities=normalize_model_capabilities(capabilities),
        postprocess=resolve_postprocess_config(raw.get("postprocess")),
        transparency=transparency,
        user_agent=resolve_user_agent(raw.get("user_agent")),
        url_download=resolve_url_download_config(raw.get("url_download")),
    )


def is_valid_base_url(value: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(value)
        return parsed.scheme in {"http", "https"} and bool(parsed.hostname)
    except ValueError:
        return False


def normalize_model_capabilities(value: Any) -> dict[str, bool]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ProviderConfigError("model capabilities must be an object")
    unknown = sorted(set(value) - set(MODEL_CAPABILITY_KEYS))
    if unknown:
        raise ProviderConfigError(f"unsupported model capability: {unknown[0]}")
    for key, declared in value.items():
        if not isinstance(declared, bool):
            raise ProviderConfigError(f"model capability {key} must be boolean")
    return {key: value[key] for key in MODEL_CAPABILITY_KEYS if key in value}


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


def resolve_user_agent(value: Any, *, config_label: str = "auth.json") -> str:
    user_agent = str(value or DEFAULT_USER_AGENT).strip()
    if any(ord(char) < 32 or ord(char) == 127 for char in user_agent):
        raise ProviderConfigError(f"{config_label} user_agent must not contain control characters")
    return user_agent


def resolve_api_key(
    file_api_key: str,
    api_key_env: str,
    *,
    source_label: str = "auth.json",
) -> tuple[str, str]:
    if api_key_env and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", api_key_env):
        raise ProviderConfigError(f"{source_label} api_key_env must be a valid environment variable name")
    if file_api_key and not is_placeholder_api_key(file_api_key):
        return file_api_key, f"{source_label} api_key"
    if api_key_env:
        env_value = os.environ.get(api_key_env, "").strip()
        if env_value:
            return env_value, f"env:{api_key_env}"
    return "", "missing"


def is_placeholder_api_key(value: str) -> bool:
    return value.strip().lower() in PLACEHOLDER_API_KEYS


def auth_setup_message(
    file_api_key: str,
    api_key_env: str,
    *,
    config_label: str = "auth.json",
) -> str:
    if file_api_key and is_placeholder_api_key(file_api_key):
        if api_key_env:
            return (
                f"{config_label} api_key is still a placeholder and {api_key_env} is not set.\n"
                f"Edit {config_label} api_key directly, or set that environment variable."
            )
        return f"{config_label} api_key is still a placeholder. Edit {config_label} api_key or add api_key_env."
    if api_key_env:
        return f"{config_label} missing api_key and environment variable {api_key_env} is not set."
    return f"{config_label} missing api_key. Edit {config_label} api_key or add api_key_env."
