"""Resolve image intent before protocol-specific payload construction."""

from __future__ import annotations

import re
from typing import Any

from native_image_protocols import NATIVE_PROTOCOLS, validate_options


DIMENSION_KEYS = frozenset({"size", "aspectRatio", "resolution"})
OPTION_KEYS = ("size", "aspectRatio", "resolution", "quality", "format", "background", "compression", "moderation")


def merge_dimensions(lower: dict[str, Any], higher: dict[str, Any], *, strict: bool) -> dict[str, Any]:
    selected = {key: value for key, value in higher.items() if value is not None}
    if strict and "size" in selected and ("aspectRatio" in selected or "resolution" in selected):
        raise ValueError("size conflicts with aspectRatio/resolution at the same priority")
    merged = dict(lower)
    if DIMENSION_KEYS.intersection(selected):
        if "size" in selected:
            merged.pop("aspectRatio", None)
            merged.pop("resolution", None)
        else:
            merged.pop("size", None)
    merged.update(selected)
    return merged


def resolve_request_options(cfg: Any, explicit: dict[str, Any]) -> dict[str, Any]:
    defaults = {("format" if key == "output_format" else "aspectRatio" if key in {"aspect_ratio", "aspect"} else key): value for key, value in cfg.defaults.items()}
    strict = getattr(cfg, "config_version", 1) == 2
    defaults = merge_dimensions({}, defaults, strict=strict)
    merged = merge_dimensions(defaults, explicit, strict=strict)
    options = {key: merged.get(key) for key in OPTION_KEYS}
    if options["format"] == "jpg":
        options["format"] = "jpeg"
    if isinstance(options["resolution"], str) and re.fullmatch(r"\d+[kK]", options["resolution"]):
        options["resolution"] = str(options["resolution"]).upper()
    if cfg.protocol in NATIVE_PROTOCOLS:
        validate_options(cfg.protocol, cfg.model, options)
    else:
        if options["aspectRatio"] is not None or options["resolution"] is not None:
            raise ValueError("this protocol requires size; aspectRatio/resolution are not native parameters")
        options["size"] = options["size"] or "1024x1024"
        options["format"] = options["format"] or "png"
        options["quality"] = options["quality"] or "medium"
        if not isinstance(options["size"], str) or not re.fullmatch(r"[1-9][0-9]*x[1-9][0-9]*", options["size"]):
            raise ValueError("invalid image size")
        if options["format"] not in {"png", "jpeg", "webp"}:
            raise ValueError("unsupported image format")
        qualities = {"low", "medium", "high"} if cfg.protocol == "atlas" else {"auto", "low", "medium", "high", "xhigh", "max"}
        if (cfg.protocol == "atlas" or not strict) and options["quality"] not in qualities:
            raise ValueError("unsupported image quality")
        if not isinstance(options["quality"], str) or not options["quality"].strip():
            raise ValueError("quality must be a non-empty string")
    return options
