"""Generated-output delivery orchestration."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from image_transaction import OutputTransaction, remap_transaction_paths
from image_transparency import (
    TransparencyPlan,
    output_path as transparency_output_path,
    process_file as process_transparency_file,
    unmet_result as unmet_transparency_result,
)


@dataclass(frozen=True)
class PostprocessOperations:
    normalize: Callable[..., dict[str, Any]]
    split_grid: Callable[..., dict[str, Any]]
    evaluate: Callable[..., dict[str, Any]]


def run(
    record: dict[str, Any],
    args: Any,
    task: dict[str, Any] | None,
    operations: PostprocessOperations,
) -> dict[str, Any]:
    if not record.get("ok"):
        return record
    task = task or {}
    qa_requested = bool(get_value("qa", args, task, False))
    transparency_value = record.get("transparency")
    transparency_record = transparency_value if isinstance(transparency_value, dict) else None
    transparency_requested = bool(
        (transparency_record and transparency_record.get("requested"))
        or transparent_intent(args, task)
    )
    explicit = any(
        [
            get_value("postprocess", args, task, None) is True,
            bool(get_value("delivery_size", args, task, None)),
            bool(get_value("grid", args, task, None)),
            qa_requested,
            transparency_requested,
        ]
    )
    if not explicit:
        return record

    delivery_value = get_value("delivery_size", args, task, None)
    grid_value = get_value("grid", args, task, None)
    expected_count = get_value("expected_count", args, task, None)
    out_dir_value = get_value("postprocess_out_dir", args, task, None)
    resample = str(get_value("resample", args, task, "bilinear") or "bilinear")
    fit_mode = str(get_value("fit", args, task, "stretch") or "stretch")
    safe_margin = float(get_value("safe_margin", args, task, 0.0) or 0.0)
    components = bool(get_value("components", args, task, False))
    original_files = list(record.get("files", []))
    if grid_value and not delivery_value:
        raise ValueError("grid requires delivery_size")
    delivery_size = parse_size(str(delivery_value)) if delivery_value else None
    grid_size = parse_grid(str(grid_value)) if grid_value else None
    output_files: list[str] = []
    postprocess_results: list[dict[str, Any]] = []
    transparency_results: list[dict[str, Any]] = []
    transparency_warnings: list[str] = []
    transparency_passed = True
    has_derived_output = False
    path_mapping: dict[str, str] = {}
    transparency_plan = TransparencyPlan.from_record(
        transparency_record or {"mode": "prompt-alpha"},
        str(record.get("prompt") or ""),
    )
    try:
        with OutputTransaction() as transaction:
            for source_index, file_text in enumerate(original_files):
                source = Path(file_text).expanduser().resolve()
                processing_source = source
                transparency_file: Path | None = None
                transparency_ok = not transparency_requested
                if transparency_requested:
                    try:
                        stage_dir = transaction.directory(source.parent)
                        staged = stage_dir / f"transparency-{source_index:04d}-{source.name}"
                        transparency_result = process_transparency_file(source, staged, transparency_plan)
                        transparency_ok = transparency_result.get("status") == "pass"
                        if transparency_ok and transparency_result.get("changed"):
                            transparency_file = transparency_output_path(source, out_dir_value)
                            transaction.directory(transparency_file.parent)
                            transaction.register(staged, transparency_file)
                            processing_source = staged
                            has_derived_output = True
                        else:
                            transparency_result["file"] = display_path(source)
                    except Exception as exc:
                        warning = f"local_transparency_processing_failed: {exc}; returned the original API image"
                        transparency_result = unmet_transparency_result(source, transparency_plan, warning)
                        transparency_ok = False
                    transparency_results.append(transparency_result)
                    transparency_warnings.extend(transparency_result.get("warnings", []))
                    transparency_passed = transparency_passed and transparency_ok

                if delivery_size and transparency_ok:
                    out_dir = (
                        Path(out_dir_value).expanduser().resolve()
                        if out_dir_value
                        else source.parent / f"{source.stem}-postprocess"
                    )
                    if grid_size:
                        rows, cols = grid_size
                        stage_dir = transaction.directory(out_dir)
                        result = operations.split_grid(
                            processing_source,
                            stage_dir,
                            rows,
                            cols,
                            delivery_size,
                            expected_count=expected_count,
                            resample=resample,
                            safe_margin=safe_margin,
                        )
                        for item in result["outputs"]:
                            staged = Path(item["file"])
                            final = out_dir / staged.name
                            transaction.register(staged, final)
                            output_files.append(display_path(final))
                        postprocess_results.append(result)
                        has_derived_output = True
                    else:
                        final = out_dir / f"{source.stem}-{delivery_size[0]}x{delivery_size[1]}.png"
                        staged = transaction.stage_path(final)
                        result = operations.normalize(
                            processing_source,
                            staged,
                            delivery_size,
                            resample=resample,
                            fit_mode=fit_mode,
                            safe_margin=safe_margin,
                        )
                        output_files.append(display_path(final))
                        postprocess_results.append(result)
                        has_derived_output = True
                elif transparency_file is not None:
                    output_files.append(display_path(transparency_file))
                else:
                    output_files.append(display_path(source))
                    if delivery_size and transparency_requested:
                        transparency_warnings.append(
                            "delivery_transform_skipped: transparency was not achieved for "
                            f"{display_path(source)}; returned the original API image"
                        )
            path_mapping = transaction.commit()
    except Exception as exc:
        if not transparency_requested:
            raise
        warning = f"postprocess_publish_failed: {exc}; returned the original API images"
        output_files = [display_path(Path(file_text)) for file_text in original_files]
        postprocess_results = []
        transparency_results = [
            unmet_transparency_result(Path(file_text), transparency_plan, warning)
            for file_text in original_files
        ]
        transparency_warnings = [warning]
        transparency_passed = False
        has_derived_output = False
        path_mapping = {}

    postprocess_results = remap_transaction_paths(postprocess_results, path_mapping)
    transparency_results = remap_transaction_paths(transparency_results, path_mapping)
    updated = dict(record)
    updated["files"] = output_files
    if has_derived_output:
        updated["original_files"] = original_files
    if postprocess_results:
        updated["postprocess"] = postprocess_results
    if transparency_requested:
        transparency_summary = dict(transparency_record or {})
        transparency_summary.update(
            {
                "requested": True,
                "mode": (transparency_record or {}).get("mode", "prompt-alpha"),
                "key": (transparency_record or {}).get("key"),
                "status": "pass" if transparency_passed else "unmet",
                "artifacts": transparency_results,
                "warnings": transparency_warnings,
            }
        )
        updated["transparency"] = transparency_summary
        updated["warnings"] = list(record.get("warnings", [])) + transparency_warnings
    if qa_requested:
        qa_expected_count = expected_count
        if grid_size:
            qa_expected_count = len(original_files) * (expected_count or grid_size[0] * grid_size[1])
        updated["qa"] = operations.evaluate(
            [Path(file_text) for file_text in output_files],
            expectations={
                **({"expected_size": list(delivery_size)} if delivery_size else {}),
                "expected_count": qa_expected_count if qa_expected_count is not None else len(output_files),
                "components": components,
            },
            conditions=[{"kind": "transparent", "requested": True}] if transparency_requested else None,
        )
    if transparency_requested:
        updated["delivery_ready"] = transparency_passed and (
            not qa_requested or updated["qa"].get("status") == "pass"
        )
    return updated


def get_value(name: str, args: Any, task: dict[str, Any], fallback: Any) -> Any:
    if name in task and task[name] not in (None, ""):
        return task[name]
    return getattr(args, name, fallback)


def transparent_intent(args: Any, task: dict[str, Any]) -> bool:
    return bool(get_value("transparent", args, task, False))


def display_path(path: Path) -> str:
    return path.resolve().as_posix()


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


def parse_grid(value: str) -> tuple[int, int]:
    return parse_size(value)
