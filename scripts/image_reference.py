"""Reference-image path normalization and technical metadata."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from image_png import read_png_rgba


def normalize_paths(value: Any) -> list[Path]:
    if not value:
        return []
    values = value if isinstance(value, list) else [value]
    return [Path(str(item)).expanduser().resolve() for item in values if str(item).strip()]


def inspect_reference_metadata(paths: list[Path]) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    warnings: list[str] = []
    for path_value in paths:
        path = Path(path_value).expanduser().resolve()
        item: dict[str, Any] = {
            "file": path.as_posix(),
            "exists": path.is_file(),
        }
        if not path.is_file():
            item["status"] = "unavailable"
            item["reason"] = "reference file not found"
            warnings.append("reference_metadata_unavailable")
            items.append(item)
            continue
        try:
            item["size_bytes"] = path.stat().st_size
            if path.suffix.lower() == ".png":
                image = read_png_rgba(path)
                width = image["width"]
                height = image["height"]
                item.update(
                    {
                        "format": "png",
                        "width": width,
                        "height": height,
                        "has_alpha": any(pixel[3] < 255 for pixel in image["pixels"]),
                        "aspect_ratio": round(width / height, 6),
                    }
                )
                if width / height > 3 or width / height < 1 / 3:
                    warnings.append("reference_shape_unusual")
            else:
                item["format"] = path.suffix.lower().lstrip(".") or "unknown"
                item["status"] = "technical_metadata_limited"
        except (OSError, ValueError) as exc:
            item["status"] = "unavailable"
            item["reason"] = str(exc)
            warnings.append("reference_metadata_unavailable")
        items.append(item)
    if paths:
        warnings.append("reference_semantics_not_evaluated")
    return {
        "status": "not_evaluated",
        "items": items,
        "warnings": list(dict.fromkeys(warnings)),
    }
