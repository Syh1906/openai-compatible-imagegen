"""Generated-output delivery orchestration."""

from __future__ import annotations

from dataclasses import dataclass
import math
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


def validate_request(args: Any, task: dict[str, Any] | None = None) -> None:
    """Validate post-processing inputs before an API request is made."""
    task = task or {}
    delivery_value = get_value("delivery_size", args, task, None)
    grid_value = get_value("grid", args, task, None)
    if grid_value and not delivery_value:
        raise ValueError("grid requires delivery_size")
    if delivery_value:
        parse_size(str(delivery_value))
    if grid_value:
        parse_grid(str(grid_value))

    expected_count = get_value("expected_count", args, task, None)
    if expected_count not in (None, ""):
        if isinstance(expected_count, bool):
            raise ValueError("expected_count must be an integer")
        try:
            expected_count = int(expected_count)
        except (TypeError, ValueError) as exc:
            raise ValueError("expected_count must be an integer") from exc
        if expected_count < 1:
            raise ValueError("expected_count must be >= 1")

    resample = str(get_value("resample", args, task, "bilinear") or "bilinear")
    if resample not in {"nearest", "bilinear"}:
        raise ValueError(f"unsupported resample method: {resample}")
    fit_mode = str(get_value("fit", args, task, "stretch") or "stretch")
    if fit_mode not in {"stretch", "contain"}:
        raise ValueError(f"unsupported fit mode: {fit_mode}")
    raw_margin = get_value("safe_margin", args, task, 0.0)
    try:
        safe_margin = float(raw_margin or 0.0)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid safe_margin: {raw_margin}") from exc
    if not math.isfinite(safe_margin) or not 0 <= safe_margin < 0.5:
        raise ValueError("safe_margin must be between 0 and 0.5")
    if safe_margin and fit_mode != "contain":
        raise ValueError("safe margin requires fit_mode=contain")


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

    validate_request(args, task)

    delivery_value = get_value("delivery_size", args, task, None)
    grid_value = get_value("grid", args, task, None)
    expected_count_value = get_value("expected_count", args, task, None)
    expected_count = (
        int(expected_count_value)
        if expected_count_value not in (None, "")
        else None
    )
    out_dir_value = get_value("postprocess_out_dir", args, task, None)
    resample = str(get_value("resample", args, task, "bilinear") or "bilinear")
    fit_mode = str(get_value("fit", args, task, "stretch") or "stretch")
    safe_margin = float(get_value("safe_margin", args, task, 0.0) or 0.0)
    components = bool(get_value("components", args, task, False))
    source_values = record.get("original_files") or record.get("files", [])
    original_files = [display_path(Path(file_text)) for file_text in source_values]
    if grid_value and not delivery_value:
        raise ValueError("grid requires delivery_size")
    delivery_size = parse_size(str(delivery_value)) if delivery_value else None
    grid_size = parse_grid(str(grid_value)) if grid_value else None
    output_files: list[str] = []
    derived_files: list[str] = []
    qa_files: list[str] = []
    qa_stage_files: list[Path] = []
    derived_stage_files: list[Path] = []
    postprocess_results: list[dict[str, Any]] = []
    transparency_results: list[dict[str, Any]] = []
    transparency_warnings: list[str] = []
    processing_warnings: list[str] = []
    transparency_passed = True
    has_derived_output = False
    source_groups: list[dict[str, Any]] = []
    path_mapping: dict[str, str] = {}
    metadata_mapping: dict[str, str] = {}
    qa_result: dict[str, Any] | None = None
    transparency_plan = TransparencyPlan.from_record(
        transparency_record or {"mode": "prompt-alpha"},
        str(record.get("prompt") or ""),
    )
    try:
        with OutputTransaction() as transaction:
            for source_index, file_text in enumerate(original_files):
                source = Path(file_text).expanduser().resolve()
                transaction_checkpoint = transaction.checkpoint()
                output_start = len(output_files)
                derived_start = len(derived_files)
                qa_start = len(qa_stage_files)
                derived_stage_start = len(derived_stage_files)
                postprocess_start = len(postprocess_results)
                metadata_keys_before = set(metadata_mapping)
                processing_source = source
                transparency_file: Path | None = None
                transparency_stage: Path | None = None
                transparency_result: dict[str, Any] | None = None
                transparency_ok = not transparency_requested
                try:
                    if transparency_requested:
                        try:
                            stage_dir = transaction.directory(source.parent)
                            staged = stage_dir / f"transparency-{source_index:04d}-{source.name}"
                            transparency_stage = staged
                            transparency_result = process_transparency_file(source, staged, transparency_plan)
                            transparency_ok = transparency_result.get("status") == "pass"
                            if transparency_ok and transparency_result.get("changed"):
                                transparency_file = transparency_output_path(source, out_dir_value)
                                transaction.directory(transparency_file.parent)
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
                            grid_files: list[str] = []
                            for grid_index, item in enumerate(result["outputs"], start=1):
                                staged_output = Path(item["file"])
                                final = out_dir / f"{source.stem}_{grid_index:02d}.png"
                                transaction.register(staged_output, final)
                                final_path = display_path(final)
                                grid_files.append(final_path)
                                qa_stage_files.append(staged_output)
                                derived_stage_files.append(staged_output)
                                qa_files.append(final_path)
                                derived_files.append(final_path)
                            if transparency_requested:
                                output_files.extend([display_path(source), *grid_files])
                                transparency_result["file"] = grid_files[0] if grid_files else display_path(source)
                                transparency_result["files"] = grid_files
                            else:
                                output_files.extend([display_path(source), *grid_files])
                            if processing_source != source:
                                metadata_mapping[display_path(processing_source)] = display_path(source)
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
                            final_path = display_path(final)
                            qa_stage_files.append(staged)
                            derived_stage_files.append(staged)
                            qa_files.append(final_path)
                            output_files.extend([display_path(source), final_path])
                            derived_files.append(final_path)
                            if transparency_requested:
                                transparency_result["file"] = final_path
                            if processing_source != source:
                                metadata_mapping[display_path(processing_source)] = display_path(source)
                            postprocess_results.append(result)
                            has_derived_output = True
                    elif transparency_file is not None and transparency_stage is not None:
                        transaction.register(transparency_stage, transparency_file)
                        # The staged transparency result is the final derived file when
                        # no additional delivery transform was requested.
                        transparency_result["file"] = display_path(transparency_file)
                        derived_path = display_path(transparency_file)
                        output_files.extend([display_path(source), derived_path])
                        qa_stage_files.append(transparency_stage)
                        derived_stage_files.append(transparency_stage)
                        qa_files.append(derived_path)
                        derived_files.append(derived_path)
                    else:
                        source_path = display_path(source)
                        output_files.append(source_path)
                        qa_stage_files.append(source)
                        qa_files.append(source_path)
                        if delivery_size and transparency_requested:
                            transparency_warnings.append(
                                "delivery_transform_skipped: transparency was not achieved for "
                                f"{display_path(source)}; returned the original API image"
                            )
                except Exception as exc:
                    transaction.discard_since(transaction_checkpoint)
                    del output_files[output_start:]
                    del derived_files[derived_start:]
                    del qa_stage_files[qa_start:]
                    del qa_files[qa_start:]
                    del derived_stage_files[derived_stage_start:]
                    del postprocess_results[postprocess_start:]
                    for key in set(metadata_mapping) - metadata_keys_before:
                        metadata_mapping.pop(key, None)
                    warning = (
                        f"postprocess_item_failed: {display_path(source)} could not be transformed "
                        f"({exc}); returned the original API image"
                    )
                    processing_warnings.append(warning)
                    source_path = display_path(source)
                    output_files.append(source_path)
                    qa_stage_files.append(source)
                    qa_files.append(source_path)
                    if transparency_requested and isinstance(transparency_result, dict):
                        changed = bool(transparency_result.get("changed"))
                        rollback_transparency_result(transparency_result, source_path, warning)
                        if changed:
                            transparency_passed = False
                            transparency_warnings.append(warning)
                source_groups.append(
                    {
                        "source": display_path(source),
                        "output_files": output_files[output_start:],
                        "derived_files": derived_files[derived_start:],
                        "qa_stage_files": qa_stage_files[qa_start:],
                        "derived_stage_files": derived_stage_files[derived_stage_start:],
                        "postprocess_results": postprocess_results[postprocess_start:],
                        "metadata_keys": set(metadata_mapping) - metadata_keys_before,
                        "transparency_result": transparency_result,
                        "retain_derivatives": True,
                    }
                )
            has_derived_output = bool(derived_files)
            commit_requested = False
            if qa_requested:
                qa_expected_count = expected_count
                if grid_size:
                    qa_expected_count = len(original_files) * (expected_count or grid_size[0] * grid_size[1])
                qa_result = operations.evaluate(
                    qa_stage_files,
                    expectations={
                        **({"expected_size": list(delivery_size)} if delivery_size else {}),
                        "expected_count": qa_expected_count if qa_expected_count is not None else len(qa_stage_files),
                        "components": components,
                    },
                    conditions=[{"kind": "transparent", "requested": True}] if transparency_requested else None,
                )
            qa_status = str((qa_result or {}).get("status") or "not_evaluated")
            if qa_requested and qa_status != "pass":
                passing_groups, failing_groups = partition_qa_groups(
                    source_groups,
                    qa_result or {},
                    transparency_requested,
                )
                partial_publish = (
                    qa_global_contracts_pass(qa_result or {}, transparency_requested)
                    and bool(failing_groups)
                    and any(group["derived_files"] for group in passing_groups)
                )
                if partial_publish:
                    warning = qa_partial_warning(qa_status)
                    rejected_stages = [
                        stage
                        for group in failing_groups
                        for stage in group["derived_stage_files"]
                    ]
                    rejected_finals = [
                        Path(file_text)
                        for group in failing_groups
                        for file_text in group["derived_files"]
                    ]
                    transaction.discard_stages(rejected_stages)
                    qa_result = remove_path_references(
                        qa_result,
                        [*rejected_stages, *rejected_finals],
                    )
                    passing_ids = {id(group) for group in passing_groups}
                    output_files = []
                    qa_files = []
                    derived_files = []
                    postprocess_results = []
                    retained_metadata: dict[str, str] = {}
                    for group in source_groups:
                        if id(group) in passing_ids:
                            group["retain_derivatives"] = True
                            output_files.extend(group["output_files"])
                            qa_files.extend(
                                display_path(Path(path))
                                for path in group["qa_stage_files"]
                            )
                            derived_files.extend(group["derived_files"])
                            postprocess_results.extend(group["postprocess_results"])
                            retained_metadata.update(
                                {
                                    key: metadata_mapping[key]
                                    for key in group["metadata_keys"]
                                }
                            )
                            continue
                        group["retain_derivatives"] = False
                        output_files.append(group["source"])
                        qa_files.append(group["source"])
                        result = group.get("transparency_result")
                        if transparency_requested and isinstance(result, dict):
                            rollback_transparency_result(result, group["source"], warning)
                    metadata_mapping = retained_metadata
                    has_derived_output = bool(derived_files)
                    commit_requested = True
                    transparency_passed = False
                    if transparency_requested:
                        transparency_warnings.append(warning)
                    else:
                        processing_warnings.append(warning)
                else:
                    for group in source_groups:
                        group["retain_derivatives"] = False
                    warning = qa_unmet_warning(qa_status, bool(derived_files))
                    rolled_back_paths = [
                        *derived_stage_files,
                        *(Path(file_text) for file_text in derived_files),
                    ]
                    qa_result = remove_path_references(qa_result, rolled_back_paths)
                    output_files = list(original_files)
                    qa_files = list(original_files)
                    derived_files = []
                    postprocess_results = []
                    has_derived_output = False
                    metadata_mapping = {}
                    if transparency_requested:
                        transparency_results = rollback_transparency_results(
                            transparency_results,
                            original_files,
                            warning,
                        )
                        transparency_passed = all(
                            result.get("status") == "pass"
                            for result in transparency_results
                        )
                        transparency_warnings.append(warning)
                    else:
                        processing_warnings.append(warning)
            else:
                commit_requested = True
            if commit_requested:
                path_mapping, publish_failures = transaction.commit_isolated(
                    [group["derived_stage_files"] for group in source_groups]
                )
                failed_paths: list[Path] = []
                for group, failure in zip(source_groups, publish_failures):
                    if failure is None:
                        continue
                    group["retain_derivatives"] = False
                    failed_paths.extend(group["derived_stage_files"])
                    failed_paths.extend(Path(path) for path in group["derived_files"])
                    warning = (
                        f"postprocess_item_publish_failed: {group['source']} derivatives could not be "
                        f"published ({failure}); returned the original API image"
                    )
                    processing_warnings.append(warning)
                    result = group.get("transparency_result")
                    if transparency_requested and isinstance(result, dict) and result.get("changed"):
                        rollback_transparency_result(result, group["source"], warning)
                        transparency_passed = False
                        transparency_warnings.append(warning)
                if failed_paths:
                    if qa_result is not None:
                        qa_result = remove_path_references(qa_result, failed_paths)
                    (
                        output_files,
                        derived_files,
                        qa_files,
                        postprocess_results,
                        metadata_mapping,
                    ) = rebuild_retained_groups(source_groups, metadata_mapping)
                    has_derived_output = bool(derived_files)
    except Exception as exc:
        warning = f"postprocess_publish_failed: {exc}; returned the original API images"
        output_files = [display_path(Path(file_text)) for file_text in original_files]
        qa_files = list(output_files)
        derived_files = []
        postprocess_results = []
        transparency_results = [
            unmet_transparency_result(Path(file_text), transparency_plan, warning)
            for file_text in original_files
        ]
        transparency_warnings = [warning]
        processing_warnings = [warning]
        transparency_passed = False
        has_derived_output = False
        path_mapping = {}
        metadata_mapping = {}
        qa_result = None

    all_path_mapping = {**path_mapping, **metadata_mapping}
    postprocess_results = remap_transaction_paths(postprocess_results, all_path_mapping)
    transparency_results = remap_transaction_paths(transparency_results, all_path_mapping)
    derived_files = remap_transaction_paths(derived_files, all_path_mapping)
    qa_files = remap_transaction_paths(qa_files, all_path_mapping)
    updated = dict(record)
    for stale_field in ("postprocess", "qa", "derived_files"):
        updated.pop(stale_field, None)
    updated["files"] = output_files
    if transparency_requested or has_derived_output or processing_warnings:
        updated["original_files"] = original_files
        if derived_files:
            updated["derived_files"] = derived_files
        else:
            updated.pop("derived_files", None)
    if postprocess_results:
        updated["postprocess"] = postprocess_results
    if qa_result is not None:
        updated["qa"] = remap_transaction_paths(qa_result, all_path_mapping)
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
        updated["warnings"] = list(
            dict.fromkeys(
                [
                    *record.get("warnings", []),
                    *transparency_warnings,
                    *processing_warnings,
                ]
            )
        )
    elif processing_warnings:
        updated["warnings"] = list(record.get("warnings", [])) + processing_warnings
    if transparency_requested:
        updated["delivery_ready"] = transparency_passed and not processing_warnings and (
            not qa_requested or (updated.get("qa") or {}).get("status") == "pass"
        )
    else:
        updated["delivery_ready"] = not processing_warnings and (
            not qa_requested or (updated.get("qa") or {}).get("status") == "pass"
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


def remove_path_references(value: Any, paths: list[Path]) -> Any:
    """Remove QA path fields that refer to transaction outputs being rolled back."""
    rejected = {display_path(path) for path in paths}
    return _remove_path_references(value, rejected)


def _remove_path_references(value: Any, rejected: set[str], key: str | None = None) -> Any:
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for child_key, child_value in value.items():
            if child_key in {"file", "path", "source"} and _is_rejected_path(
                child_value,
                rejected,
            ):
                continue
            cleaned[child_key] = _remove_path_references(
                child_value,
                rejected,
                child_key,
            )
        return cleaned
    if isinstance(value, list):
        return [
            _remove_path_references(item, rejected, key)
            for item in value
            if not (key == "files" and _is_rejected_path(item, rejected))
        ]
    return value


def _is_rejected_path(value: Any, rejected: set[str]) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        return display_path(Path(value)) in rejected
    except OSError:
        return False


def rollback_transparency_results(
    results: list[dict[str, Any]],
    original_files: list[str],
    warning: str,
) -> list[dict[str, Any]]:
    """Make transparency metadata describe only the files retained after QA rollback."""
    rolled_back: list[dict[str, Any]] = []
    for index, result in enumerate(results):
        updated = dict(result)
        source = original_files[index]
        if updated.get("changed"):
            updated.update(
                {
                    "status": "unmet",
                    "delivery_ready": False,
                    "file": source,
                    "changed": False,
                }
            )
            updated.pop("files", None)
            updated["warnings"] = list(updated.get("warnings", [])) + [warning]
        elif updated.get("status") == "pass":
            updated["file"] = source
            updated.pop("files", None)
        rolled_back.append(updated)
    return rolled_back


def rebuild_retained_groups(
    groups: list[dict[str, Any]],
    metadata_mapping: dict[str, str],
) -> tuple[list[str], list[str], list[str], list[dict[str, Any]], dict[str, str]]:
    """Rebuild delivery metadata after one or more source groups fail publication."""
    output_files: list[str] = []
    derived_files: list[str] = []
    qa_files: list[str] = []
    postprocess_results: list[dict[str, Any]] = []
    retained_metadata: dict[str, str] = {}
    for group in groups:
        if group.get("retain_derivatives"):
            output_files.extend(group["output_files"])
            derived_files.extend(group["derived_files"])
            qa_files.extend(display_path(Path(path)) for path in group["qa_stage_files"])
            postprocess_results.extend(group["postprocess_results"])
            retained_metadata.update(
                {
                    key: metadata_mapping[key]
                    for key in group["metadata_keys"]
                    if key in metadata_mapping
                }
            )
        else:
            output_files.append(group["source"])
            qa_files.append(group["source"])
    return output_files, derived_files, qa_files, postprocess_results, retained_metadata


def rollback_transparency_result(
    result: dict[str, Any],
    source: str,
    warning: str,
) -> None:
    if not result.get("changed"):
        return
    result.update(
        {
            "status": "unmet",
            "delivery_ready": False,
            "file": source,
            "changed": False,
        }
    )
    result.pop("files", None)
    result["warnings"] = list(result.get("warnings", [])) + [warning]


def partition_qa_groups(
    groups: list[dict[str, Any]],
    qa_result: dict[str, Any],
    transparency_requested: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    artifacts = {
        display_path(Path(artifact["file"])): artifact
        for artifact in qa_result.get("artifacts", [])
        if isinstance(artifact, dict) and isinstance(artifact.get("file"), str)
    }
    passing: list[dict[str, Any]] = []
    failing: list[dict[str, Any]] = []
    for group in groups:
        group_passed = True
        result = group.get("transparency_result")
        if transparency_requested and (
            not isinstance(result, dict) or result.get("status") != "pass"
        ):
            group_passed = False
        for stage in group["qa_stage_files"]:
            artifact = artifacts.get(display_path(Path(stage)))
            if not qa_artifact_passes(artifact, transparency_requested):
                group_passed = False
        (passing if group_passed else failing).append(group)
    return passing, failing


def qa_artifact_passes(
    artifact: dict[str, Any] | None,
    transparency_requested: bool,
) -> bool:
    if not artifact:
        return False
    checks = artifact.get("checks", [])
    if not checks or any(check.get("status") != "pass" for check in checks):
        return False
    if not transparency_requested:
        return True
    inspection = artifact.get("inspection")
    return bool(
        isinstance(inspection, dict)
        and inspection.get("has_alpha")
        and inspection.get("alpha_bbox")
        and inspection.get("nontransparent_pixels", 0) > 0
    )


def qa_global_contracts_pass(
    qa_result: dict[str, Any],
    transparency_requested: bool,
) -> bool:
    if any(check.get("status") != "pass" for check in qa_result.get("checks", [])):
        return False
    return all(
        condition.get("status") == "pass"
        or (transparency_requested and condition.get("kind") == "transparent")
        for condition in qa_result.get("conditions", [])
    )


def qa_unmet_warning(status: str, had_derived_files: bool) -> str:
    action = (
        "unpublished derived images were discarded and the original API images were returned"
        if had_derived_files
        else "the original API images were returned"
    )
    return f"delivery_qa_unmet: QA status was {status}; {action}"


def qa_partial_warning(status: str) -> str:
    return (
        f"delivery_qa_unmet: QA status was {status}; successful per-image derivatives "
        "were retained and failed images were returned as original API images"
    )
