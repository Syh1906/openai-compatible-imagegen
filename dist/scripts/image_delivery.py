"""Deterministic delivery orchestration for immutable image artifacts.

The module deliberately keeps the public interface small: callers provide one
artifact snapshot and a delivery declaration, and receive derived bytes plus a
sanitized delivery report. Files created for the existing PNG/grid/preview/QA
helpers stay inside a short-lived temporary directory.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
import math
from pathlib import Path
import tempfile
from typing import Any

from image_delivery_ops import (
    evaluate_delivery,
    normalize_image_file,
    parse_size,
    preview_board_image,
    split_grid_image,
)
from image_response import detect_image_format, image_dimensions
from image_transparency import TransparencyPlan, process_file as process_transparency_file


MAX_DELIVERY_PIXELS = 25_000_000
MAX_DERIVED_IMAGES = 10
SUPPORTED_TRANSFORM_FORMAT = "png"


class DeliveryError(ValueError):
    """A delivery declaration or source cannot be processed locally."""

    def __init__(self, message: str, code: str = "invalid_delivery") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class DeliveryRequest:
    delivery_size: tuple[int, int] | None
    fit: str
    resample: str
    safe_margin: float
    qa: bool
    components: bool
    grid: tuple[int, int] | None
    expected_count: int | None
    preview_sizes: tuple[tuple[int, int], ...]
    preview_backgrounds: tuple[str, ...]
    preview_resample: str


def parse_delivery_request(
    value: Any,
    *,
    transparency_requested: bool = False,
) -> DeliveryRequest:
    if not isinstance(value, dict):
        raise DeliveryError("delivery must be an object")
    allowed = {
        "deliverySize",
        "fit",
        "resample",
        "safeMargin",
        "qa",
        "components",
        "grid",
        "expectedCount",
        "preview",
    }
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise DeliveryError(f"unsupported delivery option: {unknown[0]}")

    raw_size = value.get("deliverySize")
    delivery_size = parse_delivery_size(raw_size) if raw_size not in (None, "") else None
    fit = str(value.get("fit") or "stretch").lower()
    if fit not in {"stretch", "contain"}:
        raise DeliveryError(f"unsupported fit mode: {fit}")
    resample = str(value.get("resample") or "bilinear").lower()
    if resample not in {"nearest", "bilinear"}:
        raise DeliveryError(f"unsupported resample method: {resample}")
    safe_margin = parse_safe_margin(value.get("safeMargin", 0.0))
    if safe_margin and fit != "contain":
        raise DeliveryError("safe margin requires fit=contain")
    qa = parse_bool(value.get("qa", False), "qa")
    components = parse_bool(value.get("components", False), "components")
    grid = parse_grid(value.get("grid"))
    expected_count = parse_expected_count(value.get("expectedCount"))
    if grid is not None and delivery_size is None:
        raise DeliveryError("grid requires deliverySize")
    if expected_count is not None and grid is None:
        raise DeliveryError("expectedCount requires grid")
    if grid and expected_count is not None and grid[0] * grid[1] != expected_count:
        raise DeliveryError("grid count does not match expectedCount")
    preview_sizes, preview_backgrounds, preview_resample = parse_preview(value.get("preview"))
    if (
        delivery_size is None
        and grid is None
        and not preview_sizes
        and not qa
        and not transparency_requested
    ):
        raise DeliveryError("delivery requires a transform, preview, or qa request")
    return DeliveryRequest(
        delivery_size=delivery_size,
        fit=fit,
        resample=resample,
        safe_margin=safe_margin,
        qa=qa,
        components=components,
        grid=grid,
        expected_count=expected_count,
        preview_sizes=tuple(preview_sizes),
        preview_backgrounds=tuple(preview_backgrounds),
        preview_resample=preview_resample,
    )


def deliver_artifact(
    *,
    source_artifact_id: str,
    source_bytes: bytes,
    source_mime_type: str,
    delivery: Any,
    transparency_plan: TransparencyPlan | None = None,
    transparency_record: dict[str, Any] | None = None,
    transparency_mask_bytes: bytes | None = None,
) -> dict[str, Any]:
    """Run one local delivery request and return bytes safe for artifact storage."""
    transparency_requested = bool(
        transparency_plan is not None and transparency_plan.mode != "none"
    )
    request = parse_delivery_request(
        delivery,
        transparency_requested=transparency_requested,
    )
    source_format = detect_image_format(source_bytes)
    if source_format is None:
        raise DeliveryError("source artifact is not a complete PNG, JPEG, or WebP", "invalid_source")
    source_dimensions = image_dimensions(source_bytes, source_format)

    # The existing deterministic transform helpers operate on bounded RGBA PNG.
    # Preserve other valid originals, but do not silently transcode them.
    if source_format != SUPPORTED_TRANSFORM_FORMAT and (
        transparency_requested or _requires_transform(request)
    ):
        return {
            "sourceArtifactId": source_artifact_id,
            "deliveryReady": False,
            "artifacts": [],
            "deliveryKinds": [],
            "parameters": [],
            "qa": None,
            "warnings": [
                f"local delivery transforms currently support PNG sources; {source_format} source was preserved"
            ],
            "source": {"format": source_format, "width": source_dimensions[0], "height": source_dimensions[1]},
        }

    with tempfile.TemporaryDirectory(prefix="codex-image-delivery-") as temp_name:
        root = Path(temp_name)
        source_path = root / "source.png"
        source_path.write_bytes(source_bytes)
        derived_paths: list[Path] = []
        derived_kinds: list[str] = []
        derived_parameters: list[dict[str, Any]] = []
        summary: dict[str, Any] = {
            "source": {
                "format": source_format,
                "width": source_dimensions[0],
                "height": source_dimensions[1],
            },
            "transforms": [],
        }
        working_path = source_path
        if transparency_requested and transparency_plan is not None:
            effective_plan = transparency_plan
            if effective_plan.mode == "mask-alpha":
                if transparency_mask_bytes is None:
                    return transparency_unmet_result(
                        source_artifact_id,
                        summary,
                        ["mask_required: stable transparency mask is unavailable; source artifact was preserved"],
                    )
                mask_path = root / "transparency-mask.png"
                mask_path.write_bytes(transparency_mask_bytes)
                effective_plan = replace(effective_plan, mask_path=mask_path)
            transparent_path = root / "transparent.png"
            transparency_result = process_transparency_file(
                source_path,
                transparent_path,
                effective_plan,
            )
            sanitized_transparency = sanitize_report(transparency_result)
            sanitized_transparency["warnings"] = safe_transparency_warnings(
                transparency_result.get("warnings")
            )
            summary["transparency"] = sanitized_transparency
            summary["transforms"].append({
                "kind": "transparent",
                "mode": effective_plan.mode,
                "status": transparency_result.get("status"),
            })
            if transparency_result.get("status") != "pass":
                return transparency_unmet_result(
                    source_artifact_id,
                    summary,
                    list(transparency_result.get("warnings") or []),
                    transparency_result,
                )
            working_path = transparent_path

        transparency_parameters = sanitized_transparency_parameters(
            transparency_plan,
            transparency_record,
        )

        if transparency_requested and request.delivery_size is None:
            derived_paths.append(working_path)
            derived_kinds.append("transparent")
            derived_parameters.append(transparency_parameters)

        if request.delivery_size is not None:
            if request.grid is not None:
                grid_dir = root / "grid"
                grid_result = split_grid_image(
                    working_path,
                    grid_dir,
                    request.grid[0],
                    request.grid[1],
                    request.delivery_size,
                    expected_count=request.expected_count,
                    resample=request.resample,
                    safe_margin=request.safe_margin,
                )
                summary["transforms"].append({
                    "kind": "grid",
                    "rows": request.grid[0],
                    "cols": request.grid[1],
                    "count": len(grid_result["outputs"]),
                })
                for index, item in enumerate(grid_result["outputs"], start=1):
                    path = Path(item["file"])
                    derived_paths.append(path)
                    derived_kinds.append("grid-cell")
                    parameters = {
                        "deliverySize": list(request.delivery_size),
                        "fit": "contain",
                        "resample": request.resample,
                        "safeMargin": request.safe_margin,
                        "grid": {"rows": request.grid[0], "cols": request.grid[1]},
                        "gridIndex": index,
                    }
                    parameters.update(transparency_parameters)
                    derived_parameters.append(parameters)
            else:
                target = root / f"normalized-{request.delivery_size[0]}x{request.delivery_size[1]}.png"
                normalize_result = normalize_image_file(
                    working_path,
                    target,
                    request.delivery_size,
                    resample=request.resample,
                    fit_mode=request.fit,
                    safe_margin=request.safe_margin,
                )
                summary["transforms"].append({
                    "kind": "exact-size",
                    "size": list(request.delivery_size),
                    "fit": request.fit,
                    "resample": request.resample,
                    "safeMargin": request.safe_margin,
                })
                derived_paths.append(target)
                derived_kinds.append("exact-size")
                parameters = {
                    "deliverySize": list(request.delivery_size),
                    "fit": request.fit,
                    "resample": request.resample,
                    "safeMargin": request.safe_margin,
                }
                parameters.update(transparency_parameters)
                derived_parameters.append(parameters)

        if request.preview_sizes:
            preview_dir = root / "preview"
            preview_result = preview_board_image(
                working_path,
                preview_dir,
                list(request.preview_sizes),
                list(request.preview_backgrounds),
                request.preview_resample,
            )
            board_path = Path(preview_result["board"])
            derived_paths.append(board_path)
            derived_kinds.append("preview-board")
            parameters = {
                "previewSizes": [list(size) for size in request.preview_sizes],
                "previewBackgrounds": list(request.preview_backgrounds),
                "resample": request.preview_resample,
            }
            parameters.update(transparency_parameters)
            derived_parameters.append(parameters)
            summary["transforms"].append({
                "kind": "preview-board",
                "count": int(preview_result["count"]),
            })

        if len(derived_paths) > MAX_DERIVED_IMAGES:
            raise DeliveryError(
                f"delivery produced {len(derived_paths)} images; maximum is {MAX_DERIVED_IMAGES}",
                "delivery_limit_exceeded",
            )

        qa_report = None
        if request.qa:
            qa_report = evaluate_delivery_outputs(
                derived_paths or [source_path],
                derived_kinds or ["source"],
                request,
                require_transparency=transparency_requested,
            )

        delivery_ready = not request.qa or bool(qa_report and qa_report.get("status") == "pass")
        if not derived_paths:
            delivery_ready = delivery_ready and not _requires_transform(request)
        if not delivery_ready:
            return {
                "sourceArtifactId": source_artifact_id,
                "deliveryReady": False,
                "artifacts": [],
                "deliveryKinds": [],
                "parameters": [],
                "qa": qa_report,
                "warnings": ["delivery QA did not pass; source artifact was preserved"],
                "source": summary["source"],
                "summary": summary,
            }

        derived_bytes = [path.read_bytes() for path in derived_paths]
        return {
            "sourceArtifactId": source_artifact_id,
            "deliveryReady": True,
            "artifacts": derived_bytes,
            "deliveryKinds": derived_kinds,
            "parameters": derived_parameters,
            "qa": qa_report,
            "warnings": [],
            "source": summary["source"],
            "summary": summary,
        }


def parse_delivery_size(value: Any) -> tuple[int, int]:
    if not isinstance(value, str):
        raise DeliveryError("deliverySize must be a WIDTHxHEIGHT string")
    size = parse_size(value)
    if size[0] * size[1] > MAX_DELIVERY_PIXELS:
        raise DeliveryError("deliverySize exceeds the local pixel limit", "delivery_limit_exceeded")
    return size


def parse_safe_margin(value: Any) -> float:
    if isinstance(value, bool):
        raise DeliveryError("safeMargin must be numeric")
    try:
        margin = float(value or 0.0)
    except (TypeError, ValueError) as exc:
        raise DeliveryError("safeMargin must be numeric") from exc
    if not math.isfinite(margin) or not 0 <= margin < 0.5:
        raise DeliveryError("safeMargin must be between 0 and 0.5")
    return margin


def parse_bool(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise DeliveryError(f"{name} must be boolean")
    return value


def parse_expected_count(value: Any) -> int | None:
    if value in (None, ""):
        return None
    if isinstance(value, bool):
        raise DeliveryError("expectedCount must be an integer")
    try:
        count = int(value)
    except (TypeError, ValueError) as exc:
        raise DeliveryError("expectedCount must be an integer") from exc
    if count < 1 or count > MAX_DERIVED_IMAGES:
        raise DeliveryError(f"expectedCount must be between 1 and {MAX_DERIVED_IMAGES}")
    return count


def parse_grid(value: Any) -> tuple[int, int] | None:
    if value in (None, ""):
        return None
    if isinstance(value, dict):
        rows, cols = value.get("rows"), value.get("cols")
        if isinstance(rows, bool) or isinstance(cols, bool):
            raise DeliveryError("grid rows and cols must be integers")
        value = f"{rows}x{cols}"
    if not isinstance(value, str):
        raise DeliveryError("grid must be a ROWSxCOLS string or object")
    try:
        rows, cols = parse_size(value)
    except ValueError as exc:
        raise DeliveryError(str(exc)) from exc
    if rows * cols > MAX_DERIVED_IMAGES:
        raise DeliveryError(f"grid cannot produce more than {MAX_DERIVED_IMAGES} cells")
    return rows, cols


def parse_preview(value: Any) -> tuple[list[tuple[int, int]], list[str], str]:
    if value in (None, {}):
        return [], [], "bilinear"
    if not isinstance(value, dict):
        raise DeliveryError("preview must be an object")
    unknown = sorted(set(value) - {"sizes", "backgrounds", "resample"})
    if unknown:
        raise DeliveryError(f"unsupported preview option: {unknown[0]}")
    raw_sizes = value.get("sizes")
    if not isinstance(raw_sizes, list) or not raw_sizes:
        raise DeliveryError("preview.sizes must be a non-empty array")
    sizes = [parse_delivery_size(item) for item in raw_sizes]
    backgrounds = value.get("backgrounds") or ["transparent", "white", "black", "gray", "checker"]
    if not isinstance(backgrounds, list) or not backgrounds:
        raise DeliveryError("preview.backgrounds must be a non-empty array")
    allowed_backgrounds = {"transparent", "white", "black", "gray", "checker"}
    normalized_backgrounds = [str(item).lower() for item in backgrounds]
    unknown_backgrounds = sorted(set(normalized_backgrounds) - allowed_backgrounds)
    if unknown_backgrounds:
        raise DeliveryError(f"unsupported preview background: {unknown_backgrounds[0]}")
    resample = str(value.get("resample") or "bilinear").lower()
    if resample not in {"nearest", "bilinear"}:
        raise DeliveryError(f"unsupported preview resample method: {resample}")
    if len(sizes) * len(normalized_backgrounds) > MAX_DERIVED_IMAGES:
        raise DeliveryError("preview plan exceeds the local image limit", "delivery_limit_exceeded")
    return sizes, normalized_backgrounds, resample


def _requires_transform(request: DeliveryRequest) -> bool:
    return bool(request.delivery_size or request.grid or request.preview_sizes)


def sanitize_report(value: Any) -> Any:
    """Remove temporary filesystem references from nested QA reports."""
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, child in value.items():
            if key in {"file", "path", "source", "board", "manifest"}:
                continue
            cleaned[key] = sanitize_report(child)
        return cleaned
    if isinstance(value, list):
        return [sanitize_report(item) for item in value]
    return value


def sanitized_transparency_parameters(
    plan: TransparencyPlan | None,
    record: dict[str, Any] | None,
) -> dict[str, Any]:
    if plan is None or plan.mode == "none":
        return {}
    stored = dict(record or plan.to_record())
    stored.pop("mask", None)
    stored["status"] = "pass"
    stored["warnings"] = []
    return {"transparency": sanitize_report(stored)}


def transparency_unmet_result(
    source_artifact_id: str,
    summary: dict[str, Any],
    warnings: Any,
    transparency_result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    safe_warnings = safe_transparency_warnings(warnings)
    if not safe_warnings:
        safe_warnings = [
            "transparent_qa_unmet: transparency processing did not pass; source artifact was preserved"
        ]
    checks = sanitize_report((transparency_result or {}).get("checks") or {})
    qa = {
        "schema_version": "qa.v1",
        "status": "fail",
        "artifacts": [],
        "conditions": [{
            "kind": "transparent",
            "requested": True,
            "status": "fail",
        }],
        "warnings": safe_warnings,
        "errors": [],
        "checks": checks,
    }
    return {
        "sourceArtifactId": source_artifact_id,
        "deliveryReady": False,
        "artifacts": [],
        "deliveryKinds": [],
        "parameters": [],
        "qa": qa,
        "warnings": safe_warnings,
        "source": summary["source"],
        "summary": summary,
    }


def safe_transparency_warnings(value: Any) -> list[str]:
    warnings = value if isinstance(value, list) else []
    result: list[str] = []
    for warning in warnings:
        code = str(warning).partition(":")[0].strip()
        if not code or not all(char.isalnum() or char == "_" for char in code):
            code = "transparent_qa_unmet"
        result.append(
            f"{code}: transparency processing did not pass; source artifact was preserved"
        )
    return result


def evaluate_delivery_outputs(
    paths: list[Path],
    kinds: list[str],
    request: DeliveryRequest,
    *,
    require_transparency: bool = False,
) -> dict[str, Any]:
    """Evaluate each output family with only the expectations it can satisfy."""
    if len(paths) != len(kinds):
        raise DeliveryError("delivery QA output metadata is inconsistent")

    grouped: dict[str, list[Path]] = {}
    order: list[str] = []
    for path, kind in zip(paths, kinds):
        if kind not in grouped:
            grouped[kind] = []
            order.append(kind)
        grouped[kind].append(path)

    reports: list[dict[str, Any]] = []
    for kind in order:
        group_paths = grouped[kind]
        expectations: dict[str, Any] = {
            "expected_count": len(group_paths),
            "components": request.components,
        }
        if kind in {"exact-size", "grid-cell"} and request.delivery_size is not None:
            expectations["expected_size"] = list(request.delivery_size)
        conditions = (
            [{"kind": "transparent", "requested": True}]
            if require_transparency and kind in {"transparent", "exact-size", "grid-cell"}
            else None
        )
        report = evaluate_delivery(
            group_paths,
            expectations=expectations,
            conditions=conditions,
            source_paths=None,
        )
        reports.append(sanitize_report(report))

    merged: dict[str, Any] = {
        "schema_version": "qa.v1",
        "status": _merge_qa_statuses([report["status"] for report in reports]),
        "artifacts": [item for report in reports for item in report.get("artifacts", [])],
        "conditions": [item for report in reports for item in report.get("conditions", [])],
        "warnings": [item for report in reports for item in report.get("warnings", [])],
        "errors": [item for report in reports for item in report.get("errors", [])],
        "checks": [item for report in reports for item in report.get("checks", [])],
    }
    return merged


def _merge_qa_statuses(statuses: list[str]) -> str:
    if "fail" in statuses:
        return "fail"
    if "partial" in statuses:
        return "partial"
    if "not_evaluated" in statuses:
        return "partial" if any(status == "pass" for status in statuses) else "not_evaluated"
    return "pass" if statuses and all(status == "pass" for status in statuses) else "not_evaluated"
