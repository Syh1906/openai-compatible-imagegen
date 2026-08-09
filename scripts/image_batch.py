"""Preflight planning for collision-free batch delivery targets."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable


def fail_record(task: dict[str, Any], mode: str, exc: Exception) -> dict[str, Any]:
    return {
        "id": task.get("id"),
        "mode": mode,
        "ok": False,
        "error": str(exc),
    }


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


def prepare_batch_targets(
    tasks: list[dict[str, Any]],
    shared: dict[str, Any],
    out_dir: Path,
    stamp: str,
    slugify: Callable[[str], str],
    resolve_format: Callable[[dict[str, Any]], str],
) -> None:
    claimed: dict[Path, str] = {}
    for index, task in enumerate(tasks, start=1):
        task.setdefault("out", str(out_dir))
        prompt = str(task.get("prompt") or "")
        fmt = resolve_format(task)
        if not task.get("file") and not task.get("id"):
            task["file"] = str(out_dir / f"{stamp}-{index:04d}-{slugify(prompt)}.{fmt}")
        output = _output_file(task, shared, out_dir, fmt, prompt, stamp, slugify)
        count = int(_value("n", task, shared) or 1)
        if count < 1:
            raise ValueError("n must be >= 1")
        sources = [_numbered_path(output, item, count, fmt) for item in range(count)]
        for target in sources:
            _claim(claimed, target, task)

        delivery_value = _value("delivery_size", task, shared)
        if not delivery_value:
            continue
        delivery_size = _dimensions(str(delivery_value), "delivery size")
        grid_value = _value("grid", task, shared)
        postprocess_dir = _value("postprocess_out_dir", task, shared)
        for source in sources:
            derived_dir = (
                Path(str(postprocess_dir)).expanduser().resolve()
                if postprocess_dir
                else source.parent / f"{source.stem}-postprocess"
            )
            if grid_value:
                rows, cols = _dimensions(str(grid_value), "grid")
                for grid_index in range(1, rows * cols + 1):
                    _claim(claimed, derived_dir / f"{source.stem}_{grid_index:02d}.png", task)
            else:
                width, height = delivery_size
                _claim(claimed, derived_dir / f"{source.stem}-{width}x{height}.png", task)


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
