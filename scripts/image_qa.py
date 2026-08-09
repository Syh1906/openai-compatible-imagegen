"""Generic, deterministic QA metrics for decoded RGBA images."""

from __future__ import annotations

from collections.abc import Sequence
import hashlib
from pathlib import Path
from typing import Any, Callable


Pixel = tuple[int, int, int, int]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def analyze_pixels(
    pixels: Sequence[Pixel],
    width: int,
    height: int,
    include_components: bool = False,
    tiny_component_max_pixels: int = 16,
) -> dict[str, Any]:
    if width < 1 or height < 1 or len(pixels) != width * height:
        raise ValueError("pixel buffer does not match image dimensions")
    total = width * height
    nontransparent = 0
    semitransparent = 0
    for pixel in pixels:
        alpha = pixel[3]
        nontransparent += alpha > 0
        semitransparent += 0 < alpha < 255
    bbox = _alpha_bbox(pixels, width, height)
    result: dict[str, Any] = {
        "alpha_bbox": list(bbox) if bbox else None,
        "nontransparent_pixels": nontransparent,
        "alpha_coverage": round(nontransparent / total, 6),
        "semi_transparent_ratio": round(semitransparent / total, 6),
        "alpha_margins": _alpha_margins(bbox, width, height),
        "corner_alpha": {
            "top_left": pixels[0][3],
            "top_right": pixels[width - 1][3],
            "bottom_left": pixels[(height - 1) * width][3],
            "bottom_right": pixels[-1][3],
        },
        "edge_alpha": _edge_alpha(pixels, width, height),
    }
    if include_components:
        result["components"] = _component_stats(pixels, width, height, tiny_component_max_pixels)
    return result


def evaluate_delivery(
    paths: list[Path],
    expectations: dict[str, Any] | None = None,
    conditions: list[dict[str, Any]] | None = None,
    inspect_fn: Callable[[Path, bool], dict[str, Any]] | None = None,
    source_paths: list[Path] | None = None,
) -> dict[str, Any]:
    expectations = expectations or {}
    conditions = conditions or []
    artifacts: list[dict[str, Any]] = []
    errors: list[str] = []
    for path in paths:
        path = Path(path).expanduser().resolve()
        artifact: dict[str, Any] = {"file": path.as_posix(), "role": "delivery", "checks": []}
        if not path.is_file():
            artifact["checks"].append({"name": "exists", "status": "fail", "reason": "file not found"})
            artifacts.append(artifact)
            continue
        artifact["checks"].append({"name": "exists", "status": "pass", "actual": True})
        if path.suffix.lower() != ".png":
            artifact["checks"].append(
                {
                    "name": "format",
                    "status": "unsupported",
                    "actual": path.suffix.lower().lstrip("."),
                    "reason": "current QA parser supports PNG only",
                }
            )
            expected_size = expectations.get("expected_size")
            if expected_size is not None:
                artifact["checks"].append(
                    {
                        "name": "expected_size",
                        "status": "unsupported",
                        "expected": list(expected_size),
                        "reason": "current QA parser cannot inspect this format",
                    }
                )
            artifacts.append(artifact)
            continue
        try:
            inspection = inspect_fn(path, bool(expectations.get("components"))) if inspect_fn else None
        except Exception as exc:
            artifact["checks"].append({"name": "decode", "status": "fail", "reason": str(exc)})
            errors.append(f"{path.as_posix()}: {exc}")
            artifacts.append(artifact)
            continue
        if inspection is None:
            artifact["checks"].append({"name": "decode", "status": "unsupported", "reason": "no image inspector"})
            artifacts.append(artifact)
            continue
        artifact["inspection"] = inspection
        artifact["checks"].append({"name": "decode", "status": "pass", "actual": inspection.get("format")})
        expected_size = expectations.get("expected_size")
        if expected_size is not None:
            actual_size = [inspection.get("width"), inspection.get("height")]
            status = "pass" if actual_size == list(expected_size) else "fail"
            artifact["checks"].append(
                {"name": "expected_size", "status": status, "expected": list(expected_size), "actual": actual_size}
            )
        artifacts.append(artifact)

    if expectations.get("expected_count") is not None:
        expected_count = int(expectations["expected_count"])
        actual_count = len(paths)
        count_status = "pass" if expected_count == actual_count else "fail"
        count_check = {"name": "expected_count", "status": count_status, "expected": expected_count, "actual": actual_count}
    else:
        count_check = None

    condition_results = [_evaluate_condition(condition, artifacts) for condition in conditions]
    statuses = [check["status"] for artifact in artifacts for check in artifact.get("checks", [])]
    if count_check:
        statuses.append(count_check["status"])
    statuses.extend(item["status"] for item in condition_results)
    if "fail" in statuses:
        status = "fail"
    elif "unsupported" in statuses:
        status = "partial"
    elif "not_evaluated" in statuses:
        status = "partial" if any(item in {"pass", "fail"} for item in statuses) else "not_evaluated"
    elif statuses and all(item == "pass" for item in statuses):
        status = "pass"
    else:
        status = "not_evaluated"

    result: dict[str, Any] = {
        "schema_version": "qa.v1",
        "status": status,
        "artifacts": artifacts,
        "conditions": condition_results,
        "warnings": [],
        "errors": errors,
    }
    if count_check:
        result["checks"] = [count_check]
    if source_paths:
        source_report = evaluate_delivery(
            source_paths,
            expectations={"components": bool(expectations.get("components"))},
            conditions=conditions,
            inspect_fn=inspect_fn,
        )
        for artifact in source_report["artifacts"]:
            artifact["role"] = "source"
        for condition in source_report["conditions"]:
            condition["scope"] = "source"
        for condition in result["conditions"]:
            condition["scope"] = "delivery"
        result["artifacts"] = source_report["artifacts"] + result["artifacts"]
        result["conditions"] = source_report["conditions"] + result["conditions"]
        result["errors"] = source_report["errors"] + result["errors"]
        result["warnings"] = source_report["warnings"] + result["warnings"]
        result["status"] = _aggregate_report_statuses([source_report["status"], result["status"]])
    return result


def _aggregate_report_statuses(statuses: list[str]) -> str:
    if "fail" in statuses:
        return "fail"
    if "partial" in statuses:
        return "partial"
    if "not_evaluated" in statuses:
        return "partial" if "pass" in statuses else "not_evaluated"
    return "pass" if statuses and all(status == "pass" for status in statuses) else "not_evaluated"


def _evaluate_condition(condition: dict[str, Any], artifacts: list[dict[str, Any]]) -> dict[str, Any]:
    kind = str(condition.get("kind") or "unknown")
    requested = bool(condition.get("requested"))
    result: dict[str, Any] = {"kind": kind, "requested": requested}
    if not requested:
        result.update({"status": "not_evaluated", "reason": "condition was not requested"})
        return result
    if kind == "transparent":
        inspections = [item.get("inspection") for item in artifacts if item.get("inspection")]
        if not inspections:
            result.update({"status": "unsupported", "reason": "no decodable PNG artifact"})
            return result
        failures = []
        for inspection in inspections:
            if not inspection.get("has_alpha"):
                failures.append("image has no partial alpha channel")
            if not inspection.get("alpha_bbox") or inspection.get("nontransparent_pixels", 0) == 0:
                failures.append("image has no visible alpha content")
        result.update(
            {
                "status": "fail" if failures else "pass",
                "evidence": {
                    "artifacts": len(inspections),
                    "alpha": [item.get("has_alpha") for item in inspections],
                },
            }
        )
        if failures:
            result["reason"] = "; ".join(failures)
        return result
    if kind == "reference-metadata":
        result.update({"status": "not_evaluated", "reason": "reference semantics require external review"})
        return result
    result.update({"status": "unsupported", "reason": f"unknown condition kind: {kind}"})
    return result


def _alpha_bbox(pixels: Sequence[Pixel], width: int, height: int) -> tuple[int, int, int, int] | None:
    min_x = width
    min_y = height
    max_x = -1
    max_y = -1
    for y in range(height):
        for x in range(width):
            if pixels[y * width + x][3] > 0:
                min_x = min(min_x, x)
                min_y = min(min_y, y)
                max_x = max(max_x, x)
                max_y = max(max_y, y)
    if max_x < 0:
        return None
    return min_x, min_y, max_x, max_y


def _alpha_margins(bbox: tuple[int, int, int, int] | None, width: int, height: int) -> dict[str, int] | None:
    if bbox is None:
        return None
    left, top, right, bottom = bbox
    return {"left": left, "top": top, "right": width - right - 1, "bottom": height - bottom - 1}


def _edge_alpha(pixels: Sequence[Pixel], width: int, height: int) -> dict[str, Any]:
    edge_pixels: list[Pixel] = []
    for x in range(width):
        edge_pixels.append(pixels[x])
        if height > 1:
            edge_pixels.append(pixels[(height - 1) * width + x])
    for y in range(1, height - 1):
        edge_pixels.append(pixels[y * width])
        if width > 1:
            edge_pixels.append(pixels[y * width + width - 1])
    nontransparent = sum(1 for pixel in edge_pixels if pixel[3] > 0)
    partial = sum(1 for pixel in edge_pixels if 0 < pixel[3] < 255)
    return {
        "pixels": len(edge_pixels),
        "nontransparent_pixels": nontransparent,
        "partial_alpha_pixels": partial,
        "touches_canvas": nontransparent > 0,
    }


def _component_stats(pixels: Sequence[Pixel], width: int, height: int, tiny_limit: int) -> dict[str, Any]:
    total = width * height
    visited = bytearray(total)
    sizes: list[int] = []
    for start, pixel in enumerate(pixels):
        if visited[start] or pixel[3] == 0:
            continue
        visited[start] = 1
        queue = [start]
        size = 0
        while queue:
            index = queue.pop()
            size += 1
            x = index % width
            y = index // width
            for dx, dy in ((-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)):
                nx = x + dx
                ny = y + dy
                if nx < 0 or nx >= width or ny < 0 or ny >= height:
                    continue
                neighbor = ny * width + nx
                if not visited[neighbor] and pixels[neighbor][3] > 0:
                    visited[neighbor] = 1
                    queue.append(neighbor)
        sizes.append(size)
    sizes.sort(reverse=True)
    largest = sizes[0] if sizes else 0
    return {
        "count": len(sizes),
        "largest_pixels": largest,
        "largest_ratio": round(largest / total, 6),
        "tiny_count": sum(1 for size in sizes if size <= tiny_limit),
        "tiny_max_pixels": tiny_limit,
    }
