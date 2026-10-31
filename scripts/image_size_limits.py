"""Declared pixel-size constraints, independent of providers and distributions."""

from __future__ import annotations

import math
import re
from typing import Any


SIZE_PATTERN = re.compile(r"[1-9][0-9]*x[1-9][0-9]*")
INTEGER_LIMITS = frozenset({"multiple_of", "min_edge", "max_edge", "min_pixels", "max_pixels"})
SIZE_LIMIT_KEYS = INTEGER_LIMITS | {"allowed_sizes", "max_aspect_ratio"}
MAX_SAFE_INTEGER = 9007199254740991


class ImageSizeError(ValueError):
    code = "image_size_unsupported"

    def __init__(self, size: str, constraint: str, limit: Any, message: str):
        super().__init__(message)
        self.details = {"size": size, "constraint": constraint, "limit": limit}


def validate_model_limits(limits: Any, protocol: str) -> None:
    if not isinstance(limits, dict) or set(limits) - {"max_input_images", "output_size"}:
        raise ValueError("invalid model limits")
    if "max_input_images" in limits and not _positive_integer(limits["max_input_images"]):
        raise ValueError("invalid maximum input images")
    if "output_size" not in limits:
        return
    size_limits = limits["output_size"]
    if not isinstance(size_limits, dict) or set(size_limits) - SIZE_LIMIT_KEYS:
        raise ValueError("invalid output size limits")
    if size_limits and protocol not in {"openai-compatible", "atlas"}:
        raise ValueError("output_size limits require a protocol with a pixel size field")
    for key in INTEGER_LIMITS:
        if key in size_limits and not _positive_integer(size_limits[key]):
            raise ValueError(f"invalid output size limit: {key}")
    if "max_aspect_ratio" in size_limits:
        ratio = size_limits["max_aspect_ratio"]
        if type(ratio) not in (int, float) or not 1 <= ratio <= MAX_SAFE_INTEGER or not math.isfinite(ratio):
            raise ValueError("invalid output size limit: max_aspect_ratio")
    for unit in ("edge", "pixels"):
        if size_limits.get(f"min_{unit}", 1) > size_limits.get(f"max_{unit}", MAX_SAFE_INTEGER):
            raise ValueError(f"minimum output {unit} exceeds maximum")
    if "allowed_sizes" in size_limits:
        sizes = size_limits["allowed_sizes"]
        if not isinstance(sizes, list) or not sizes:
            raise ValueError("allowed_sizes must be a non-empty array of pixel sizes")
        for size in sizes:
            if (not isinstance(size, str) or not SIZE_PATTERN.fullmatch(size)
                    or not all(_positive_integer(int(edge)) for edge in size.split("x"))):
                raise ValueError("invalid allowed output size")
            validate_request_size(size, limits)


def validate_request_size(size: Any, limits: dict[str, Any]) -> None:
    """Check a resolved pixel size without choosing or changing request intent."""
    rules = limits.get("output_size", {})
    if not rules or size is None or size == "auto":
        return
    if not isinstance(size, str) or not SIZE_PATTERN.fullmatch(size):
        raise ValueError("declared output_size limits require WIDTHxHEIGHT")
    width, height = map(int, size.split("x"))
    short, long = min(width, height), max(width, height)
    if "allowed_sizes" in rules and size not in rules["allowed_sizes"]:
        raise ImageSizeError(size, "allowed_sizes", rules["allowed_sizes"], f"生成尺寸 {size} 不在当前模型允许的尺寸中：{', '.join(rules['allowed_sizes'])}。")
    multiple = rules.get("multiple_of")
    if multiple and (width % multiple or height % multiple):
        raise ImageSizeError(size, "multiple_of", multiple, f"生成尺寸 {size} 的宽高必须都是 {multiple} 的倍数。")
    ratio = rules.get("max_aspect_ratio")
    if ratio is not None and long > short * ratio:
        raise ImageSizeError(size, "max_aspect_ratio", ratio, f"生成尺寸 {size} 的长短边比例为 {long / short:.2f}:1，当前模型允许最大 {ratio}:1。")
    for key, actual, below in (("min_edge", short, True), ("max_edge", long, False),
                               ("min_pixels", width * height, True), ("max_pixels", width * height, False)):
        limit = rules.get(key)
        if limit is not None and (actual < limit if below else actual > limit):
            label = "边长" if key.endswith("edge") else "像素总量"
            bound = "至少" if below else "最多"
            raise ImageSizeError(size, key, limit, f"生成尺寸 {size} 的{label}为 {actual}，当前模型要求{bound} {limit}。")


def _positive_integer(value: Any) -> bool:
    return type(value) in (int, float) and 1 <= value <= MAX_SAFE_INTEGER and int(value) == value
