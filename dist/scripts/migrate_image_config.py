#!/usr/bin/env python3
"""Explicitly migrate a legacy image configuration into the Plugin schema."""

from __future__ import annotations

import argparse
from copy import deepcopy
from dataclasses import dataclass, field
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import stat
import sys
from typing import Any

from provider_config import (
    PLACEHOLDER_API_KEYS,
    ProviderConfigError,
    parse_plugin_config,
)
from repository_fs import (
    DirectoryLease,
    delete_file_safely,
    ensure_directory_tree_safely,
    publish_new_file_safely,
)


PROFILE_ID = "primary/gpt-image-2"
CONFIG_DIRECTORY = "openai-compatible-imagegen"
PROJECT_DEFAULT_KEYS = ("size", "quality", "output_format")
CAPABILITY_KEYS = {"generate", "edit", "mask", "multi_reference"}
USER_TOP_LEVEL_KEYS = {
    "config_version",
    "active_profile",
    "providers",
    "models",
    "defaults",
    "postprocess",
    "transparency",
    "storage",
}
USER_DEFAULT_KEYS = {"size", "quality", "output_format", "timeout_seconds", "concurrency"}
PROJECT_TOP_LEVEL_KEYS = {"config_version", "defaults", "storage"}
STORAGE_KEYS = {"output_directory"}
PROVIDER_KEYS = {
    "protocol",
    "base_url",
    "api_key",
    "api_key_env",
    "user_agent",
    "url_download",
    "proxy",
}
MODEL_KEYS = {"provider", "model", "capabilities"}
STANDALONE_KEYS = {
    "base_url",
    "api_key",
    "api_key_env",
    "model",
    "defaults",
    "postprocess",
    "transparency",
    "user_agent",
    "url_download",
    "proxy",
    "capabilities",
}
DEVELOPMENT_PLUGIN_KEYS = {
    "config_version",
    "active_profile",
    "providers",
    "models",
    "defaults",
    "postprocess",
    "transparency",
    "storage",
}
REPARSE_POINT_ATTRIBUTE = 0x400
LOCAL_IGNORE_CONTENT = b"*\n"


class ConfigMigrationError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


@dataclass(frozen=True)
class ConfigMigrationPlan:
    source_path: Path
    source_sha256: str
    source_kind: str
    user_target: Path
    project_target: Path | None
    user_config: dict[str, Any] = field(repr=False)
    project_config: dict[str, Any] | None = field(repr=False)
    requires_plaintext_api_key: bool
    plaintext_api_key_authorized: bool

    @property
    def ready_to_write(self) -> bool:
        return not self.requires_plaintext_api_key or self.plaintext_api_key_authorized

    def public_summary(self) -> dict[str, Any]:
        return {
            "ok": True,
            "mode": "dry-run",
            "sourceKind": self.source_kind,
            "sourceSha256": self.source_sha256,
            "userTarget": self.user_target.absolute().as_posix(),
            "projectTarget": self.project_target.absolute().as_posix() if self.project_target else None,
            "readyToWrite": self.ready_to_write,
            "requiresPlaintextApiKeyAuthorization": self.requires_plaintext_api_key,
            "userConfigPreview": redact_config(self.user_config),
            "projectConfigPreview": deepcopy(self.project_config),
        }


def plan_migration(
    *,
    source_path: Path,
    source_kind: str,
    user_target: Path,
    project_target: Path | None = None,
    allow_plaintext_api_key: bool = False,
) -> ConfigMigrationPlan:
    source_path = Path(source_path).absolute()
    user_target = Path(user_target).absolute()
    project_target = Path(project_target).absolute() if project_target is not None else None
    targets = [user_target, *( [project_target] if project_target is not None else [] )]
    require_distinct_paths(source_path, targets)
    validate_target_parent_chains(targets)
    reject_existing_targets(targets)

    source_bytes = read_source_bytes(source_path)
    raw = parse_source_json(source_bytes)
    if source_kind == "standalone":
        if project_target is not None:
            raise ConfigMigrationError(
                "migration_project_override_forbidden",
                "standalone configuration can migrate only to the Plugin user configuration",
            )
        user_config, requires_plaintext = migrate_standalone(
            raw,
            allow_plaintext_api_key=allow_plaintext_api_key,
        )
        project_config = None
    elif source_kind == "development-plugin":
        user_config, project_config, requires_plaintext = migrate_development_plugin(
            raw,
            include_project_overrides=project_target is not None,
            allow_plaintext_api_key=allow_plaintext_api_key,
        )
    else:
        raise ConfigMigrationError(
            "migration_source_kind_invalid",
            "source kind must be standalone or development-plugin",
        )

    validate_user_config(user_config)
    if project_config is not None:
        validate_project_config(project_config)
    if project_target is not None and project_config is None:
        raise ConfigMigrationError(
            "migration_project_override_empty",
            "the source has no safe project override fields to migrate",
        )
    return ConfigMigrationPlan(
        source_path=source_path,
        source_sha256=sha256(source_bytes),
        source_kind=source_kind,
        user_target=user_target,
        project_target=project_target,
        user_config=user_config,
        project_config=project_config,
        requires_plaintext_api_key=requires_plaintext,
        plaintext_api_key_authorized=allow_plaintext_api_key,
    )


def write_migration(plan: ConfigMigrationPlan) -> dict[str, Any]:
    if not isinstance(plan, ConfigMigrationPlan):
        raise TypeError("plan must be a ConfigMigrationPlan")
    if not plan.ready_to_write:
        raise ConfigMigrationError(
            "migration_plaintext_key_authorization_required",
            "writing a plaintext API key requires --allow-plaintext-api-key",
        )
    targets = [
        (plan.user_target, plan.user_config),
        *(
            [(plan.project_target, plan.project_config)]
            if plan.project_target is not None and plan.project_config is not None
            else []
        ),
    ]
    reject_existing_targets([target for target, _value in targets])
    assert_source_unchanged(plan)

    leases: dict[Path, DirectoryLease] = {}
    created: list[Path] = []
    try:
        for target, _value in targets:
            leases[target] = prepare_target_directory(target)
        for target, _value in targets:
            ensure_target_directory_ignored(target, leases[target])
        assert_source_unchanged(plan)
        for target, value in targets:
            publish_json_new(target, value, leases[target])
            created.append(target)
        assert_source_unchanged(plan)
    except Exception as exc:
        residuals = list(getattr(exc, "residual_paths", ()))
        for target in reversed(created):
            try:
                rollback_published_target(target, leases[target])
            except OSError:
                residuals.append(target)
        if residuals:
            rendered = ", ".join(path.absolute().as_posix() for path in residuals)
            raise ConfigMigrationError(
                "migration_rollback_failed",
                f"migration failed and left files requiring manual review: {rendered}",
            ) from exc
        if isinstance(exc, ConfigMigrationError):
            raise
        if isinstance(exc, FileExistsError):
            raise ConfigMigrationError("migration_target_exists", "migration target already exists") from exc
        raise ConfigMigrationError("migration_write_failed", "migration targets could not be written") from exc
    finally:
        close_error: BaseException | None = None
        for lease in reversed(list(leases.values())):
            try:
                lease.close()
            except BaseException as exc:
                if close_error is None:
                    close_error = exc
        if close_error is not None and sys.exc_info()[0] is None:
            rendered = ", ".join(target.absolute().as_posix() for target in created)
            raise ConfigMigrationError(
                "migration_rollback_failed",
                f"migration targets were published but directory handles could not be closed; review: {rendered}",
            ) from close_error

    summary = plan.public_summary()
    summary["mode"] = "write"
    summary["written"] = [target.absolute().as_posix() for target, _value in targets]
    return summary


def migrate_standalone(
    raw: dict[str, Any],
    *,
    allow_plaintext_api_key: bool,
) -> tuple[dict[str, Any], bool]:
    reject_unknown_keys(raw, STANDALONE_KEYS)
    model = clean_text(raw.get("model") or "gpt-image-2")
    require_supported_model(model)
    capabilities = normalize_capabilities(raw.get("capabilities"))
    provider, requires_plaintext = migrate_provider_auth(
        {
            "protocol": "openai-compatible",
            "base_url": raw.get("base_url"),
            "api_key": raw.get("api_key"),
            "api_key_env": raw.get("api_key_env"),
            "user_agent": raw.get("user_agent"),
            "url_download": raw.get("url_download"),
            "proxy": raw.get("proxy"),
        },
        allow_plaintext_api_key=allow_plaintext_api_key,
    )
    user_config = base_user_config(provider, model, capabilities)
    copy_optional_sections(user_config, raw, ("defaults", "postprocess", "transparency"))
    return user_config, requires_plaintext


def migrate_development_plugin(
    raw: dict[str, Any],
    *,
    include_project_overrides: bool,
    allow_plaintext_api_key: bool,
) -> tuple[dict[str, Any], dict[str, Any] | None, bool]:
    reject_unknown_keys(raw, DEVELOPMENT_PLUGIN_KEYS)
    if raw.get("config_version") not in (None, 1):
        raise ConfigMigrationError("migration_source_invalid", "unsupported development config version")
    active_profile = raw.get("active_profile") or PROFILE_ID
    if active_profile != PROFILE_ID:
        raise ConfigMigrationError("migration_model_unsupported", "the active model profile is not supported")
    providers = require_object(raw.get("providers"), "providers")
    models = require_object(raw.get("models"), "models")
    if set(models) != {PROFILE_ID}:
        raise ConfigMigrationError("migration_model_unsupported", "exactly one supported model profile is required")
    profile = require_object(models.get(PROFILE_ID), PROFILE_ID)
    model = clean_text(profile.get("model"))
    require_supported_model(model)
    provider_id = clean_text(profile.get("provider"))
    if not provider_id or set(providers) != {provider_id}:
        raise ConfigMigrationError("migration_source_invalid", "the active model must reference one provider")
    capabilities = normalize_capabilities(profile.get("capabilities"))
    provider, requires_plaintext = migrate_provider_auth(
        require_object(providers.get(provider_id), provider_id),
        allow_plaintext_api_key=allow_plaintext_api_key,
    )
    user_config = base_user_config(provider, model, capabilities, provider_id=provider_id)
    copy_optional_sections(user_config, raw, ("defaults", "postprocess", "transparency", "storage"))

    project_config = None
    if include_project_overrides:
        project_config = {"config_version": 1}
        defaults = require_optional_object(raw.get("defaults"), "defaults")
        project_defaults = {key: defaults[key] for key in PROJECT_DEFAULT_KEYS if key in defaults}
        user_defaults = {key: value for key, value in defaults.items() if key not in PROJECT_DEFAULT_KEYS}
        if project_defaults:
            project_config["defaults"] = project_defaults
        if user_defaults:
            user_config["defaults"] = user_defaults
        else:
            user_config.pop("defaults", None)
        storage = require_optional_object(raw.get("storage"), "storage")
        if storage:
            project_config["storage"] = deepcopy(storage)
            user_config.pop("storage", None)
        if len(project_config) == 1:
            project_config = None
    return user_config, project_config, requires_plaintext


def base_user_config(
    provider: dict[str, Any],
    model: str,
    capabilities: dict[str, bool],
    *,
    provider_id: str = "primary",
) -> dict[str, Any]:
    profile: dict[str, Any] = {"provider": provider_id, "model": model}
    if capabilities:
        profile["capabilities"] = capabilities
    return {
        "config_version": 1,
        "active_profile": PROFILE_ID,
        "providers": {provider_id: provider},
        "models": {PROFILE_ID: profile},
    }


def migrate_provider_auth(
    raw: dict[str, Any],
    *,
    allow_plaintext_api_key: bool,
) -> tuple[dict[str, Any], bool]:
    allowed = {
        "protocol",
        "base_url",
        "api_key",
        "api_key_env",
        "user_agent",
        "url_download",
        "proxy",
    }
    reject_unknown_keys(raw, allowed)
    protocol = raw.get("protocol") or "openai-compatible"
    if protocol != "openai-compatible":
        raise ConfigMigrationError("migration_source_invalid", "unsupported provider protocol")
    base_url = clean_text(raw.get("base_url"))
    if not base_url:
        raise ConfigMigrationError("migration_source_invalid", "provider base_url is required")
    provider: dict[str, Any] = {"protocol": protocol, "base_url": base_url}
    for key in ("user_agent", "url_download", "proxy"):
        if raw.get(key) is not None:
            provider[key] = deepcopy(raw[key])

    api_key_env = clean_text(raw.get("api_key_env"))
    api_key = clean_text(raw.get("api_key"))
    usable_plaintext = bool(api_key) and api_key.lower() not in PLACEHOLDER_API_KEYS
    requires_plaintext = False
    if api_key_env:
        provider["api_key_env"] = api_key_env
    elif usable_plaintext:
        provider["api_key"] = api_key
        requires_plaintext = not allow_plaintext_api_key
    else:
        raise ConfigMigrationError(
            "migration_auth_missing",
            "the source has neither api_key_env nor an authorized plaintext API key",
        )
    return provider, requires_plaintext


def normalize_capabilities(value: Any) -> dict[str, bool]:
    if value is None:
        return {}
    capabilities = require_object(value, "capabilities")
    if "transparent_background" in capabilities:
        raise ConfigMigrationError(
            "migration_transparent_background_removed",
            "transparent_background was removed and cannot be translated",
        )
    unknown = sorted(set(capabilities) - CAPABILITY_KEYS)
    if unknown:
        raise ConfigMigrationError("migration_source_invalid", f"unsupported capability: {unknown[0]}")
    if any(not isinstance(declared, bool) for declared in capabilities.values()):
        raise ConfigMigrationError("migration_source_invalid", "capability values must be boolean")
    return {key: capabilities[key] for key in sorted(capabilities)}


def validate_user_config(config: dict[str, Any]) -> None:
    require_exact_output_keys(config, USER_TOP_LEVEL_KEYS, "user configuration")
    if config.get("config_version") != 1 or config.get("active_profile") != PROFILE_ID:
        raise ConfigMigrationError("migration_source_invalid", "invalid Plugin configuration identity")
    providers = require_object(config.get("providers"), "providers")
    models = require_object(config.get("models"), "models")
    profile = require_object(models.get(PROFILE_ID), PROFILE_ID)
    require_exact_output_keys(profile, MODEL_KEYS, "model profile")
    provider_id = profile.get("provider")
    if not isinstance(provider_id, str) or not provider_id or provider_id.strip() != provider_id:
        raise ConfigMigrationError("migration_source_invalid", "model provider must be a trimmed string")
    provider = require_object(providers.get(provider_id), provider_id)
    validate_provider_output(provider)
    if profile.get("model") != "gpt-image-2":
        raise ConfigMigrationError("migration_model_unsupported", "the migrated model is not supported")
    normalize_capabilities(profile.get("capabilities"))
    validate_defaults_output(config.get("defaults"), USER_DEFAULT_KEYS)
    validate_postprocess_output(config.get("postprocess"))
    validate_transparency_output(config.get("transparency"))
    validate_storage_output(config.get("storage"))
    try:
        parse_plugin_config(
            config,
            require_api_key=False,
            model_profile_id=PROFILE_ID,
        )
    except ProviderConfigError as exc:
        raise ConfigMigrationError("migration_source_invalid", str(exc)) from exc


def validate_project_config(config: dict[str, Any]) -> None:
    require_exact_output_keys(config, PROJECT_TOP_LEVEL_KEYS, "project configuration")
    if config.get("config_version") != 1:
        raise ConfigMigrationError("migration_source_invalid", "invalid project configuration version")
    validate_defaults_output(config.get("defaults"), set(PROJECT_DEFAULT_KEYS))
    validate_storage_output(config.get("storage"))


def validate_provider_output(provider: dict[str, Any]) -> None:
    require_exact_output_keys(provider, PROVIDER_KEYS, "provider")
    if provider.get("protocol") != "openai-compatible":
        raise ConfigMigrationError("migration_source_invalid", "unsupported provider protocol")
    for key in ("api_key", "api_key_env"):
        if key in provider and not isinstance(provider[key], str):
            raise ConfigMigrationError("migration_source_invalid", f"provider {key} must be a string")
    if not clean_text(provider.get("api_key")) and not clean_text(provider.get("api_key_env")):
        raise ConfigMigrationError("migration_source_invalid", "provider authentication is missing")
    user_agent = provider.get("user_agent")
    if user_agent is not None:
        if any(ord(character) < 32 or ord(character) == 127 for character in str(user_agent)):
            raise ConfigMigrationError("migration_source_invalid", "provider user_agent is invalid")
    download = provider.get("url_download")
    if download is not None:
        download = require_object(download, "url_download")
        require_exact_output_keys(download, {"proxy_mode"}, "url_download")
        if download.get("proxy_mode", "environment") not in {"environment", "direct"}:
            raise ConfigMigrationError("migration_source_invalid", "url_download.proxy_mode is invalid")


def validate_defaults_output(value: Any, allowed_keys: set[str]) -> None:
    if value is None:
        return
    defaults = require_object(value, "defaults")
    require_exact_output_keys(defaults, allowed_keys, "defaults")
    size = defaults.get("size")
    if size is not None and (not isinstance(size, str) or re.fullmatch(r"[0-9]+x[0-9]+", size) is None):
        raise ConfigMigrationError("migration_source_invalid", "defaults.size is invalid")
    if defaults.get("quality") is not None and defaults["quality"] not in {"auto", "low", "medium", "high"}:
        raise ConfigMigrationError("migration_source_invalid", "defaults.quality is invalid")
    if defaults.get("output_format") is not None and defaults["output_format"] not in {"png", "jpeg", "webp"}:
        raise ConfigMigrationError("migration_source_invalid", "defaults.output_format is invalid")
    for key, minimum, maximum in (("timeout_seconds", 1, 600), ("concurrency", 1, 8)):
        declared = defaults.get(key)
        if declared is not None and (
            not isinstance(declared, int)
            or isinstance(declared, bool)
            or not minimum <= declared <= maximum
        ):
            raise ConfigMigrationError("migration_source_invalid", f"defaults.{key} is invalid")


def validate_postprocess_output(value: Any) -> None:
    if value is None:
        return
    postprocess = require_object(value, "postprocess")
    require_exact_output_keys(postprocess, {"enabled"}, "postprocess")
    if "enabled" in postprocess and not isinstance(postprocess["enabled"], bool):
        raise ConfigMigrationError("migration_source_invalid", "postprocess.enabled must be boolean")


def validate_transparency_output(value: Any) -> None:
    if value is None:
        return
    transparency = require_object(value, "transparency")
    require_exact_output_keys(
        transparency,
        {"default_route", "prompt_only_allow", "llm_assisted"},
        "transparency",
    )
    if "prompt_only_allow" in transparency and not isinstance(transparency["prompt_only_allow"], list):
        raise ConfigMigrationError("migration_source_invalid", "transparency.prompt_only_allow must be an array")
    if "llm_assisted" in transparency and not isinstance(transparency["llm_assisted"], dict):
        raise ConfigMigrationError("migration_source_invalid", "transparency.llm_assisted must be an object")


def validate_storage_output(value: Any) -> None:
    if value is None:
        return
    storage = require_object(value, "storage")
    require_exact_output_keys(storage, STORAGE_KEYS, "storage")
    output_directory = storage.get("output_directory")
    if output_directory is not None and (
        not isinstance(output_directory, str)
        or not output_directory
        or output_directory.strip() != output_directory
    ):
        raise ConfigMigrationError("migration_source_invalid", "storage.output_directory is invalid")
    if output_directory is not None:
        declared_path = Path(output_directory)
        normalized = os.path.normpath(output_directory)
        if (
            declared_path.is_absolute()
            or bool(declared_path.drive)
            or normalized in {"", ".", ".."}
            or normalized.startswith(f"..{os.sep}")
        ):
            raise ConfigMigrationError("migration_source_invalid", "storage.output_directory must stay inside the project")


def require_exact_output_keys(value: dict[str, Any], allowed: set[str], name: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ConfigMigrationError("migration_source_invalid", f"unsupported {name} field: {unknown[0]}")


def copy_optional_sections(target: dict[str, Any], source: dict[str, Any], keys: tuple[str, ...]) -> None:
    for key in keys:
        if source.get(key) is not None:
            target[key] = deepcopy(source[key])


def read_source_bytes(source_path: Path) -> bytes:
    try:
        source = Path(source_path).absolute()
        with DirectoryLease(source.parent) as lease:
            with lease.open_file(source.name, protect_from_rename=True) as verified:
                return verified.read_bytes()
    except (OSError, ValueError) as exc:
        raise ConfigMigrationError("migration_source_invalid", "source is not a safe readable file") from exc


def parse_source_json(source_bytes: bytes) -> dict[str, Any]:
    try:
        parsed = json.loads(source_bytes.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ConfigMigrationError("migration_source_invalid", "source is not valid UTF-8 JSON") from exc
    if not isinstance(parsed, dict):
        raise ConfigMigrationError("migration_source_invalid", "source root must be an object")
    return parsed


def reject_existing_targets(targets: list[Path]) -> None:
    for target in targets:
        try:
            target.lstat()
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise ConfigMigrationError("migration_target_invalid", "migration target is not accessible") from exc
        raise ConfigMigrationError("migration_target_exists", "migration target already exists")


def validate_target_parent_chains(targets: list[Path]) -> None:
    for target in targets:
        current = Path(target.anchor)
        for part in target.parent.parts[1:]:
            current = current / part
            try:
                metadata = current.lstat()
            except FileNotFoundError:
                break
            except OSError as exc:
                raise ConfigMigrationError(
                    "migration_target_invalid",
                    "migration target parent is not safely accessible",
                ) from exc
            if _is_allowed_system_ancestor(current):
                continue
            if is_reparse_point(metadata) or not stat.S_ISDIR(metadata.st_mode):
                raise ConfigMigrationError(
                    "migration_target_invalid",
                    "migration target parent contains a reparse point or non-directory",
                )


def require_distinct_paths(source_path: Path, targets: list[Path]) -> None:
    normalized = [os.path.normcase(str(path.absolute())) for path in targets]
    if len(set(normalized)) != len(normalized):
        raise ConfigMigrationError("migration_target_invalid", "migration targets must be distinct")
    if os.path.normcase(str(source_path.absolute())) in normalized:
        raise ConfigMigrationError("migration_target_exists", "source cannot be used as a migration target")


def assert_source_unchanged(plan: ConfigMigrationPlan) -> None:
    if sha256(read_source_bytes(plan.source_path)) != plan.source_sha256:
        raise ConfigMigrationError("migration_source_changed", "source changed after the dry-run")


def prepare_target_directory(target: Path) -> DirectoryLease:
    absolute_target = Path(target).absolute()
    return ensure_directory_tree_safely(Path(absolute_target.anchor), absolute_target.parent)


def publish_json_new(
    target: Path,
    value: dict[str, Any],
    directory_lease: DirectoryLease,
) -> None:
    encoded = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    absolute_target = Path(target).absolute()
    publish_new_file_safely(directory_lease, absolute_target.name, encoded)


def ensure_target_directory_ignored(target: Path, directory_lease: DirectoryLease) -> None:
    def read_existing() -> bytes:
        with directory_lease.open_file(".gitignore", protect_from_rename=True) as verified:
            return verified.read_bytes()

    try:
        existing = read_existing()
    except FileNotFoundError:
        try:
            publish_new_file_safely(directory_lease, ".gitignore", LOCAL_IGNORE_CONTENT)
            return
        except FileExistsError:
            try:
                existing = read_existing()
            except OSError as exc:
                raise ConfigMigrationError(
                    "migration_write_failed",
                    "migration target ignore guard could not be verified",
                ) from exc
        except OSError as exc:
            raise ConfigMigrationError(
                "migration_write_failed",
                "migration target ignore guard could not be written",
            ) from exc
    except OSError as exc:
        raise ConfigMigrationError(
            "migration_write_failed",
            "migration target ignore guard could not be read",
        ) from exc
    if existing != LOCAL_IGNORE_CONTENT:
        raise ConfigMigrationError(
            "migration_write_failed",
            "migration target ignore guard must contain only *",
        )


def rollback_published_target(target: Path, directory_lease: DirectoryLease) -> None:
    absolute_target = Path(target).absolute()
    delete_file_safely(directory_lease, absolute_target.name)


def redact_config(config: dict[str, Any]) -> dict[str, Any]:
    redacted = deepcopy(config)
    providers = redacted.get("providers")
    if isinstance(providers, dict):
        for provider in providers.values():
            if isinstance(provider, dict) and "api_key" in provider:
                provider["api_key"] = "[REDACTED]"
    return redacted


def reject_unknown_keys(value: dict[str, Any], allowed: set[str]) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ConfigMigrationError("migration_source_invalid", f"unsupported source field: {unknown[0]}")


def require_object(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigMigrationError("migration_source_invalid", f"{name} must be an object")
    return value


def require_optional_object(value: Any, name: str) -> dict[str, Any]:
    if value is None:
        return {}
    return require_object(value, name)


def require_supported_model(model: str) -> None:
    if model != "gpt-image-2":
        raise ConfigMigrationError("migration_model_unsupported", f"unsupported model: {model or '(missing)'}")


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def is_reparse_point(metadata: os.stat_result) -> bool:
    return stat.S_ISLNK(metadata.st_mode) or bool(
        getattr(metadata, "st_file_attributes", 0) & REPARSE_POINT_ATTRIBUTE
    )


def _is_allowed_system_ancestor(path: Path) -> bool:
    return (
        sys.platform == "darwin"
        and path == Path("/var")
        and Path(os.path.realpath(path)) == Path("/private/var")
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--source-kind", required=True, choices=["standalone", "development-plugin"])
    parser.add_argument("--user-home", type=Path, default=Path.home())
    parser.add_argument("--project-root", type=Path)
    parser.add_argument("--include-project-overrides", action="store_true")
    parser.add_argument("--allow-plaintext-api-key", action="store_true")
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--expected-source-sha256")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.write and args.expected_source_sha256 is None:
        print_error(ConfigMigrationError(
            "migration_expected_source_sha256_required",
            "--write requires --expected-source-sha256 from a previous dry-run",
        ))
        return 2
    if args.expected_source_sha256 is not None and not args.write:
        print_error(ConfigMigrationError(
            "migration_expected_source_sha256_not_used",
            "--expected-source-sha256 requires --write",
        ))
        return 2
    if args.expected_source_sha256 is not None and re.fullmatch(r"[0-9a-fA-F]{64}", args.expected_source_sha256) is None:
        print_error(ConfigMigrationError(
            "migration_expected_source_sha256_invalid",
            "--expected-source-sha256 must be a 64-character hexadecimal digest",
        ))
        return 2
    if args.include_project_overrides and args.project_root is None:
        print_error(ConfigMigrationError(
            "migration_project_root_required",
            "--include-project-overrides requires --project-root",
        ))
        return 2
    if args.project_root is not None and not args.include_project_overrides:
        print_error(ConfigMigrationError(
            "migration_project_override_not_selected",
            "--project-root requires --include-project-overrides",
        ))
        return 2
    user_target = args.user_home / ".codex" / CONFIG_DIRECTORY / "config.json"
    project_target = (
        args.project_root / ".codex" / CONFIG_DIRECTORY / "config.json"
        if args.include_project_overrides
        else None
    )
    try:
        plan = plan_migration(
            source_path=args.source,
            source_kind=args.source_kind,
            user_target=user_target,
            project_target=project_target,
            allow_plaintext_api_key=args.allow_plaintext_api_key,
        )
        if args.write and not hmac.compare_digest(
            args.expected_source_sha256.lower(),
            plan.source_sha256,
        ):
            raise ConfigMigrationError(
                "migration_source_changed",
                "source does not match the SHA-256 returned by the dry-run",
            )
        result = write_migration(plan) if args.write else plan.public_summary()
    except ConfigMigrationError as exc:
        print_error(exc)
        return 1
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


def print_error(error: ConfigMigrationError) -> None:
    print(json.dumps({
        "ok": False,
        "error": {"code": error.code, "message": str(error).split(": ", 1)[-1]},
    }, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    sys.exit(main())
