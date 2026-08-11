"""Deterministic alpha composition from an explicit PNG mask."""

from __future__ import annotations

from collections import deque
from pathlib import Path
from typing import Any

from image_png import PixelBuffer, read_png_rgba


class MaskAlphaError(ValueError):
    def __init__(self, code: str, checks: dict[str, Any]) -> None:
        super().__init__(code)
        self.code = code
        self.checks = checks


def process(
    pixels: Any,
    width: int,
    height: int,
    mask_path: Path,
    options: dict[str, Any] | None = None,
) -> tuple[PixelBuffer, dict[str, Any]]:
    options = options or {}
    mask_path = mask_path.expanduser().resolve()
    try:
        mask = read_png_rgba(mask_path)
    except (OSError, ValueError) as exc:
        raise MaskAlphaError(
            "mask_unavailable",
            {"profile": "mask", "mask": mask_path.as_posix(), "error": str(exc)},
        ) from exc
    checks: dict[str, Any] = {
        "profile": "mask",
        "mask": mask_path.as_posix(),
        "source_size": [width, height],
        "mask_size": [mask["width"], mask["height"]],
    }
    if mask["width"] != width or mask["height"] != height:
        raise MaskAlphaError("mask_dimensions_mismatch", checks)

    mask_pixels = mask["pixels"]
    source_mode = str(options.get("source", "auto"))
    use_alpha = source_mode == "alpha" or (
        source_mode == "auto" and any(pixel[3] < 255 for pixel in mask_pixels)
    )
    checks["alpha_source"] = "alpha" if use_alpha else "luminance"
    mask_values = bytearray(width * height)
    for index, mask_pixel in enumerate(mask_pixels):
        if use_alpha:
            value = mask_pixel[3]
        else:
            value = (
                54 * mask_pixel[0] + 183 * mask_pixel[1] + 19 * mask_pixel[2] + 128
            ) // 256
        mask_values[index] = 255 - value if options.get("invert", False) else value
    threshold = options.get("threshold")
    if threshold is not None:
        threshold = float(threshold)
        for index, value in enumerate(mask_values):
            mask_values[index] = 255 if value >= threshold else 0
    expand = int(options.get("expand", 0))
    if expand:
        mask_values = _extreme_filter(
            mask_values,
            width,
            height,
            abs(expand),
            maximum=expand > 0,
        )
    feather = int(options.get("feather", 0))
    if feather:
        mask_values = _box_blur(mask_values, width, height, feather)
    gamma = float(options.get("gamma", 1.0))
    if gamma != 1.0:
        for index, value in enumerate(mask_values):
            mask_values[index] = round(255 * ((value / 255) ** gamma))
    checks["options"] = {
        "source": source_mode,
        "invert": bool(options.get("invert", False)),
        "gamma": gamma,
        "threshold": threshold,
        "feather": feather,
        "expand": expand,
    }
    packed = pixels.packed() if isinstance(pixels, PixelBuffer) else bytes(
        channel for pixel in pixels for channel in pixel
    )
    output = bytearray(packed)
    for index, mask_alpha in enumerate(mask_values):
        offset = index * 4
        alpha = min(output[offset + 3], mask_alpha)
        if alpha <= 0:
            output[offset : offset + 4] = b"\x00\x00\x00\x00"
        else:
            output[offset + 3] = alpha
    return PixelBuffer(output), checks


def _extreme_filter(
    values: bytearray,
    width: int,
    height: int,
    radius: int,
    maximum: bool,
) -> bytearray:
    horizontal = bytearray(len(values))
    for y in range(height):
        row = y * width
        queue: deque[int] = deque()
        right = -1
        for center in range(width):
            target_right = min(width - 1, center + radius)
            while right < target_right:
                right += 1
                while queue and _dominates(values[row + right], values[row + queue[-1]], maximum):
                    queue.pop()
                queue.append(right)
            left = max(0, center - radius)
            while queue and queue[0] < left:
                queue.popleft()
            horizontal[row + center] = values[row + queue[0]]

    output = bytearray(len(values))
    for x in range(width):
        queue = deque()
        bottom = -1
        for center in range(height):
            target_bottom = min(height - 1, center + radius)
            while bottom < target_bottom:
                bottom += 1
                while queue and _dominates(
                    horizontal[bottom * width + x],
                    horizontal[queue[-1] * width + x],
                    maximum,
                ):
                    queue.pop()
                queue.append(bottom)
            top = max(0, center - radius)
            while queue and queue[0] < top:
                queue.popleft()
            output[center * width + x] = horizontal[queue[0] * width + x]
    return output


def _dominates(left: int, right: int, maximum: bool) -> bool:
    return left >= right if maximum else left <= right


def _box_blur(values: bytearray, width: int, height: int, radius: int) -> bytearray:
    horizontal = bytearray(len(values))
    for y in range(height):
        row = y * width
        total = sum(values[row : row + min(width, radius + 1)])
        for x in range(width):
            left = max(0, x - radius)
            right = min(width - 1, x + radius)
            if x > 0:
                previous_left = max(0, x - 1 - radius)
                previous_right = min(width - 1, x - 1 + radius)
                if left > previous_left:
                    total -= values[row + previous_left]
                if right > previous_right:
                    total += values[row + right]
            horizontal[row + x] = round(total / (right - left + 1))

    output = bytearray(len(values))
    for x in range(width):
        total = sum(horizontal[y * width + x] for y in range(min(height, radius + 1)))
        for y in range(height):
            top = max(0, y - radius)
            bottom = min(height - 1, y + radius)
            if y > 0:
                previous_top = max(0, y - 1 - radius)
                previous_bottom = min(height - 1, y - 1 + radius)
                if top > previous_top:
                    total -= horizontal[previous_top * width + x]
                if bottom > previous_bottom:
                    total += horizontal[bottom * width + x]
            output[y * width + x] = round(total / (bottom - top + 1))
    return output
