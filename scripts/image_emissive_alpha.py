"""Deterministic black-background to alpha conversion for emissive artwork."""

from __future__ import annotations

from typing import Any

from image_png import PixelBuffer


BLACK_POINT = 8
WHITE_POINT = 255
BORDER_DARK_TOLERANCE = 24
MIN_BORDER_DARK_COVERAGE = 0.95


class EmissiveAlphaError(ValueError):
    def __init__(self, code: str, checks: dict[str, Any]) -> None:
        super().__init__(code)
        self.code = code
        self.checks = checks


def process(
    pixels: Any,
    width: int,
    height: int,
    options: dict[str, Any] | None = None,
) -> tuple[PixelBuffer, dict[str, Any]]:
    options = options or {}
    black_point = float(options.get("black_point", BLACK_POINT))
    white_point = float(options.get("white_point", WHITE_POINT))
    gamma = float(options.get("gamma", 1.0))
    border_tolerance = int(options.get("border_dark_tolerance", BORDER_DARK_TOLERANCE))
    minimum_border = float(options.get("min_border_dark_coverage", MIN_BORDER_DARK_COVERAGE))
    border = _border_indices(width, height)
    dark = sum(
        1
        for index in border
        if max(pixels[index][0], pixels[index][1], pixels[index][2]) <= border_tolerance
    )
    dark_coverage = dark / max(1, len(border))
    checks: dict[str, Any] = {
        "profile": "emissive",
        "component_gate": "not_applied",
        "options": {
            "black_point": black_point,
            "white_point": white_point,
            "gamma": gamma,
            "border_dark_tolerance": border_tolerance,
            "min_border_dark_coverage": minimum_border,
        },
        "border_dark": {
            "status": "pass" if dark_coverage >= minimum_border else "unmet",
            "coverage": round(dark_coverage, 6),
            "required": minimum_border,
            "tolerance": border_tolerance,
        },
    }
    if dark_coverage < minimum_border:
        raise EmissiveAlphaError("background_not_dark", checks)

    packed = pixels.packed() if isinstance(pixels, PixelBuffer) else bytes(
        channel for pixel in pixels for channel in pixel
    )
    output = bytearray(packed)
    scale = white_point - black_point
    for offset in range(0, len(output), 4):
        intensity = max(output[offset], output[offset + 1], output[offset + 2])
        normalized = max(0.0, min(1.0, (intensity - black_point) / scale)) ** gamma
        alpha = min(output[offset + 3], round(255 * normalized))
        if alpha <= 0:
            output[offset : offset + 4] = b"\x00\x00\x00\x00"
            continue
        output[offset + 3] = alpha
        for channel in range(3):
            output[offset + channel] = min(255, round(output[offset + channel] * 255 / alpha))
    return PixelBuffer(output), checks


def _border_indices(width: int, height: int) -> list[int]:
    indices = list(range(width))
    if height > 1:
        indices.extend(range((height - 1) * width, height * width))
    for y in range(1, height - 1):
        indices.append(y * width)
        if width > 1:
            indices.append(y * width + width - 1)
    return indices
