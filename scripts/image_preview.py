"""Preview rendering helpers for delivery-size and background checks."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Sequence

from image_png import MAX_PNG_PIXELS, PixelBuffer, read_png_rgba, write_png_rgba
from image_qa import sha256_file


Pixel = tuple[int, int, int, int]
BACKGROUND_NAMES = {"transparent", "white", "black", "gray", "checker"}
MAX_PREVIEW_TOTAL_PIXELS = 50_000_000
BOARD_GAP = 8


def preview_board_image(
    source: Path,
    out_dir: Path,
    sizes: list[tuple[int, int]],
    backgrounds: list[str],
    resample: str,
) -> dict[str, Any]:
    sizes, backgrounds, board_w, board_h = validate_preview_plan(sizes, backgrounds)
    image = read_png_rgba(source)
    out_dir.mkdir(parents=True, exist_ok=True)
    board = bytearray(bytes((32, 32, 32, 255)) * (board_w * board_h))
    preview_records: list[dict[str, Any]] = []
    cell_w = max(width for width, _ in sizes)
    cell_h = max(height for _, height in sizes)
    for row, background_name in enumerate(backgrounds):
        for col, (width, height) in enumerate(sizes):
            scaled = _fit_pixels(
                image["pixels"],
                image["width"],
                image["height"],
                width,
                height,
                resample=resample,
                safe_margin=0.0,
            )
            preview = composite_pixels(make_background(width, height, background_name), scaled)
            target = out_dir / f"{source.stem}-{width}x{height}-{background_name}.png"
            write_png_rgba(target, width, height, preview)
            offset_x = BOARD_GAP + col * cell_w + (cell_w - width) // 2
            offset_y = BOARD_GAP + row * cell_h + (cell_h - height) // 2
            paste_pixels(board, board_w, board_h, preview, width, height, offset_x, offset_y)
            preview_records.append(
                {
                    "row": row + 1,
                    "col": col + 1,
                    "size": [width, height],
                    "background": background_name,
                    "file": target.resolve().as_posix(),
                }
            )
    board_path = out_dir / f"{source.stem}-preview-board.png"
    write_png_rgba(board_path, board_w, board_h, PixelBuffer(board))
    manifest_path = out_dir / "preview-manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "source": source.resolve().as_posix(),
                "source_sha256": sha256_file(source),
                "resample": resample,
                "board": board_path.resolve().as_posix(),
                "previews": preview_records,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return {
        "source": source.resolve().as_posix(),
        "count": len(preview_records),
        "board": board_path.resolve().as_posix(),
        "manifest": manifest_path.resolve().as_posix(),
        "previews": preview_records,
    }


def _fit_pixels(
    pixels: list[Pixel],
    source_w: int,
    source_h: int,
    target_w: int,
    target_h: int,
    resample: str,
    safe_margin: float,
) -> list[Pixel]:
    from image_resize import fit_to_canvas

    return fit_to_canvas(
        pixels,
        source_w,
        source_h,
        target_w,
        target_h,
        resample=resample,
        safe_margin=safe_margin,
    )


def render_preview_matrix(
    pixels: Sequence[Pixel],
    source_w: int,
    source_h: int,
    sizes: list[tuple[int, int]],
    backgrounds: list[str],
    fit_fn: Callable[..., list[Pixel]],
    resample: str,
) -> tuple[list[dict[str, Any]], int, int, PixelBuffer]:
    sizes, backgrounds, board_w, board_h = validate_preview_plan(sizes, backgrounds)
    cell_w = max(width for width, _ in sizes)
    cell_h = max(height for _, height in sizes)
    board = bytearray(bytes((32, 32, 32, 255)) * (board_w * board_h))
    previews: list[dict[str, Any]] = []
    for row, background_name in enumerate(backgrounds):
        for col, (target_w, target_h) in enumerate(sizes):
            scaled = fit_fn(
                pixels,
                source_w,
                source_h,
                target_w,
                target_h,
                resample=resample,
                safe_margin=0.0,
            )
            background = make_background(target_w, target_h, background_name)
            preview = composite_pixels(background, scaled)
            previews.append(
                {
                    "row": row + 1,
                    "col": col + 1,
                    "size": [target_w, target_h],
                    "background": background_name,
                    "pixels": preview,
                }
            )
            offset_x = BOARD_GAP + col * cell_w + (cell_w - target_w) // 2
            offset_y = BOARD_GAP + row * cell_h + (cell_h - target_h) // 2
            paste_pixels(board, board_w, board_h, preview, target_w, target_h, offset_x, offset_y)
    return previews, board_w, board_h, PixelBuffer(board)


def validate_preview_plan(
    sizes: list[tuple[int, int]],
    backgrounds: list[str],
) -> tuple[list[tuple[int, int]], list[str], int, int]:
    sizes = list(dict.fromkeys(sizes))
    backgrounds = list(dict.fromkeys(backgrounds)) or ["transparent"]
    if not sizes:
        raise ValueError("at least one preview size is required")
    unknown = [name for name in backgrounds if name not in BACKGROUND_NAMES]
    if unknown:
        raise ValueError(f"unsupported preview background: {unknown[0]}")
    if any(width < 1 or height < 1 or width * height > MAX_PNG_PIXELS for width, height in sizes):
        raise ValueError("preview size exceeds the local pixel limit")
    total_pixels = sum(width * height for width, height in sizes) * len(backgrounds)
    if total_pixels > MAX_PREVIEW_TOTAL_PIXELS:
        raise ValueError("preview cumulative pixel limit exceeded")
    cell_w = max(width for width, _ in sizes)
    cell_h = max(height for _, height in sizes)
    board_w = len(sizes) * cell_w + (len(sizes) + 1) * BOARD_GAP
    board_h = len(backgrounds) * cell_h + (len(backgrounds) + 1) * BOARD_GAP
    if board_w * board_h > MAX_PNG_PIXELS:
        raise ValueError("preview board pixel limit exceeded")
    return sizes, backgrounds, board_w, board_h


def make_background(width: int, height: int, name: str) -> PixelBuffer:
    if name == "transparent":
        return PixelBuffer(bytes((0, 0, 0, 0)) * (width * height))
    if name == "white":
        return PixelBuffer(bytes((255, 255, 255, 255)) * (width * height))
    if name == "black":
        return PixelBuffer(bytes((0, 0, 0, 255)) * (width * height))
    if name == "gray":
        return PixelBuffer(bytes((128, 128, 128, 255)) * (width * height))
    if name == "checker":
        tile = max(2, min(width, height) // 8)
        packed = bytearray()
        for y in range(height):
            for x in range(width):
                packed.extend((220, 220, 220, 255) if ((x // tile) + (y // tile)) % 2 == 0 else (160, 160, 160, 255))
        return PixelBuffer(packed)
    raise ValueError(f"unsupported preview background: {name}")


def composite_pixels(background: Sequence[Pixel], foreground: Sequence[Pixel]) -> PixelBuffer:
    if len(background) != len(foreground):
        raise ValueError("preview layers must have matching dimensions")
    packed = bytearray()
    for base, overlay in zip(background, foreground):
        packed.extend(_composite_pixel(base, overlay))
    return PixelBuffer(packed)


def paste_pixels(
    canvas: bytearray,
    canvas_w: int,
    canvas_h: int,
    source: Sequence[Pixel],
    source_w: int,
    source_h: int,
    offset_x: int,
    offset_y: int,
) -> None:
    if offset_x < 0 or offset_y < 0 or offset_x + source_w > canvas_w or offset_y + source_h > canvas_h:
        raise ValueError("preview does not fit on board")
    packed = source.packed() if isinstance(source, PixelBuffer) else bytes(channel for pixel in source for channel in pixel)
    row_bytes = source_w * 4
    for y in range(source_h):
        source_start = y * row_bytes
        target_start = ((offset_y + y) * canvas_w + offset_x) * 4
        canvas[target_start : target_start + row_bytes] = packed[source_start : source_start + row_bytes]


def _composite_pixel(background: Pixel, foreground: Pixel) -> Pixel:
    foreground_alpha = foreground[3] / 255.0
    background_alpha = background[3] / 255.0
    output_alpha = foreground_alpha + background_alpha * (1.0 - foreground_alpha)
    if output_alpha <= 0:
        return (0, 0, 0, 0)
    channels = []
    for channel in range(3):
        value = (
            foreground[channel] * foreground_alpha
            + background[channel] * background_alpha * (1.0 - foreground_alpha)
        ) / output_alpha
        channels.append(max(0, min(255, round(value))))
    return (*channels, max(0, min(255, round(output_alpha * 255))))
