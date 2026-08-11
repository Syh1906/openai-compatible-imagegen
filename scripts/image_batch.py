"""Preflight planning for collision-free batch delivery targets."""

from __future__ import annotations

import copy
from datetime import datetime
import json
from pathlib import Path
from typing import Any, Callable


def fail_record(task: dict[str, Any], mode: str, exc: Exception) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": task.get("id"),
        "mode": mode,
        "ok": False,
        "delivery_ready": False,
        "error": str(exc),
    }
    error_kind = getattr(exc, "error_kind", None)
    status_code = getattr(exc, "status_code", None)
    operation = getattr(exc, "operation", None)
    if error_kind:
        result["error_kind"] = error_kind
    if status_code is not None:
        result["status_code"] = status_code
    if operation:
        result["operation"] = operation
    details = getattr(exc, "details", None)
    if details:
        result["details"] = details
    return result


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            task = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid JSONL at line {line_no}: {exc}") from exc
        if not isinstance(task, dict):
            raise ValueError(f"invalid JSONL at line {line_no}: expected object")
        tasks.append(task)
    return tasks


def normalize_batch_tasks(
    tasks: list[dict[str, Any]],
    input_root: Path,
    output_root: Path,
) -> list[dict[str, Any]]:
    input_root = input_root.expanduser().resolve()
    output_root = output_root.expanduser().resolve()
    return [normalize_batch_task(task, input_root, output_root) for task in tasks]


def normalize_batch_shared(
    shared: dict[str, Any],
    input_root: Path,
    output_root: Path,
) -> dict[str, Any]:
    normalized = dict(shared)
    input_root = input_root.expanduser().resolve()
    output_root = output_root.expanduser().resolve()
    for name in ("file", "out", "postprocess_out_dir"):
        if normalized.get(name) not in (None, ""):
            normalized[name] = _resolve_path(normalized[name], output_root)
    for name in ("images", "mask", "transparency_mask"):
        if normalized.get(name) not in (None, ""):
            normalized[name] = _resolve_input_value(normalized[name], input_root)
    return normalized


def normalize_batch_args(args: Any, input_path: Path, output_root: Path) -> Any:
    """Use batch path bases consistently during preflight and task execution."""
    normalized = copy.copy(args)
    input_path = input_path.expanduser().resolve()
    output_root = output_root.expanduser().resolve()
    path_values = normalize_batch_shared(
        {
            name: getattr(normalized, name, None)
            for name in (
                "file",
                "out",
                "postprocess_out_dir",
                "images",
                "mask",
                "transparency_mask",
            )
        },
        input_path.parent,
        output_root,
    )
    path_values["input"] = str(input_path)
    path_values["out"] = str(output_root)
    for name, value in path_values.items():
        setattr(normalized, name, value)
    return normalized


def write_manifest(out_dir: Path, results: list[dict[str, Any]]) -> tuple[Path, bool]:
    output_files = [
        str(path)
        for item in results
        if item.get("ok")
        for field in ("files", "original_files")
        for path in item.get(field, [])
    ]
    missing_files = [path for path in output_files if not Path(path).expanduser().is_file()]
    manifest = out_dir / "manifest.json"
    payload = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "output_root": out_dir.expanduser().resolve().as_posix(),
        "path_contract": {
            "status": "pass" if not missing_files else "fail",
            "files_exist": not missing_files,
            "missing_files": missing_files,
        },
        "results": results,
        "summary": {
            "total": len(results),
            "ok": sum(1 for item in results if item.get("ok")),
            "failed": sum(1 for item in results if not item.get("ok")),
        },
    }
    manifest.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest, not missing_files


def normalize_batch_task(
    task: dict[str, Any],
    input_root: Path,
    output_root: Path,
) -> dict[str, Any]:
    normalized = dict(task)
    normalized["out"] = _resolve_path(task.get("out") or output_root, output_root)
    for name in ("file", "postprocess_out_dir"):
        if task.get(name) not in (None, ""):
            normalized[name] = _resolve_path(task[name], output_root)
    for name in ("images", "mask", "transparency_mask"):
        if task.get(name) not in (None, ""):
            normalized[name] = _resolve_input_value(task[name], input_root)
    return normalized


def _resolve_input_value(value: Any, base: Path) -> Any:
    if isinstance(value, list):
        return [_resolve_path(item, base) for item in value]
    return _resolve_path(value, base)


def _resolve_path(value: Any, base: Path) -> str:
    path = Path(str(value)).expanduser()
    if not path.is_absolute():
        path = base / path
    return str(path.resolve())


def prepare_batch_targets(
    tasks: list[dict[str, Any]],
    shared: dict[str, Any],
    out_dir: Path,
    stamp: str,
    slugify: Callable[[str], str],
    resolve_format: Callable[[dict[str, Any]], str],
    reserves_transparency_output: Callable[[dict[str, Any]], bool],
) -> None:
    claimed: dict[Path, str] = {}
    for index, task in enumerate(tasks, start=1):
        task.setdefault("out", str(out_dir))
        prompt = str(task.get("prompt") or "")
        fmt = resolve_format(task)
        if not task.get("file") and not task.get("id"):
            task_out = Path(str(task.get("out") or out_dir)).expanduser().resolve()
            task["file"] = str(task_out / f"{stamp}-{index:04d}-{slugify(prompt)}.{fmt}")
        output = _output_file(task, shared, out_dir, fmt, prompt, stamp, slugify)
        count = int(_value("n", task, shared) or 1)
        if count < 1:
            raise ValueError("n must be >= 1")
        sources = [_numbered_path(output, item, count, fmt) for item in range(count)]
        for target in sources:
            _claim(claimed, target, task)

        transparent = bool(_value("transparent", task, shared))
        reserve_transparency_output = transparent and reserves_transparency_output(task)
        delivery_value = _value("delivery_size", task, shared)
        if not transparent and not delivery_value:
            continue
        delivery_size = _dimensions(str(delivery_value), "delivery size") if delivery_value else None
        grid_value = _value("grid", task, shared)
        postprocess_dir = _value("postprocess_out_dir", task, shared)
        for source in sources:
            derived_dir = (
                Path(str(postprocess_dir)).expanduser().resolve()
                if postprocess_dir
                else source.parent / f"{source.stem}-postprocess"
            )
            if reserve_transparency_output:
                _claim(claimed, derived_dir / f"{source.stem}-transparent.png", task)
            if delivery_size is None:
                continue
            if grid_value:
                rows, cols = _dimensions(str(grid_value), "grid")
                for grid_index in range(1, rows * cols + 1):
                    _claim(claimed, derived_dir / f"{source.stem}_{grid_index:02d}.png", task)
            else:
                width, height = delivery_size
                _claim(claimed, derived_dir / f"{source.stem}-{width}x{height}.png", task)


def task_mode(task: dict[str, Any]) -> str:
    mode = str(task.get("mode") or "").strip().lower()
    if not mode:
        return "edit" if task.get("images") else "generate"
    return "edit" if mode in {"multi-reference", "multi_reference"} else mode


def _value(name: str, task: dict[str, Any], shared: dict[str, Any]) -> Any:
    value = task.get(name)
    return value if value not in (None, "") else shared.get(name)


def _output_file(
    task: dict[str, Any],
    shared: dict[str, Any],
    out_dir: Path,
    fmt: str,
    prompt: str,
    stamp: str,
    slugify: Callable[[str], str],
) -> Path:
    file_value = task.get("file") or shared.get("file")
    if file_value:
        return validate_output_path(Path(str(file_value)).expanduser().resolve(), fmt)
    task_out = Path(str(task.get("out") or out_dir)).expanduser().resolve()
    name = str(task.get("id") or f"{stamp}-{slugify(prompt)}")
    return task_out / f"{name}.{fmt}"


def validate_output_path(path: Path, fmt: str) -> Path:
    suffix = path.suffix.lower().lstrip(".")
    actual = "jpeg" if suffix == "jpg" else suffix
    if actual and actual != fmt:
        raise ValueError(f"output extension .{suffix} does not match resolved format {fmt}")
    return path


def _numbered_path(path: Path, index: int, count: int, fmt: str) -> Path:
    suffix = path.suffix or f".{fmt}"
    return path.with_suffix(suffix) if count == 1 else path.with_name(f"{path.stem}_{index + 1}{suffix}")


def _dimensions(value: str, label: str) -> tuple[int, int]:
    parts = value.lower().replace("*", "x").split("x", 1)
    if len(parts) != 2:
        raise ValueError(f"invalid {label}: {value}")
    try:
        width, height = int(parts[0]), int(parts[1])
    except ValueError as exc:
        raise ValueError(f"invalid {label}: {value}") from exc
    if width < 1 or height < 1:
        raise ValueError(f"invalid {label}: {value}")
    return width, height


def _claim(claimed: dict[Path, str], target: Path, task: dict[str, Any]) -> None:
    resolved = target.expanduser().resolve()
    name = str(task.get("id") or task.get("file") or "unnamed task")
    previous = claimed.get(resolved)
    if previous is not None:
        raise ValueError(f"batch target path conflict: {resolved.as_posix()} ({previous}, {name})")
    claimed[resolved] = name
