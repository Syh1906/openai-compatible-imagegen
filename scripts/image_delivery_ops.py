"""Shared deterministic image delivery operations.

This module contains the filesystem-independent image transforms used by both
the standalone adapter and the Codex plugin machine adapter. Callers provide
their own transaction and artifact storage policy.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from image_png import alpha_bbox, crop_pixels, grid_edges, read_png_rgba, write_png_rgba
from image_preview import preview_board_image as build_preview_board
from image_qa import analyze_pixels, evaluate_delivery as evaluate_delivery_report, sha256_file
from image_resize import fit_to_canvas as fit_pixels_to_canvas, resize_pixels


def display_path(path: Path) -> str:
    return path.resolve().as_posix()


def inspect_image_file(path: Path, include_components: bool = False) -> dict[str, Any]:
    image = read_png_rgba(path)
    pixels = image["pixels"]
    width = int(image["width"])
    height = int(image["height"])
    metrics = analyze_pixels(
        pixels,
        width,
        height,
        include_components=include_components,
    )
    return {
        "path": display_path(path),
        "format": "png",
        "width": width,
        "height": height,
        "mode": "rgba",
        "has_alpha": any(pixels[index][3] < 255 for index in range(0, len(pixels))),
        "sha256": sha256_file(path),
        **metrics,
    }


def inspect_image_payload(path: Path, image: Any) -> dict[str, Any]:
    pixels = image["pixels"]
    width = int(image["width"])
    height = int(image["height"])
    bbox = alpha_bbox(pixels, width, height)
    return {
        "path": display_path(path),
        "format": "png",
        "width": width,
        "height": height,
        "has_alpha": any(pixels[index][3] < 255 for index in range(0, len(pixels))),
        "alpha_bbox": list(bbox) if bbox else None,
    }


def evaluate_delivery(
    paths: list[Path],
    expectations: dict[str, Any] | None = None,
    conditions: list[dict[str, Any]] | None = None,
    source_paths: list[Path] | None = None,
) -> dict[str, Any]:
    return evaluate_delivery_report(
        paths,
        expectations=expectations,
        conditions=conditions,
        inspect_fn=inspect_image_file,
        source_paths=source_paths,
    )


def normalize_image_file(
    source: Path,
    output: Path,
    delivery_size: tuple[int, int],
    resample: str = "bilinear",
    fit_mode: str = "stretch",
    safe_margin: float = 0.0,
) -> dict[str, Any]:
    image = read_png_rgba(source)
    pixels = image["pixels"]
    source_w = int(image["width"])
    source_h = int(image["height"])
    if fit_mode == "stretch":
        if safe_margin:
            raise ValueError("safe margin requires fit_mode=contain")
        resized = resize_pixels(
            pixels,
            source_w,
            source_h,
            delivery_size[0],
            delivery_size[1],
            resample,
        )
    elif fit_mode == "contain":
        resized = fit_pixels_to_canvas(
            pixels,
            source_w,
            source_h,
            delivery_size[0],
            delivery_size[1],
            resample=resample,
            safe_margin=safe_margin,
        )
    else:
        raise ValueError(f"unsupported fit mode: {fit_mode}")
    write_png_rgba(output, delivery_size[0], delivery_size[1], resized)
    return {
        "source": display_path(source),
        "file": display_path(output),
        "transform": {
            "delivery_size": list(delivery_size),
            "resample": resample,
            "fit": fit_mode,
            "safe_margin": safe_margin,
        },
        "input": inspect_image_payload(source, image),
        "output": inspect_image_file(output),
    }


def split_grid_image(
    source: Path,
    out_dir: Path,
    rows: int,
    cols: int,
    delivery_size: tuple[int, int],
    expected_count: int | None = None,
    resample: str = "bilinear",
    safe_margin: float = 0.0,
) -> dict[str, Any]:
    if rows < 1 or cols < 1:
        raise ValueError("grid rows and cols must be >= 1")
    count = rows * cols
    if expected_count is not None and expected_count != count:
        raise ValueError(f"grid count {count} does not match expected count {expected_count}")

    image = read_png_rgba(source)
    pixels = image["pixels"]
    image_width = int(image["width"])
    image_height = int(image["height"])
    out_dir.mkdir(parents=True, exist_ok=True)
    x_edges = grid_edges(image_width, cols)
    y_edges = grid_edges(image_height, rows)
    outputs: list[dict[str, Any]] = []
    for row in range(rows):
        for col in range(cols):
            index = row * cols + col + 1
            cell_left = x_edges[col]
            cell_top = y_edges[row]
            cell_w = x_edges[col + 1] - cell_left
            cell_h = y_edges[row + 1] - cell_top
            cell = crop_pixels(pixels, image_width, image_height, cell_left, cell_top, cell_w, cell_h)
            cell_bbox = alpha_bbox(cell, cell_w, cell_h)
            if cell_bbox:
                content_left, content_top, content_right, content_bottom = cell_bbox
                cropped = crop_pixels(
                    cell,
                    cell_w,
                    cell_h,
                    content_left,
                    content_top,
                    content_right - content_left + 1,
                    content_bottom - content_top + 1,
                )
                crop_w = content_right - content_left + 1
                crop_h = content_bottom - content_top + 1
            else:
                cropped = cell
                crop_w = cell_w
                crop_h = cell_h
            resized = fit_pixels_to_canvas(
                cropped,
                crop_w,
                crop_h,
                delivery_size[0],
                delivery_size[1],
                resample=resample,
                safe_margin=safe_margin,
            )
            target = out_dir / f"{source.stem}_{index:02d}.png"
            write_png_rgba(target, delivery_size[0], delivery_size[1], resized)
            outputs.append(
                {
                    "index": index,
                    "row": row + 1,
                    "col": col + 1,
                    "source_cell": [cell_left, cell_top, cell_w, cell_h],
                    "content_bbox": list(cell_bbox) if cell_bbox else None,
                    "file": display_path(target),
                }
            )

    return {
        "source": display_path(source),
        "grid": {"rows": rows, "cols": cols, "count": count},
        "delivery_size": list(delivery_size),
        "resample": resample,
        "safe_margin": safe_margin,
        "outputs": outputs,
    }


def preview_board_image(
    source: Path,
    out_dir: Path,
    sizes: list[tuple[int, int]],
    backgrounds: list[str],
    resample: str = "bilinear",
) -> dict[str, Any]:
    return build_preview_board(source, out_dir, sizes, backgrounds, resample)


def parse_size(value: str) -> tuple[int, int]:
    parts = value.lower().replace("*", "x").split("x", 1)
    if len(parts) != 2:
        raise ValueError(f"invalid size: {value}")
    try:
        width, height = int(parts[0]), int(parts[1])
    except ValueError as exc:
        raise ValueError(f"invalid size: {value}") from exc
    if width < 1 or height < 1:
        raise ValueError("size dimensions must be positive")
    return width, height
