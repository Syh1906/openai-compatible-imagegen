"""Deterministic alpha composition from an explicit PNG mask."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from image_alpha import compose_with_alpha, refine_alpha, remove_matte_and_defringe
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
    selected_source = "alpha" if use_alpha else source_mode
    if selected_source == "auto":
        selected_source = "luminance"
    checks["alpha_source"] = selected_source
    mask_values = bytearray(width * height)
    for index, mask_pixel in enumerate(mask_pixels):
        if use_alpha:
            value = mask_pixel[3]
        elif selected_source in {"red", "green", "blue"}:
            value = mask_pixel[{"red": 0, "green": 1, "blue": 2}[selected_source]]
        else:
            value = (
                54 * mask_pixel[0] + 183 * mask_pixel[1] + 19 * mask_pixel[2] + 128
            ) // 256
        mask_values[index] = 255 - value if options.get("invert", False) else value
    threshold = options.get("threshold")
    threshold = float(threshold) if threshold is not None else None
    expand = int(options.get("expand", 0))
    feather = int(options.get("feather", 0))
    gamma = float(options.get("gamma", 1.0))
    minimum_area = int(options.get("min_component_area", 0))
    mask_values, refinement = refine_alpha(
        mask_values,
        width,
        height,
        threshold=threshold,
        expand=expand,
        feather=feather,
        gamma=gamma,
        min_component_area=minimum_area,
    )
    checks["options"] = {
        "source": source_mode,
        "invert": bool(options.get("invert", False)),
        "gamma": gamma,
        "threshold": threshold,
        "feather": feather,
        "expand": expand,
        "min_component_area": minimum_area,
    }
    checks["refinement"] = refinement
    matte_record = {
        "method": selected_source,
        "alpha_bits": 8,
        "invert": bool(options.get("invert", False)),
        "transparent_pixels": sum(value <= 8 for value in mask_values),
        "partial_alpha_pixels": sum(0 < value < 255 for value in mask_values),
    }
    output = compose_with_alpha(pixels, mask_values)
    matte_name = str(options.get("matte", "none"))
    cleanup: dict[str, Any] = {
        "mode": "not_applied",
        "reason": "no source matte color was declared",
    }
    if matte_name != "none":
        matte = (255, 255, 255) if matte_name == "white" else (0, 0, 0)
        defringe_radius = int(options.get("defringe_radius", 1))
        output, cleanup = remove_matte_and_defringe(
            output,
            mask_values,
            width,
            height,
            matte,
            tolerance=96.0,
            defringe_radius=defringe_radius,
            mode=f"{matte_name}-matte",
            clean_opaque_edges=False,
        )
        checks["matte_cleanup"] = cleanup
        checks["options"]["matte"] = matte_name
        checks["options"]["defringe_radius"] = defringe_radius
    checks["alpha_pipeline"] = {
        "background_profile": {
            "mode": "explicit-mask",
            "mask": mask_path.as_posix(),
        },
        "matte": matte_record,
        "refinement": refinement,
        "matte_cleanup": cleanup,
    }
    return output, checks
