"""Transparency planning and deterministic chroma-matting processing."""

from __future__ import annotations

from dataclasses import dataclass, field
import math
import json
from pathlib import Path
import re
import shutil
from typing import Any

from image_alpha import (
    KEY_SPILL_THRESHOLD,
    edge_connected_color_alpha,
    key_spill_score,
    refine_alpha,
    remove_matte_and_defringe,
)
from image_png import PixelBuffer, read_png_rgba, write_png_rgba
from image_emissive_alpha import EmissiveAlphaError, process as process_emissive_alpha
from image_mask_alpha import MaskAlphaError, process as process_mask_alpha


KEY_CANDIDATES: tuple[tuple[str, tuple[int, int, int], tuple[str, ...]], ...] = (
    ("#00FF00", (0, 255, 0), ("green", "lime", "emerald", "绿色", "青绿")),
    ("#00FFFF", (0, 255, 255), ("cyan", "teal", "turquoise", "blue", "青色", "蓝色", "蓝绿")),
    ("#FFEA00", (255, 234, 0), ("yellow", "gold", "amber", "黄色", "金色")),
    ("#FF00FF", (255, 0, 255), ("magenta", "pink", "purple", "violet", "洋红", "粉色", "紫色")),
)
LOCAL_ROUTES = {"chroma-matting", "emissive-alpha", "mask-alpha"}
TRANSPARENCY_ROUTES = LOCAL_ROUTES | {"prompt-alpha", "native-alpha"}
INSPECT_ALPHA_ROUTE = "inspect-alpha"
MAX_TRANSPARENCY_PIXELS = 4096 * 4096
FULL_TOLERANCE = 56.0
BORDER_SOFT_TOLERANCE = 92.0
MATTE_OUTER_TOLERANCE = 160.0
CONTAMINATION_TOLERANCE = MATTE_OUTER_TOLERANCE
REFERENCE_NEAR_TOLERANCE = 48.0
MIN_BORDER_HARD_COVERAGE = 0.60
MIN_BORDER_SOFT_COVERAGE = 0.90
MIN_TRANSPARENT_RATIO = 0.005
MIN_VISIBLE_RATIO = 0.01
MAX_VISIBLE_BORDER_RATIO = 0.10
MAX_KEY_CONTAMINATION_RATIO = 0.005
MIN_KEY_CONTAMINATION_PIXELS = 8
DESPILL_STRENGTH = 1.0


class TransparencyUnavailableError(ValueError):
    """Raised before a request when no declared transparency route matches."""


@dataclass(frozen=True)
class PromptOnlyRule:
    model: str
    mode: str
    size: str


@dataclass(frozen=True)
class LlmAssistedPolicy:
    enabled: bool = False
    max_attempts: int = 2
    allow_parameter_tuning: bool = True
    allow_route_change: bool = True
    allow_api_retry: bool = False

    def to_record(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "max_attempts": self.max_attempts,
            "allow_parameter_tuning": self.allow_parameter_tuning,
            "allow_route_change": self.allow_route_change,
            "allow_api_retry": self.allow_api_retry,
        }


@dataclass(frozen=True)
class NativeTransparencyPolicy:
    enabled: bool = False
    model_ids: tuple[str, ...] = ()
    retry_without_parameter: bool = True
    fallback_route: str = "chroma-matting"

    def to_record(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "model_ids": list(self.model_ids),
            "retry_without_parameter": self.retry_without_parameter,
            "fallback_route": self.fallback_route,
        }


@dataclass(frozen=True)
class TransparencyPolicy:
    default_route: str = "chroma-matting"
    prompt_only_allow: tuple[PromptOnlyRule, ...] = ()
    llm_assisted: LlmAssistedPolicy = field(default_factory=LlmAssistedPolicy)
    native: NativeTransparencyPolicy = field(default_factory=NativeTransparencyPolicy)


@dataclass(frozen=True)
class TransparencyContext:
    requested: bool
    prompt: str
    model: str
    mode: str
    size: str
    postprocess_allowed: bool
    reference_paths: tuple[Path, ...] = ()
    route: str | None = None
    mask_path: Path | None = None
    options: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class TransparencyPlan:
    mode: str
    prompt: str
    key_hex: str | None = None
    mask_path: Path | None = None
    options: dict[str, Any] = field(default_factory=dict)
    llm_assisted: LlmAssistedPolicy = field(default_factory=LlmAssistedPolicy)
    native_retry_without_parameter: bool = False
    native_fallback_route: str | None = None
    native_attempted: bool = False
    native_parameter: str | None = None
    retried_without_parameter: bool = False
    api_attempts: int = 0
    warnings: tuple[str, ...] = ()

    def to_record(self) -> dict[str, Any]:
        return {
            "requested": self.mode != "none",
            "mode": self.mode,
            "key": self.key_hex,
            "mask": self.mask_path.as_posix() if self.mask_path else None,
            "options": dict(self.options),
            "llm_assisted": self.llm_assisted.to_record(),
            "native_retry_without_parameter": self.native_retry_without_parameter,
            "native_fallback_route": self.native_fallback_route,
            "native_attempted": self.native_attempted,
            "native_parameter": self.native_parameter,
            "retried_without_parameter": self.retried_without_parameter,
            "api_attempts": self.api_attempts,
            "final_route": self.mode,
            "status": "pending" if self.mode != "none" else "not_requested",
            "warnings": list(self.warnings),
        }

    @classmethod
    def from_record(cls, value: dict[str, Any], prompt: str = "") -> "TransparencyPlan":
        return cls(
            mode=str(value.get("mode") or "none"),
            prompt=prompt,
            key_hex=str(value["key"]) if value.get("key") else None,
            mask_path=Path(str(value["mask"])).expanduser().resolve() if value.get("mask") else None,
            options=dict(value.get("options") or {}),
            llm_assisted=_resolve_llm_assisted(value.get("llm_assisted")),
            native_retry_without_parameter=bool(value.get("native_retry_without_parameter", False)),
            native_fallback_route=(str(value["native_fallback_route"]) if value.get("native_fallback_route") else None),
            native_attempted=bool(value.get("native_attempted", False)),
            native_parameter=(str(value["native_parameter"]) if value.get("native_parameter") else None),
            retried_without_parameter=bool(value.get("retried_without_parameter", False)),
            api_attempts=int(value.get("api_attempts") or 0),
            warnings=tuple(str(item) for item in value.get("warnings", []) if isinstance(item, str)),
        )


def resolve_policy(value: Any) -> TransparencyPolicy:
    if value is None:
        return TransparencyPolicy()
    if not isinstance(value, dict):
        raise ValueError("auth.json transparency must be an object")
    default_route = str(value.get("default_route") or "chroma-matting").strip().lower()
    native_value = value.get("native")
    if default_route not in LOCAL_ROUTES | {"native-alpha"}:
        raise ValueError(
            "auth.json transparency.default_route must be chroma-matting, emissive-alpha, mask-alpha, or native-alpha"
        )
    native = _resolve_native_policy(native_value)
    if default_route == "native-alpha" and not native.enabled:
        raise ValueError("auth.json transparency.native.enabled must be true when default_route is native-alpha")
    rules_value = value.get("prompt_only_allow", [])
    if not isinstance(rules_value, list):
        raise ValueError("auth.json transparency.prompt_only_allow must be an array")
    rules: list[PromptOnlyRule] = []
    seen: set[tuple[str, str, str]] = set()
    for index, item in enumerate(rules_value):
        if not isinstance(item, dict):
            raise ValueError(f"auth.json transparency.prompt_only_allow[{index}] must be an object")
        model = str(item.get("model") or "").strip()
        mode = str(item.get("mode") or "").strip().lower()
        size = str(item.get("size") or "").strip().lower()
        if not model or mode not in {"generate", "edit"} or not _valid_size(size):
            raise ValueError(
                f"auth.json transparency.prompt_only_allow[{index}] requires model, "
                "mode=generate|edit, and an exact WIDTHxHEIGHT size"
            )
        key = (model, mode, size)
        if key in seen:
            raise ValueError(f"duplicate transparency prompt-only rule: {model}/{mode}/{size}")
        seen.add(key)
        rules.append(PromptOnlyRule(model=model, mode=mode, size=size))
    return TransparencyPolicy(
        default_route=default_route,
        prompt_only_allow=tuple(rules),
        llm_assisted=_resolve_llm_assisted(value.get("llm_assisted")),
        native=native,
    )


def _resolve_native_policy(value: Any) -> NativeTransparencyPolicy:
    if value is None:
        return NativeTransparencyPolicy()
    if not isinstance(value, dict):
        raise ValueError("auth.json transparency.native must be an object")
    allowed = {"enabled", "model_ids", "retry_without_parameter", "fallback_route"}
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ValueError(f"unsupported transparency.native option: {unknown[0]}")
    enabled = value.get("enabled", True)
    retry = value.get("retry_without_parameter", True)
    if not isinstance(enabled, bool) or not isinstance(retry, bool):
        raise ValueError("auth.json transparency.native enabled and retry_without_parameter must be boolean")
    model_ids_value = value.get("model_ids", [])
    if not isinstance(model_ids_value, list):
        raise ValueError("auth.json transparency.native.model_ids must be an array")
    model_ids: list[str] = []
    for item in model_ids_value:
        if not isinstance(item, str) or not item.strip() or item != item.strip() or item.strip() in model_ids:
            raise ValueError("auth.json transparency.native.model_ids must contain unique non-empty strings")
        model_ids.append(item)
    fallback = str(value.get("fallback_route") or "chroma-matting").strip().lower()
    if fallback not in LOCAL_ROUTES:
        raise ValueError("auth.json transparency.native.fallback_route must be chroma-matting, emissive-alpha, or mask-alpha")
    return NativeTransparencyPolicy(enabled, tuple(model_ids), retry, fallback)


def _resolve_llm_assisted(value: Any) -> LlmAssistedPolicy:
    if value is None:
        return LlmAssistedPolicy()
    if not isinstance(value, dict):
        raise ValueError("auth.json transparency.llm_assisted must be an object")
    allowed = {
        "enabled",
        "max_attempts",
        "allow_parameter_tuning",
        "allow_route_change",
        "allow_api_retry",
    }
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ValueError(f"unsupported transparency.llm_assisted option: {unknown[0]}")
    attempts = value.get("max_attempts", 2)
    if isinstance(attempts, bool) or not isinstance(attempts, int) or not 1 <= attempts <= 3:
        raise ValueError("auth.json transparency.llm_assisted.max_attempts must be an integer from 1 to 3")
    return LlmAssistedPolicy(
        enabled=_bool_option(value, "enabled", False),
        max_attempts=attempts,
        allow_parameter_tuning=_bool_option(value, "allow_parameter_tuning", True),
        allow_route_change=_bool_option(value, "allow_route_change", True),
        allow_api_retry=_bool_option(value, "allow_api_retry", False),
    )


def _bool_option(value: dict[str, Any], name: str, default: bool) -> bool:
    selected = value.get(name, default)
    if not isinstance(selected, bool):
        raise ValueError(f"auth.json transparency.llm_assisted.{name} must be boolean")
    return selected


def normalize_route_options(route: str, value: Any) -> dict[str, Any]:
    if value in (None, {}):
        return {}
    if not isinstance(value, dict):
        raise ValueError("transparency options must be an object")
    specs: dict[str, dict[str, tuple[str, float, float] | tuple[str, tuple[str, ...]]]] = {
        "chroma-matting": {
            "background_scope": ("enum", ("edge-connected", "global")),
            "inner_tolerance": ("number", 1.0, 200.0),
            "outer_tolerance": ("number", 2.0, 300.0),
            "despill_strength": ("number", 0.0, 1.0),
            "border_hard_coverage": ("number", 0.0, 1.0),
            "border_soft_coverage": ("number", 0.0, 1.0),
            "expand": ("integer", -16.0, 16.0),
            "feather": ("integer", 0.0, 16.0),
            "min_component_area": ("integer", 0.0, 65536.0),
            "defringe_radius": ("integer", 0.0, 16.0),
        },
        "emissive-alpha": {
            "black_point": ("number", 0.0, 254.0),
            "white_point": ("number", 1.0, 255.0),
            "gamma": ("number", 0.25, 4.0),
            "border_dark_tolerance": ("number", 0.0, 128.0),
            "min_border_dark_coverage": ("number", 0.5, 1.0),
        },
        "mask-alpha": {
            "source": ("enum", ("auto", "alpha", "luminance", "red", "green", "blue")),
            "invert": ("bool", ()),
            "gamma": ("number", 0.25, 4.0),
            "threshold": ("number", 0.0, 255.0),
            "feather": ("integer", 0.0, 16.0),
            "expand": ("integer", -16.0, 16.0),
            "min_component_area": ("integer", 0.0, 65536.0),
            "matte": ("enum", ("none", "black", "white")),
            "defringe_radius": ("integer", 0.0, 16.0),
        },
    }
    route_specs = specs.get(route, {})
    normalized: dict[str, Any] = {}
    for name, raw in value.items():
        spec = route_specs.get(name)
        if spec is None:
            raise ValueError(f"unsupported transparency option for {route}: {name}")
        kind = spec[0]
        if kind == "bool":
            if not isinstance(raw, bool):
                raise ValueError(f"transparency option {name} must be boolean")
            normalized[name] = raw
            continue
        if kind == "enum":
            selected = str(raw).strip().lower()
            if selected not in spec[1]:
                raise ValueError(f"invalid transparency option {name}: {raw}")
            normalized[name] = selected
            continue
        if isinstance(raw, bool):
            raise ValueError(f"transparency option {name} must be numeric")
        try:
            number = float(raw)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"transparency option {name} must be numeric") from exc
        minimum = float(spec[1])
        maximum = float(spec[2])
        if not minimum <= number <= maximum:
            raise ValueError(f"transparency option {name} must be from {minimum:g} to {maximum:g}")
        if kind == "integer":
            if not number.is_integer():
                raise ValueError(f"transparency option {name} must be an integer")
            normalized[name] = int(number)
        else:
            normalized[name] = int(number) if number.is_integer() else number
    inner = float(normalized.get("inner_tolerance", FULL_TOLERANCE))
    outer = float(normalized.get("outer_tolerance", MATTE_OUTER_TOLERANCE))
    if route == "chroma-matting" and outer <= inner:
        raise ValueError("transparency option outer_tolerance must be greater than inner_tolerance")
    black = float(normalized.get("black_point", 8))
    white = float(normalized.get("white_point", 255))
    if route == "emissive-alpha" and white <= black:
        raise ValueError("transparency option white_point must be greater than black_point")
    return normalized


def parse_option_assignments(values: list[str] | None) -> dict[str, Any]:
    options: dict[str, Any] = {}
    for item in values or []:
        name, separator, raw = str(item).partition("=")
        name = name.strip()
        raw = raw.strip()
        if not separator or not name or not raw:
            raise ValueError(f"invalid transparency parameter: {item}")
        if name in options:
            raise ValueError(f"duplicate transparency parameter: {name}")
        try:
            options[name] = json.loads(raw)
        except json.JSONDecodeError:
            options[name] = raw
    return options


def resolve_plan(context: TransparencyContext, policy: TransparencyPolicy) -> TransparencyPlan:
    if not context.requested:
        return TransparencyPlan(
            mode="none",
            prompt=context.prompt,
            llm_assisted=policy.llm_assisted,
        )
    requested_route = str(context.route or "").strip().lower() or None
    if requested_route is not None and requested_route not in TRANSPARENCY_ROUTES:
        raise ValueError(f"unsupported transparency route: {requested_route}")
    route = requested_route
    if route is None:
        prompt_only_matches = _prompt_only_matches(context, policy)
        if policy.default_route == "native-alpha":
            route = "native-alpha"
        elif context.postprocess_allowed:
            route = policy.default_route
        elif prompt_only_matches:
            route = "prompt-alpha"
        else:
            return TransparencyPlan(
                mode=INSPECT_ALPHA_ROUTE,
                prompt=context.prompt,
                llm_assisted=policy.llm_assisted,
            )
    if route == "native-alpha":
        if not policy.native.enabled:
            raise TransparencyUnavailableError(
                "native-alpha transparency is disabled in configuration."
            )
        return TransparencyPlan(
            mode="native-alpha",
            prompt=_native_prompt(context.prompt),
            options={"native_parameter": "transparent"},
            llm_assisted=policy.llm_assisted,
            native_retry_without_parameter=policy.native.retry_without_parameter,
            native_fallback_route=policy.native.fallback_route,
        )
    if route in LOCAL_ROUTES:
        if not context.postprocess_allowed:
            raise TransparencyUnavailableError(
                f"transparent delivery route {route} requires local post-processing. No image request was sent."
            )
        if route == "mask-alpha" and context.mask_path is None:
            raise TransparencyUnavailableError(
                "mask-alpha requires an explicit transparency mask. No image request was sent."
            )
        options = normalize_route_options(route, context.options)
        if route == "emissive-alpha":
            return TransparencyPlan(
                mode=route,
                prompt=_emissive_prompt(context.prompt),
                options=options,
                llm_assisted=policy.llm_assisted,
            )
        if route == "mask-alpha":
            return TransparencyPlan(
                mode=route,
                prompt=_mask_prompt(context.prompt),
                mask_path=context.mask_path.expanduser().resolve(),
                options=options,
                llm_assisted=policy.llm_assisted,
            )
        key_hex = _select_key(context.prompt, context.reference_paths)
        return TransparencyPlan(
            mode=route,
            prompt=_chroma_prompt(context.prompt, key_hex),
            key_hex=key_hex,
            options=options,
            llm_assisted=policy.llm_assisted,
        )
    if _prompt_only_matches(context, policy):
        return TransparencyPlan(
            mode="prompt-alpha",
            prompt=_alpha_prompt(context.prompt),
            llm_assisted=policy.llm_assisted,
        )
    return TransparencyPlan(
        mode=INSPECT_ALPHA_ROUTE,
        prompt=context.prompt,
        llm_assisted=policy.llm_assisted,
    )


def _prompt_only_matches(context: TransparencyContext, policy: TransparencyPolicy) -> bool:
    normalized_size = context.size.strip().lower()
    return any(
        rule.model == context.model and rule.mode == context.mode and rule.size == normalized_size
        for rule in policy.prompt_only_allow
    )


def process_file(source: Path, target: Path, plan: TransparencyPlan) -> dict[str, Any]:
    source = source.expanduser().resolve()
    target = target.expanduser().resolve()
    if plan.mode == "none":
        _copy_exact(source, target)
        return _result(source, target, plan, "not_requested", {}, [])
    try:
        image = read_png_rgba(source)
        pixel_count = image["width"] * image["height"]
        if pixel_count > MAX_TRANSPARENCY_PIXELS:
            _copy_exact(source, target)
            return _result(
                source,
                target,
                plan,
                "unmet",
                {
                    "status": "unmet",
                    "width": image["width"],
                    "height": image["height"],
                    "pixels": pixel_count,
                    "max_pixels": MAX_TRANSPARENCY_PIXELS,
                },
                ["transparency_pixel_limit: local transparency processing was skipped; returned the original image"],
            )
        source_check = _assess(image["pixels"], image["width"], image["height"])
    except (OSError, ValueError) as exc:
        _copy_exact(source, target)
        return _result(
            source,
            target,
            plan,
            "unmet",
            {},
            [f"local_transparency_check_unavailable: {exc}; returned the original image"],
        )

    if source_check["status"] == "pass":
        _copy_exact(source, target)
        return _result(source, target, plan, "pass", source_check, [])

    if plan.mode in {"prompt-alpha", "native-alpha", INSPECT_ALPHA_ROUTE}:
        _copy_exact(source, target)
        warning = (
            "alpha_prompt_unmet: the returned image has no usable transparent background; "
            "returned the original image"
            if plan.mode in {"prompt-alpha", "native-alpha"}
            else "source_alpha_unmet: local transparency processing was disabled and the returned image "
            "has no usable transparent background; returned the original image"
        )
        return _result(
            source,
            target,
            plan,
            "unmet",
            source_check,
            [warning],
        )

    if plan.mode == "emissive-alpha":
        try:
            output, route_checks = process_emissive_alpha(
                image["pixels"], image["width"], image["height"], plan.options
            )
        except EmissiveAlphaError as exc:
            checks = dict(source_check)
            checks.update(exc.checks)
            _copy_exact(source, target)
            return _result(
                source,
                target,
                plan,
                "unmet",
                checks,
                [f"{exc.code}: emissive alpha requires a dark edge-connected background; returned the original image"],
            )
        output_check = _assess(output, image["width"], image["height"])
        output_check.update(route_checks)
        output_check["alpha_pipeline"]["contrast_review_contract"] = (
            _contrast_review_contract(output_check["status"], "edge-alpha")
        )
        if output_check["status"] != "pass":
            _copy_exact(source, target)
            return _result(
                source,
                target,
                plan,
                "unmet",
                output_check,
                ["transparent_qa_unmet: emissive alpha output did not meet the transparency checks; returned the original image"],
            )
        write_png_rgba(target, image["width"], image["height"], output)
        return _result(source, target, plan, "pass", output_check, [], changed=True)

    if plan.mode == "mask-alpha":
        if plan.mask_path is None:
            _copy_exact(source, target)
            return _result(
                source,
                target,
                plan,
                "unmet",
                source_check,
                ["mask_required: mask alpha requires an explicit transparency mask; returned the original image"],
            )
        try:
            output, route_checks = process_mask_alpha(
                image["pixels"], image["width"], image["height"], plan.mask_path, plan.options
            )
        except MaskAlphaError as exc:
            checks = dict(source_check)
            checks.update(exc.checks)
            _copy_exact(source, target)
            return _result(
                source,
                target,
                plan,
                "unmet",
                checks,
                [f"{exc.code}: explicit transparency mask could not be applied; returned the original image"],
            )
        output_check = _assess(output, image["width"], image["height"])
        output_check.update(route_checks)
        output_check["alpha_pipeline"]["contrast_review_contract"] = (
            _contrast_review_contract(output_check["status"], "edge-alpha")
        )
        if output_check["status"] != "pass":
            _copy_exact(source, target)
            return _result(
                source,
                target,
                plan,
                "unmet",
                output_check,
                ["transparent_qa_unmet: mask alpha output did not meet the transparency checks; returned the original image"],
            )
        write_png_rgba(target, image["width"], image["height"], output)
        return _result(source, target, plan, "pass", output_check, [], changed=True)

    if plan.mode != "chroma-matting" or not plan.key_hex:
        _copy_exact(source, target)
        return _result(
            source,
            target,
            plan,
            "unmet",
            source_check,
            [f"unsupported_transparency_mode: {plan.mode}; returned the original image"],
        )

    try:
        options = normalize_route_options(plan.mode, plan.options)
        inner_tolerance = float(options.get("inner_tolerance", FULL_TOLERANCE))
        outer_tolerance = float(options.get("outer_tolerance", MATTE_OUTER_TOLERANCE))
        despill_strength = float(options.get("despill_strength", DESPILL_STRENGTH))
        minimum_hard_coverage = float(
            options.get("border_hard_coverage", MIN_BORDER_HARD_COVERAGE)
        )
        minimum_soft_coverage = float(
            options.get("border_soft_coverage", MIN_BORDER_SOFT_COVERAGE)
        )
        expand = int(options.get("expand", 0))
        feather = int(options.get("feather", 0))
        minimum_area = int(options.get("min_component_area", 0))
        background_scope = str(options.get("background_scope", "edge-connected"))
        defringe_radius = int(
            options.get(
                "defringe_radius",
                max(1, min(8, round(min(image["width"], image["height"]) / 512))),
            )
        )
        requested_key = _parse_key(plan.key_hex)
        effective_key = _estimate_key(
            image["pixels"],
            image["width"],
            image["height"],
            requested_key,
            outer_tolerance,
            minimum_soft_coverage,
        )
        border_check = _border_key_coverage(
            image["pixels"],
            image["width"],
            image["height"],
            effective_key,
            inner_tolerance,
        )
        border_check["requested_key"] = _format_key(requested_key)
        border_check["effective_key"] = _format_key(effective_key)
        if (
            border_check["hard_coverage"] < minimum_hard_coverage
            or border_check["soft_coverage"] < minimum_soft_coverage
        ):
            _copy_exact(source, target)
            checks = dict(source_check)
            checks["border_key"] = border_check
            return _result(
                source,
                target,
                plan,
                "unmet",
                checks,
                [
                    "background_not_solid: the canvas edge does not contain the requested solid key color; "
                    "returned the original image"
                ],
            )
        matte, matte_check = edge_connected_color_alpha(
            image["pixels"],
            image["width"],
            image["height"],
            effective_key,
            inner_tolerance,
            outer_tolerance,
            scope=background_scope,
        )
        matte, refinement_check = refine_alpha(
            matte,
            image["width"],
            image["height"],
            expand=expand,
            feather=feather,
            min_component_area=minimum_area,
        )
        keyed, cleanup_check = remove_matte_and_defringe(
            image["pixels"],
            matte,
            image["width"],
            image["height"],
            effective_key,
            tolerance=CONTAMINATION_TOLERANCE,
            defringe_radius=defringe_radius,
            strength=despill_strength,
        )
        output_check = _assess(
            keyed,
            image["width"],
            image["height"],
            key=effective_key,
            key_tolerance=CONTAMINATION_TOLERANCE,
        )
        output_check["border_key"] = border_check
        output_check["alpha_pipeline"] = {
            "background_profile": {
                "requested_key": _format_key(requested_key),
                "effective_key": _format_key(effective_key),
                "hard_coverage": border_check["hard_coverage"],
                "soft_coverage": border_check["soft_coverage"],
            },
            "matte": matte_check,
            "refinement": refinement_check,
            "matte_cleanup": cleanup_check,
            "defringe": cleanup_check["defringe"],
            "contrast_review_contract": _contrast_review_contract(
                output_check["status"],
                "edge-alpha-and-key-contamination",
            ),
        }
        output_check["options"] = {
            "inner_tolerance": inner_tolerance,
            "outer_tolerance": outer_tolerance,
            "background_scope": background_scope,
            "despill_strength": despill_strength,
            "contamination_tolerance": CONTAMINATION_TOLERANCE,
            "border_hard_coverage": minimum_hard_coverage,
            "border_soft_coverage": minimum_soft_coverage,
            "expand": expand,
            "feather": feather,
            "min_component_area": minimum_area,
            "defringe_radius": defringe_radius,
        }
        if output_check["status"] != "pass":
            _copy_exact(source, target)
            return _result(
                source,
                target,
                plan,
                "unmet",
                output_check,
                ["transparent_qa_unmet: chroma-matting output did not meet the transparency checks; returned the original image"],
            )
        write_png_rgba(target, image["width"], image["height"], keyed)
        return _result(source, target, plan, "pass", output_check, [], changed=True)
    except (OSError, ValueError) as exc:
        _copy_exact(source, target)
        return _result(
            source,
            target,
            plan,
            "unmet",
            source_check,
            [f"chroma_matting_unavailable: {exc}; returned the original image"],
        )


def output_path(source: Path, out_dir: str | Path | None = None) -> Path:
    source = source.expanduser().resolve()
    root = Path(out_dir).expanduser().resolve() if out_dir else source.parent / f"{source.stem}-postprocess"
    return root / f"{source.stem}-transparent.png"


def unmet_result(source: Path, plan: TransparencyPlan, warning: str) -> dict[str, Any]:
    source = source.expanduser().resolve()
    return _result(source, source, plan, "unmet", {}, [warning])


def _select_key(prompt: str, reference_paths: tuple[Path, ...]) -> str:
    prompt_scores = [_prompt_conflicts(prompt, terms) for _, _, terms in KEY_CANDIDATES]
    reference_scores = _reference_color_ratios(reference_paths)
    winner = min(
        range(len(KEY_CANDIDATES)),
        key=lambda index: (prompt_scores[index], reference_scores[index], index),
    )
    return KEY_CANDIDATES[winner][0]


def _prompt_conflicts(prompt: str, terms: tuple[str, ...]) -> int:
    lowered = prompt.lower()
    count = 0
    for term in terms:
        if term.isascii():
            count += len(re.findall(rf"\b{re.escape(term)}\b", lowered))
        else:
            count += lowered.count(term)
    return count


def _reference_color_ratios(paths: tuple[Path, ...]) -> list[float]:
    matches = [0] * len(KEY_CANDIDATES)
    sampled = 0
    threshold = REFERENCE_NEAR_TOLERANCE * REFERENCE_NEAR_TOLERANCE
    for path in paths:
        try:
            image = read_png_rgba(path)
        except (OSError, ValueError):
            continue
        total = image["width"] * image["height"]
        step = max(1, math.ceil(total / 4096))
        for index in range(0, total, step):
            red, green, blue, alpha = image["pixels"][index]
            if alpha < 24:
                continue
            sampled += 1
            for candidate_index, (_, key, _) in enumerate(KEY_CANDIDATES):
                if _distance_squared((red, green, blue), key) <= threshold:
                    matches[candidate_index] += 1
    if not sampled:
        return [0.0] * len(KEY_CANDIDATES)
    return [value / sampled for value in matches]


def _chroma_prompt(prompt: str, key_hex: str) -> str:
    return (
        f"{prompt}\n\n"
        "Transparency processing contract: render the requested subject fully visible and isolated against "
        f"one uniform flat {key_hex} background. The entire background must be exactly {key_hex}, with no "
        "gradient, texture, lighting, shadow, glow, checkerboard, floor, scenery, or border. Do not use the "
        "key color on the subject, text, outline, reflections, or antialiased subject edge. Keep clear color "
        "separation and a clean margin around the subject."
    )


def _alpha_prompt(prompt: str) -> str:
    return (
        f"{prompt}\n\n"
        "Transparency delivery contract: output a PNG with a real alpha channel. Every pixel outside the "
        "requested subject must have alpha 0, not a white, black, colored, or checkerboard background. Keep "
        "only the requested subject and preserve antialiased partially transparent edge pixels. No floor, "
        "backdrop, cast shadow, glow, or ambient background. The final image must contain a real alpha channel."
    )


def _native_prompt(prompt: str) -> str:
    return (
        f"{prompt}\n\n"
        "Native transparency contract: output an isolated subject with a real alpha channel on a genuinely transparent background. "
        "Every pixel outside the requested subject must be fully transparent. No scenery, backdrop, floor, "
        "frame, checkerboard, cast shadow, glow, or watermark. Preserve clean antialiased subject edges."
    )


def _emissive_prompt(prompt: str) -> str:
    return (
        f"{prompt}\n\n"
        "Transparency processing contract: render only the requested emissive particles, fire, lightning, "
        "smoke, or glow on one uniform pure black #000000 background. Keep the canvas edge pure black. "
        "Preserve soft light falloff and separate particle clusters. Do not add scenery, floor, frame, text, "
        "ambient lighting, or a nonblack backdrop."
    )


def _mask_prompt(prompt: str) -> str:
    return (
        f"{prompt}\n\n"
        "Transparency mask contract: keep the requested subject fully visible, isolated, and aligned to the "
        "supplied delivery mask. Do not add objects, cast shadows, glow, or content outside the subject bounds."
    )


def _assess(
    pixels: Any,
    width: int,
    height: int,
    key: tuple[int, int, int] | None = None,
    key_tolerance: float = CONTAMINATION_TOLERANCE,
) -> dict[str, Any]:
    total = width * height
    transparent = 0
    visible = 0
    packed = pixels.packed() if isinstance(pixels, PixelBuffer) else None
    alpha_values = packed[3::4] if packed is not None else (pixel[3] for pixel in pixels)
    for alpha in alpha_values:
        transparent += alpha <= 8
        visible += alpha >= 24
    border = _border_indices(width, height)
    visible_border = sum(
        1
        for index in border
        if (packed[index * 4 + 3] if packed is not None else pixels[index][3]) >= 24
    )
    transparent_ratio = transparent / total
    visible_ratio = visible / total
    visible_border_ratio = visible_border / len(border)
    failures: list[str] = []
    if transparent_ratio < MIN_TRANSPARENT_RATIO:
        failures.append("transparent_pixel_ratio")
    if visible_ratio < MIN_VISIBLE_RATIO:
        failures.append("visible_pixel_ratio")
    if visible_border_ratio > MAX_VISIBLE_BORDER_RATIO:
        failures.append("visible_border_ratio")
    result: dict[str, Any] = {
        "status": "pass" if not failures else "unmet",
        "transparent_pixel_ratio": round(transparent_ratio, 6),
        "visible_pixel_ratio": round(visible_ratio, 6),
        "visible_border_ratio": round(visible_border_ratio, 6),
        "failures": failures,
    }
    if key is not None:
        contamination = _key_contamination(pixels, width, height, key, key_tolerance)
        result["key_contamination"] = contamination
        if contamination["status"] != "pass":
            failures.append("key_contamination")
            result["status"] = "unmet"
    return result


def _border_key_coverage(
    pixels: Any,
    width: int,
    height: int,
    key: tuple[int, int, int],
    inner_tolerance: float = FULL_TOLERANCE,
) -> dict[str, float]:
    border = _border_indices(width, height)
    hard_limit = inner_tolerance * inner_tolerance
    soft_limit = BORDER_SOFT_TOLERANCE * BORDER_SOFT_TOLERANCE
    hard = soft = 0
    for index in border:
        red, green, blue, _ = pixels[index]
        distance = _distance_squared((red, green, blue), key)
        hard += distance <= hard_limit
        soft += distance <= soft_limit
    return {
        "hard_coverage": round(hard / len(border), 6),
        "soft_coverage": round(soft / len(border), 6),
    }


def _estimate_key(
    pixels: Any,
    width: int,
    height: int,
    requested_key: tuple[int, int, int],
    outer_tolerance: float = MATTE_OUTER_TOLERANCE,
    minimum_coverage: float = MIN_BORDER_SOFT_COVERAGE,
) -> tuple[int, int, int]:
    border = _border_indices(width, height)
    limit = outer_tolerance * outer_tolerance
    samples = [
        pixels[index][:3]
        for index in border
        if _distance_squared(pixels[index][:3], requested_key) <= limit
    ]
    if len(samples) / max(1, len(border)) < minimum_coverage:
        return requested_key
    return tuple(
        sorted(sample[channel] for sample in samples)[len(samples) // 2]
        for channel in range(3)
    )


def _key_contamination(
    pixels: Any,
    width: int,
    height: int,
    key: tuple[int, int, int],
    tolerance: float = CONTAMINATION_TOLERANCE,
) -> dict[str, Any]:
    total = width * height
    tested = 0
    contaminated = 0
    direct_pixels = 0
    spill_pixels = 0
    limit = tolerance * tolerance
    packed = pixels.packed() if isinstance(pixels, PixelBuffer) else None
    key_red, key_green, key_blue = key
    for index in range(total):
        offset = index * 4
        if packed is not None:
            red = packed[offset]
            green = packed[offset + 1]
            blue = packed[offset + 2]
            alpha = packed[offset + 3]
        else:
            red, green, blue, alpha = pixels[index]
        if alpha < 24:
            continue
        partial = alpha < 250
        adjacent_to_transparent = False
        x = index % width
        y = index // width
        for dx, dy in (
            (-1, -1),
            (0, -1),
            (1, -1),
            (-1, 0),
            (1, 0),
            (-1, 1),
            (0, 1),
            (1, 1),
        ):
            nx = x + dx
            ny = y + dy
            if nx < 0 or nx >= width or ny < 0 or ny >= height:
                continue
            neighbor = ny * width + nx
            neighbor_alpha = packed[neighbor * 4 + 3] if packed is not None else pixels[neighbor][3]
            if neighbor_alpha <= 8:
                adjacent_to_transparent = True
                break
        if not partial and not adjacent_to_transparent:
            continue
        tested += 1
        direct_match = (
            (red - key_red) ** 2
            + (green - key_green) ** 2
            + (blue - key_blue) ** 2
            <= limit
        )
        spill_match = key_spill_score(red, green, blue, key) >= KEY_SPILL_THRESHOLD
        direct_pixels += direct_match
        spill_pixels += spill_match
        contaminated += direct_match or spill_match
    allowed = max(MIN_KEY_CONTAMINATION_PIXELS, round(tested * MAX_KEY_CONTAMINATION_RATIO))
    return {
        "status": "pass" if contaminated <= allowed else "unmet",
        "pixels": contaminated,
        "direct_pixels": direct_pixels,
        "spill_pixels": spill_pixels,
        "tested_pixels": tested,
        "ratio": round(contaminated / max(1, tested), 6),
        "allowed_pixels": allowed,
        "tolerance": tolerance,
        "spill_threshold": KEY_SPILL_THRESHOLD,
    }


def _contrast_review_contract(status: str, automated_signal: str) -> dict[str, Any]:
    return {
        "status": status,
        "backgrounds": ["black", "white", "gray", "checker"],
        "automated_signal": automated_signal,
        "preview_required": True,
    }


def _border_indices(width: int, height: int) -> list[int]:
    indices = list(range(width))
    if height > 1:
        indices.extend(range((height - 1) * width, height * width))
    for y in range(1, height - 1):
        indices.append(y * width)
        if width > 1:
            indices.append(y * width + width - 1)
    return indices


def _parse_key(value: str) -> tuple[int, int, int]:
    normalized = value.strip().lstrip("#")
    if len(normalized) != 6:
        raise ValueError(f"invalid chroma key: {value}")
    try:
        red = int(normalized[0:2], 16)
        green = int(normalized[2:4], 16)
        blue = int(normalized[4:6], 16)
        return red, green, blue
    except ValueError as exc:
        raise ValueError(f"invalid chroma key: {value}") from exc


def _format_key(value: tuple[int, int, int]) -> str:
    return "#" + "".join(f"{channel:02X}" for channel in value)


def _distance_squared(color: tuple[int, int, int], key: tuple[int, int, int]) -> int:
    return sum((color[index] - key[index]) ** 2 for index in range(3))


def _valid_size(value: str) -> bool:
    parts = value.replace("*", "x").split("x", 1)
    if len(parts) != 2:
        return False
    try:
        return int(parts[0]) > 0 and int(parts[1]) > 0
    except ValueError:
        return False


def _copy_exact(source: Path, target: Path) -> None:
    if source == target:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def _result(
    source: Path,
    target: Path,
    plan: TransparencyPlan,
    status: str,
    checks: dict[str, Any],
    warnings: list[str],
    changed: bool = False,
) -> dict[str, Any]:
    return {
        "requested": plan.mode != "none",
        "mode": plan.mode,
        "key": plan.key_hex,
        "status": status,
        "delivery_ready": status == "pass",
        "source": source.as_posix(),
        "file": target.as_posix(),
        "changed": changed,
        "checks": checks,
        "warnings": warnings,
    }
