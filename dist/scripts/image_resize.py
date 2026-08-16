"""Dependency-free image resizing helpers for RGBA pixel buffers."""

from __future__ import annotations

from collections.abc import Sequence
import math

from image_png import MAX_PNG_PIXELS, PixelBuffer


Pixel = tuple[int, int, int, int]


def resize_pixels(
    pixels: Sequence[Pixel],
    source_w: int,
    source_h: int,
    target_w: int,
    target_h: int,
    resample: str = "bilinear",
) -> PixelBuffer:
    if source_w < 1 or source_h < 1 or target_w < 1 or target_h < 1:
        raise ValueError("image dimensions must be positive")
    if source_w * source_h > MAX_PNG_PIXELS or target_w * target_h > MAX_PNG_PIXELS:
        raise ValueError("image dimensions exceed the local processing limit")
    if len(pixels) != source_w * source_h:
        raise ValueError("pixel count does not match image dimensions")
    if resample == "nearest":
        output = bytearray()
        for y in range(target_h):
            source_y = min(source_h - 1, (y * source_h) // target_h)
            for x in range(target_w):
                source_x = min(source_w - 1, (x * source_w) // target_w)
                output.extend(pixels[source_y * source_w + source_x])
        return PixelBuffer(output)
    if resample != "bilinear":
        raise ValueError(f"unsupported resample method: {resample}")

    output = bytearray()
    for y in range(target_h):
        source_y = max(0.0, min(source_h - 1.0, (y + 0.5) * source_h / target_h - 0.5))
        y0 = math.floor(source_y)
        y1 = max(0, min(source_h - 1, y0 + 1))
        fy = source_y - y0
        for x in range(target_w):
            source_x = max(0.0, min(source_w - 1.0, (x + 0.5) * source_w / target_w - 0.5))
            x0 = math.floor(source_x)
            x1 = max(0, min(source_w - 1, x0 + 1))
            fx = source_x - x0
            top_left = pixels[y0 * source_w + x0]
            top_right = pixels[y0 * source_w + x1]
            bottom_left = pixels[y1 * source_w + x0]
            bottom_right = pixels[y1 * source_w + x1]
            output.extend(_bilinear_pixel(top_left, top_right, bottom_left, bottom_right, fx, fy))
    return PixelBuffer(output)


def fit_to_canvas(
    pixels: Sequence[Pixel],
    source_w: int,
    source_h: int,
    target_w: int,
    target_h: int,
    resample: str = "bilinear",
    safe_margin: float = 0.0,
    background: Pixel = (0, 0, 0, 0),
) -> PixelBuffer:
    if source_w < 1 or source_h < 1 or target_w < 1 or target_h < 1:
        raise ValueError("image dimensions must be positive")
    if source_w * source_h > MAX_PNG_PIXELS or target_w * target_h > MAX_PNG_PIXELS:
        raise ValueError("image dimensions exceed the local processing limit")
    if len(pixels) != source_w * source_h:
        raise ValueError("pixel count does not match image dimensions")
    if not 0 <= safe_margin < 0.5:
        raise ValueError("safe_margin must be between 0 and 0.5")
    margin_x = min(target_w // 2 - 1 if target_w > 2 else 0, round(target_w * safe_margin))
    margin_y = min(target_h // 2 - 1 if target_h > 2 else 0, round(target_h * safe_margin))
    inner_w = max(1, target_w - margin_x * 2)
    inner_h = max(1, target_h - margin_y * 2)
    scale = min(inner_w / source_w, inner_h / source_h)
    scaled_w = max(1, int(round(source_w * scale)))
    scaled_h = max(1, int(round(source_h * scale)))
    scaled = resize_pixels(pixels, source_w, source_h, scaled_w, scaled_h, resample)
    canvas = bytearray(bytes(background) * (target_w * target_h))
    offset_x = margin_x + (inner_w - scaled_w) // 2
    offset_y = margin_y + (inner_h - scaled_h) // 2
    packed = scaled.packed()
    row_bytes = scaled_w * 4
    for y in range(scaled_h):
        source_start = y * row_bytes
        target_start = ((offset_y + y) * target_w + offset_x) * 4
        canvas[target_start : target_start + row_bytes] = packed[source_start : source_start + row_bytes]
    return PixelBuffer(canvas)


def _bilinear_pixel(
    top_left: Pixel,
    top_right: Pixel,
    bottom_left: Pixel,
    bottom_right: Pixel,
    fx: float,
    fy: float,
) -> Pixel:
    weights = (
        (top_left, (1.0 - fx) * (1.0 - fy)),
        (top_right, fx * (1.0 - fy)),
        (bottom_left, (1.0 - fx) * fy),
        (bottom_right, fx * fy),
    )
    alpha = sum(pixel[3] * weight for pixel, weight in weights)
    if alpha <= 0:
        return (0, 0, 0, 0)
    channels = []
    for channel in range(3):
        premultiplied = sum(pixel[channel] * pixel[3] * weight for pixel, weight in weights)
        channels.append(max(0, min(255, round(premultiplied / alpha))))
    return (*channels, max(0, min(255, round(alpha))))
