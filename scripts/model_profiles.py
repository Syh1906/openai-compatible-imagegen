"""Public model metadata and selection rules shared by both image adapters."""

from __future__ import annotations

import json
import hashlib
from pathlib import Path
import re
from typing import Any
import unicodedata
import urllib.parse


CONTRACT = json.loads(Path(__file__).with_name("model-profile-contract.json").read_text(encoding="utf-8"))


def normalize_alias(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip().lower()


def validate_image_defaults(value: Any, *, execution: bool = False) -> None:
    if value is None:
        return
    allowed = CONTRACT["executionDefaultKeys"] if execution else CONTRACT["imageDefaultKeys"]
    if not isinstance(value, dict) or set(value) - set(allowed):
        raise ValueError("unsupported model defaults")
    if "size" in value and (not isinstance(value["size"], str) or not re.fullmatch(r"[0-9]+x[0-9]+", value["size"])):
        raise ValueError("invalid default size")
    for key in ("quality", "output_format"):
        if key in value and (not isinstance(value[key], str) or not value[key].strip()):
            raise ValueError(f"invalid default {key}")
    if "aspect_ratio" in value and (not isinstance(value["aspect_ratio"], str) or not re.fullmatch(r"auto|[0-9]+(?:\.[0-9]+)?:[0-9]+(?:\.[0-9]+)?", value["aspect_ratio"])):
        raise ValueError("invalid default aspect_ratio")
    if "resolution" in value and (not isinstance(value["resolution"], str) or not value["resolution"].strip()):
        raise ValueError("invalid default resolution")
    if "size" in value and ("aspect_ratio" in value or "resolution" in value):
        raise ValueError("size conflicts with aspect_ratio/resolution")
    for key, maximum in (("timeout_seconds", 600), ("concurrency", 8)):
        if key in value and (type(value[key]) is not int or not 1 <= value[key] <= maximum):
            raise ValueError(f"invalid default {key}")


def validate_model_profiles(raw: dict[str, Any]) -> None:
    """Validate every selectable declaration without resolving any credentials."""
    version = raw.get("config_version")
    if type(version) is not int or version not in (1, 2):
        raise ValueError("image config requires config_version 1 or 2")
    if version == 2:
        validate_image_defaults(raw.get("defaults"), execution=True)
        validate_image_defaults(raw.get("host_defaults"))
    models, providers = raw.get("models"), raw.get("providers")
    if not isinstance(models, dict) or not isinstance(providers, dict):
        raise ValueError("image config requires providers and models objects")
    if not isinstance(raw.get("active_profile"), str) or raw["active_profile"] not in models:
        raise ValueError("active_profile must reference a configured model profile")
    aliases: dict[str, str] = {}
    normalized_ids = {normalize_alias(key): key for key in models if isinstance(key, str)}
    for provider_id, provider in providers.items():
        _identifier(provider_id)
        keys = CONTRACT["providerKeys"] + (CONTRACT["providerMetadataKeys"] if version == 2 else [])
        if not isinstance(provider, dict) or set(provider) - set(keys):
            raise ValueError("invalid provider fields")
        if provider.get("protocol") not in CONTRACT["protocols"]:
            raise ValueError("unsupported provider protocol")
        base_url = provider.get("base_url")
        if not isinstance(base_url, str):
            raise ValueError("invalid provider base_url")
        parsed = urllib.parse.urlsplit(base_url.strip())
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("invalid provider base_url")
        for key in ("api_key", "api_key_env"):
            if key in provider and not isinstance(provider[key], str):
                raise ValueError("invalid provider credential reference")
        if provider.get("api_key_env") and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", provider["api_key_env"]):
            raise ValueError("api_key_env must be a valid environment variable name")
        _metadata_text(provider, "display_name", 200)
        endpoints = provider.get("endpoints", {})
        if not isinstance(endpoints, dict) or set(endpoints) - {"generate", "edit"}:
            raise ValueError("invalid provider endpoints")
        for endpoint in endpoints.values():
            if not isinstance(endpoint, str) or endpoint != endpoint.strip() or any(ord(c) < 32 for c in endpoint):
                raise ValueError("invalid provider endpoint")
            parsed = urllib.parse.urlsplit(endpoint)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
                raise ValueError("invalid provider endpoint")
    for profile_id, profile in models.items():
        _identifier(profile_id)
        keys = CONTRACT["profileKeys"] + (CONTRACT["profileMetadataKeys"] if version == 2 else [])
        if not isinstance(profile, dict) or set(profile) - set(keys):
            raise ValueError("invalid model profile fields")
        if not profile.get("provider"):
            raise ValueError("image config model profile missing provider")
        _identifier(profile.get("provider"))
        _identifier(profile.get("model"))
        if profile["provider"] not in providers:
            raise ValueError("model profile references a missing provider")
        _metadata_text(profile, "display_name", 200)
        _metadata_text(profile, "description", 600)
        if version == 2:
            validate_image_defaults(profile.get("defaults"))
            from image_parameters import validate_parameters, validate_parameter_fields
            validate_parameters(profile.get("parameters", {}))
            validate_parameter_fields(profile.get("parameter_fields", {}))
        capabilities = profile.get("capabilities", {})
        if not isinstance(capabilities, dict):
            raise ValueError("invalid model capabilities")
        unknown = sorted(set(capabilities) - {"generate", "edit", "mask", "multi_reference"})
        if unknown:
            raise ValueError(f"unsupported model capability: {unknown[0]}")
        if any(type(value) is not bool for value in capabilities.values()):
            raise ValueError("invalid model capabilities")
        limits = profile.get("limits", {})
        if not isinstance(limits, dict) or set(limits) - {"max_input_images"}:
            raise ValueError("invalid model limits")
        if "max_input_images" in limits and (type(limits["max_input_images"]) is not int or limits["max_input_images"] < 1):
            raise ValueError("invalid maximum input images")
        values = profile.get("aliases", [])
        if not isinstance(values, list) or len(values) > 32:
            raise ValueError("model aliases must be a list of at most 32 names")
        for alias in values:
            if not isinstance(alias, str):
                raise ValueError("invalid model alias")
            _identifier(alias.strip())
            if len(alias) > 200:
                raise ValueError("model alias is too long")
            normalized = normalize_alias(alias)
            if not normalized or normalized in CONTRACT["reservedAliases"]:
                raise ValueError("model alias conflicts with a reserved route")
            if normalized in normalized_ids and normalized_ids[normalized] != profile_id:
                raise ValueError("model alias conflicts with a profile ID")
            if normalized in aliases and aliases[normalized] != profile_id:
                raise ValueError("model alias is ambiguous")
            aliases[normalized] = profile_id


def resolve_profile_id(raw: dict[str, Any], selection: str | None = None) -> str:
    validate_model_profiles(raw)
    models = raw["models"]
    if selection is None:
        return raw["active_profile"]
    if selection in models:
        return selection
    normalized = normalize_alias(selection)
    for profile_id, profile in models.items():
        if normalized in {normalize_alias(value) for value in profile.get("aliases", [])}:
            return profile_id
    matches = [key for key, profile in models.items() if profile["model"] == selection]
    if len(matches) == 1:
        return matches[0]
    raise ValueError("model selection is ambiguous" if matches else "model selection is not configured")


def model_selection_fingerprint(raw: dict[str, Any], profile_id: str) -> str:
    profile = raw["models"][profile_id]
    provider = {k: v for k, v in raw["providers"][profile["provider"]].items() if k != "api_key"}
    selection = {
        "contract": CONTRACT["version"], "profileId": profile_id, "profile": profile, "provider": provider,
        "defaults": raw.get("defaults", {}),
        "transparency": raw.get("transparency") if raw["config_version"] == 1 else profile.get("transparency"),
    }
    return hashlib.sha256(json.dumps(selection, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _identifier(value: Any) -> None:
    if not isinstance(value, str) or not value or value != value.strip() or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("model identifiers must be non-empty strings without surrounding whitespace or control characters")


def _metadata_text(record: dict[str, Any], key: str, maximum: int) -> None:
    if key in record:
        _identifier(record[key])
        if len(record[key]) > maximum:
            raise ValueError(f"model {key} is too long")
