from __future__ import annotations

from dataclasses import dataclass, field
import os
from typing import Any
import urllib.parse
import re

from image_transparency import TransparencyPolicy, resolve_policy as resolve_transparency_policy
from model_profiles import CONTRACT, model_selection_fingerprint, normalize_alias, validate_image_defaults, validate_model_profiles
from native_image_protocols import NATIVE_PROTOCOLS
from image_parameters import resolve_parameter_defaults


DEFAULT_MODEL = "gpt-image-2"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
DEFAULT_POSTPROCESS = {"enabled": False}
DEFAULT_URL_DOWNLOAD = {"proxy_mode": "environment"}
DEFAULT_PROXY: dict[str, str] = {}
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
    protocol: str = "openai-compatible"
    provider_id: str = "primary"
    profile_id: str = "primary/gpt-image-2"
    capabilities: dict[str, Any] = field(default_factory=dict)
    transparency: TransparencyPolicy = field(default_factory=TransparencyPolicy)
    user_agent: str = DEFAULT_USER_AGENT
    url_download: dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_URL_DOWNLOAD))
    proxy: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_PROXY))
    config_version: int = 1
    limits: dict[str, Any] = field(default_factory=dict)
    endpoints: dict[str, str] = field(default_factory=dict)
    parameters: dict[str, Any] = field(default_factory=dict)
    parameter_fields: dict[str, Any] = field(default_factory=dict)
    selection_snapshot: dict[str, Any] | None = field(default=None, repr=False, compare=False)


@dataclass(frozen=True)
class LocalImageConfig:
    defaults: dict[str, Any]
    postprocess: dict[str, Any]
    transparency: TransparencyPolicy = field(default_factory=TransparencyPolicy)


Config = EffectiveImageConfig


def parse_standalone_config(
    raw: dict[str, Any],
    *,
    require_api_key: bool,
    model_profile_id: str | None = None,
) -> EffectiveImageConfig:
    if "config_version" in raw:
        return parse_plugin_config(raw, require_api_key=require_api_key, model_profile_id=model_profile_id or raw.get("active_profile"))
    if model_profile_id is not None:
        raise ProviderConfigError("profile selection requires a provider/model configuration")
    return _parse_standalone_config(raw, require_api_key=require_api_key)


def parse_plugin_config(
    raw: dict[str, Any],
    *,
    require_api_key: bool,
    model_profile_id: str,
) -> EffectiveImageConfig:
    try:
        validate_model_profiles(raw)
    except ValueError as exc:
        raise ProviderConfigError(str(exc)) from exc
    providers = raw.get("providers")
    models = raw.get("models")
    if not isinstance(providers, dict) or not isinstance(models, dict):
        raise ProviderConfigError("image config requires providers and models objects")
    if not isinstance(raw.get("active_profile"), str) or raw["active_profile"] not in models:
        raise ProviderConfigError("image config active_profile must reference a configured model profile")
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
    protocol = resolve_provider_protocol(provider.get("protocol"))

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
        transparency = resolve_transparency_policy(
            profile.get("transparency") if raw["config_version"] == 2 else raw.get("transparency")
        )
    except ValueError as exc:
        raise ProviderConfigError(str(exc)) from exc
    return EffectiveImageConfig(
        base_url=base_url,
        api_key=api_key,
        api_key_source=api_key_source,
        model=model,
        defaults={**(raw.get("defaults") or {}), **(profile.get("defaults") or {})} if raw["config_version"] == 2
        else raw.get("defaults") if isinstance(raw.get("defaults"), dict) else {},
        provider_id=provider_id,
        profile_id=model_profile_id,
        capabilities=normalize_model_capabilities(profile.get("capabilities")),
        postprocess=resolve_postprocess_config(raw.get("postprocess")),
        protocol=protocol,
        config_version=raw["config_version"],
        limits=dict(profile.get("limits") or {}),
        endpoints=dict(provider.get("endpoints") or {}),
        parameters=resolve_parameter_defaults(profile.get("parameter_fields", {}), profile.get("parameters", {})),
        parameter_fields=dict(profile.get("parameter_fields", {})),
        transparency=transparency,
        user_agent=resolve_user_agent(provider.get("user_agent"), config_label="user config"),
        url_download=resolve_url_download_config(provider.get("url_download")),
        proxy=resolve_proxy_config(provider.get("proxy"), config_label="user config"),
    )


def parse_plugin_local_config(raw: dict[str, Any]) -> LocalImageConfig:
    if raw.get("config_version") not in (1, 2):
        raise ProviderConfigError("image config requires config_version 1 or 2")
    defaults = raw.get("defaults")
    if defaults is not None and not isinstance(defaults, dict):
        raise ProviderConfigError("image config defaults must be an object")
    try:
        if raw["config_version"] == 2:
            validate_image_defaults(defaults, execution=True)
            validate_image_defaults(raw.get("host_defaults"))
            defaults = {**(defaults or {}), **(raw.get("host_defaults") or {})}
        transparency = resolve_transparency_policy(raw.get("transparency"))
    except ValueError as exc:
        raise ProviderConfigError(str(exc)) from exc
    return LocalImageConfig(
        defaults=dict(defaults or {}),
        postprocess=resolve_postprocess_config(raw.get("postprocess")),
        transparency=transparency,
    )


def list_model_profiles(raw: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for profile_id, profile in raw.get("models", {}).items():
        cfg = parse_plugin_config(raw, require_api_key=False, model_profile_id=profile_id)
        aliases = {}
        for alias in profile.get("aliases", []):
            aliases.setdefault(normalize_alias(alias), alias.strip())
        capabilities = normalize_model_capabilities(cfg.capabilities)
        effective = {key: capabilities.get(key, False) for key in MODEL_CAPABILITY_KEYS}
        if cfg.protocol == "atlas":
            effective.update(edit=False, mask=False, multi_reference=False)
        limits = dict(cfg.limits)
        if cfg.protocol in NATIVE_PROTOCOLS:
            effective["mask"] = False
        result.append({
            "id": profile_id, "provider": cfg.provider_id, "model": cfg.model,
            "capabilities": capabilities, "effectiveCapabilities": effective,
            "displayName": profile.get("display_name", cfg.model), "aliases": list(aliases.values()),
            "description": profile.get("description", ""),
            "providerDisplayName": raw["providers"][cfg.provider_id].get("display_name", cfg.provider_id),
            "protocol": cfg.protocol, "isDefault": profile_id == raw["active_profile"],
            "defaults": {k: v for k, v in cfg.defaults.items() if k in CONTRACT["imageDefaultKeys"]},
            "limits": limits,
            "parameterFields": cfg.parameter_fields,
            "parameters": cfg.parameters,
            "availability": "configured" if cfg.api_key else "missing_credentials",
            "selectionFingerprint": model_selection_fingerprint(raw, profile_id),
        })
    return result


def _parse_standalone_config(raw: dict[str, Any], *, require_api_key: bool) -> EffectiveImageConfig:
    protocol = resolve_provider_protocol(raw.get("protocol", "openai-compatible"))
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
        protocol=protocol,
        transparency=transparency,
        user_agent=resolve_user_agent(raw.get("user_agent")),
        url_download=resolve_url_download_config(raw.get("url_download")),
        proxy=resolve_proxy_config(raw.get("proxy")),
    )


def is_valid_base_url(value: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(value)
        return parsed.scheme in {"http", "https"} and bool(parsed.hostname)
    except ValueError:
        return False


def resolve_provider_protocol(value: Any) -> str:
    protocol = str(value or "").strip()
    if protocol not in CONTRACT["protocols"]:
        raise ProviderConfigError(f"unsupported provider protocol: {value}")
    return protocol


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


def resolve_proxy_config(value: Any, *, config_label: str = "auth.json") -> dict[str, str]:
    if value is None:
        return dict(DEFAULT_PROXY)
    if not isinstance(value, dict) or set(value) != {"url"}:
        raise ProviderConfigError(f"{config_label} proxy must contain only proxy.url")
    raw_url = value.get("url")
    if not isinstance(raw_url, str) or raw_url != raw_url.strip():
        raise ProviderConfigError(f"{config_label} proxy.url must be a valid http(s) URL")
    if any(ord(char) < 32 or ord(char) == 127 for char in raw_url):
        raise ProviderConfigError(f"{config_label} proxy.url must not contain control characters")
    try:
        parsed = urllib.parse.urlsplit(raw_url)
        parsed.port
    except ValueError as exc:
        raise ProviderConfigError(f"{config_label} proxy.url must be a valid http(s) URL") from exc
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise ProviderConfigError(
            f"{config_label} proxy.url must be an http(s) URL without credentials, query, fragment, or path"
        )
    return {"url": raw_url.rstrip("/")}


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
