#!/usr/bin/env python3
"""Codex Plugin machine adapter for OpenAI-compatible image tasks."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.error
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
for import_root in (SCRIPT_DIR, SKILL_DIR):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))

import image_delivery
import image_transport
from scripts.image_response import (
    MAX_IMAGE_RESPONSE_BYTES,
    MAX_IMAGE_RESPONSE_ITEMS,
    MAX_JSON_RESPONSE_BYTES,
    MAX_TOTAL_IMAGE_RESPONSE_BYTES,
    decode_base64_image,
)
from scripts.artifact_repository import (
    ArtifactRepository,
    new_delivery_receipt_id,
    validate_artifact_id,
)
from scripts.image_download import ImageDownloadError, download_image_url
from scripts.image_transparency_contract import (
    ResolvedTransparency,
    parse_transparency_request,
    resolve_transparency_request,
    restore_transparency_plan,
)
from scripts.mask_policy import (
    MASK_GUARD_V2_BY_STRATEGY,
    PNG_SIGNATURE,
    decode_png_rgba,
    encode_png_rgba,
    finalize_masked_images,
    has_strict_capability,
    masked_edit_audit,
    prepare_masked_edit,
)
from scripts.provider_config import (
    Config,
    DEFAULT_USER_AGENT,
    ProviderConfigError,
    normalize_model_capabilities,
    parse_plugin_config,
)
from scripts.windows_repository_fs import SubmissionLock


DeliveryError = image_delivery.DeliveryError


SUBMISSION_ID_PATTERN = re.compile(r"^sub_[0-9a-f]{32}$")


DEFAULT_TIMEOUT_SECONDS = 600
DEFAULT_SIZE = "1024x1024"
DEFAULT_QUALITY = "medium"
DEFAULT_FORMAT = "png"
DEFAULT_RESOLUTION = "1K"
MIME_FORMATS = {
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/webp": "webp",
}


class ImagegenError(Exception):
    """User-facing script error."""


class MachineTaskError(ImagegenError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def load_config(
    require_api_key: bool = True,
    config_path: Path | None = None,
    model_profile_id: str = "primary/gpt-image-2",
    config_snapshot: bytes | None = None,
) -> Config:
    source_path = Path(config_path) if config_path is not None else None
    if config_snapshot is None and source_path is None:
        raise ImagegenError("image configuration snapshot is required")
    if config_snapshot is None and not source_path.is_file():
        raise ImagegenError(f"missing image config: {display_path(source_path)}")
    try:
        snapshot = config_snapshot if config_snapshot is not None else source_path.read_bytes()
        raw = json.loads(snapshot.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ImagegenError(f"image config is not valid JSON: {exc}") from exc

    try:
        return parse_plugin_config(
            raw,
            require_api_key=require_api_key,
            model_profile_id=model_profile_id,
        )
    except ProviderConfigError as exc:
        raise ImagegenError(str(exc)) from exc


def display_path(path: Path) -> str:
    return path.resolve().as_posix()


def request_json(cfg: Config, path: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    try:
        return image_transport.request_json(
            base_url=cfg.base_url,
            api_key=cfg.api_key,
            user_agent=cfg.user_agent,
            path=path,
            payload=payload,
            timeout=timeout,
            response_limit=MAX_JSON_RESPONSE_BYTES,
        )
    except (image_transport.TransportError, ValueError) as exc:
        raise ImagegenError(str(exc)) from exc


def request_multipart(
    cfg: Config,
    path: str,
    fields: dict[str, Any],
    files: list[image_transport.MultipartUpload],
    timeout: int,
) -> dict[str, Any]:
    try:
        return image_transport.request_multipart(
            base_url=cfg.base_url,
            api_key=cfg.api_key,
            user_agent=cfg.user_agent,
            path=path,
            fields=fields,
            files=files,
            timeout=timeout,
            response_limit=MAX_JSON_RESPONSE_BYTES,
        )
    except (image_transport.TransportError, ValueError) as exc:
        raise ImagegenError(str(exc)) from exc


def build_multipart_body(
    boundary: str,
    fields: dict[str, Any],
    files: list[image_transport.MultipartUpload],
) -> bytes:
    try:
        return image_transport.build_multipart_body(boundary, fields, files)
    except ValueError as exc:
        raise ImagegenError(str(exc)) from exc


def decode_response_images(
    response: dict[str, Any],
    user_agent: str,
    direct_url_download: bool = False,
    *,
    max_items: int = MAX_IMAGE_RESPONSE_ITEMS,
    total_limit: int = MAX_TOTAL_IMAGE_RESPONSE_BYTES,
) -> list[bytes]:
    data = response.get("data")
    if not isinstance(data, list) or not data:
        raise ImagegenError("API response did not include data images")

    if max_items < 1:
        raise ImagegenError("image response item limit must be positive")
    if len(data) > max_items:
        raise ImagegenError(
            f"API response contains too many image items: {len(data)} exceeds the {max_items}-item limit"
        )
    if total_limit < 1:
        raise ImagegenError("total image response limit must be positive")

    images: list[bytes] = []
    total_bytes = 0
    for item in data:
        if not isinstance(item, dict):
            continue
        raw = decode_image_item(item, user_agent, direct_url_download)
        total_bytes += len(raw)
        if total_bytes > total_limit:
            raise ImagegenError(
                "total image response exceeds the "
                f"{total_limit}-byte cumulative limit"
            )
        images.append(raw)
    if not images:
        raise ImagegenError("API response did not include b64_json or url images")
    return images


def decode_image_item(
    item: dict[str, Any],
    user_agent: str = DEFAULT_USER_AGENT,
    direct_url_download: bool = False,
) -> bytes:
    b64_value = item.get("b64_json")
    if isinstance(b64_value, str) and b64_value.strip():
        try:
            return decode_base64_image(
                strip_data_url_prefix(b64_value),
                MAX_IMAGE_RESPONSE_BYTES,
            )
        except ValueError as exc:
            raise ImagegenError(str(exc)) from exc
    url = item.get("url")
    if isinstance(url, str) and url.strip():
        try:
            return download_image_url(url, user_agent, DEFAULT_TIMEOUT_SECONDS, direct_url_download)
        except ImageDownloadError as exc:
            raise ImagegenError(str(exc)) from exc
    raise ImagegenError("image item has neither b64_json nor url")


def publish_partial_response_images(
    *,
    response: dict[str, Any],
    repository: ArtifactRepository,
    cfg: Config,
    params: dict[str, Any],
    operation: str,
    prompt: str,
    parameters: dict[str, Any],
    parent_ids: list[str],
    annotation_id: str | None,
    masked_context: Any = None,
) -> tuple[list[Any], dict[str, Any]]:
    data = response.get("data")
    if not isinstance(data, list) or not data:
        raise MachineTaskError("image_task_failed", "provider response did not contain image items")

    expected_count = int(params["count"])
    issues: list[dict[str, Any]] = []
    if len(data) != expected_count:
        issues.append({"code": "count_mismatch"})

    records: list[Any] = []
    item_summaries: list[dict[str, Any]] = []
    total_bytes = 0
    direct_download = cfg.url_download.get("proxy_mode") == "direct"
    expected_size = parse_size(str(params["size"]))
    requested_mime_type = machine_mime_type(str(params["format"]))

    for response_index, item in enumerate(data[:expected_count], start=1):
        if not isinstance(item, dict):
            issues.append({"code": "item_unusable", "responseIndex": response_index})
            continue
        try:
            image_bytes = decode_image_item(item, cfg.user_agent, direct_download)
        except Exception:
            issues.append({"code": "item_unusable", "responseIndex": response_index})
            continue
        if total_bytes + len(image_bytes) > MAX_TOTAL_IMAGE_RESPONSE_BYTES:
            issues.append({"code": "total_bytes_exceeded", "responseIndex": response_index})
            break
        total_bytes += len(image_bytes)
        if masked_context is not None:
            try:
                image_bytes = finalize_masked_images(masked_context, [image_bytes])[0]
            except (IndexError, ValueError):
                issues.append({"code": "item_unusable", "responseIndex": response_index})
                continue

        item_parameters = dict(parameters)
        item_parameters["apiResponseIndex"] = response_index
        try:
            stored = repository.store_response_images(
                images=[image_bytes],
                provider=cfg.provider_id,
                model="gpt-image-2",
                operation=operation,
                prompt=prompt,
                parameters=item_parameters,
                parent_ids=parent_ids,
                annotation_id=annotation_id,
            )
        except ValueError:
            issues.append({"code": "item_unusable", "responseIndex": response_index})
            continue
        except (KeyError, OSError):
            issues.append({"code": "item_publish_failed", "responseIndex": response_index})
            continue

        record = stored[0]
        records.append(record)
        metadata = record.metadata
        item_summary = {
            "responseIndex": response_index,
            "artifactId": metadata["id"],
            "actualFormat": MIME_FORMATS[str(metadata["mimeType"])],
            "width": metadata["width"],
            "height": metadata["height"],
        }
        item_summaries.append(item_summary)
        if metadata["mimeType"] != requested_mime_type:
            issues.append({"code": "format_mismatch", "responseIndex": response_index})
        if (metadata["width"], metadata["height"]) != expected_size:
            issues.append({"code": "size_mismatch", "responseIndex": response_index})

    if not records:
        raise MachineTaskError(
            "image_task_failed",
            "provider response did not contain a publishable image",
        )

    published_count = len(records)
    status = "partial" if published_count != expected_count else (
        "published_with_warnings" if issues else "published"
    )
    return records, {
        "status": status,
        "requestedCount": expected_count,
        "returnedCount": len(data),
        "publishedCount": published_count,
        "items": item_summaries,
        "issues": issues,
    }


def strip_data_url_prefix(value: str) -> str:
    if value.startswith("data:") and "," in value:
        return value.split(",", 1)[1]
    return value


def read_png_rgba(path: Path) -> dict[str, Any]:
    try:
        decoded = decode_png_rgba(path.read_bytes())
    except ValueError as exc:
        raise ImagegenError(str(exc)) from exc
    pixels = [tuple(decoded.pixels[index : index + 4]) for index in range(0, len(decoded.pixels), 4)]
    return {"width": decoded.width, "height": decoded.height, "pixels": pixels}


def parse_size(value: str) -> tuple[int, int]:
    match = re.fullmatch(r"(\d+)x(\d+)", value.strip())
    if not match:
        raise ImagegenError(f"invalid size: {value}")
    width, height = int(match.group(1)), int(match.group(2))
    if width < 1 or height < 1:
        raise ImagegenError(f"invalid size: {value}")
    return width, height


def run_machine_task(
    task: dict[str, Any],
    project_root: Path,
    artifact_root: Path,
    cfg: Config | None = None,
    config_snapshot: bytes | None = None,
    config_sha256: str | None = None,
) -> dict[str, Any]:
    effective_cfg = cfg
    submission_lock: SubmissionLock | None = None
    try:
        if not isinstance(task, dict):
            raise MachineTaskError("invalid_task", "machine task must be a JSON object")
        profile_id = str(task.get("modelProfileId") or "")
        if profile_id != "primary/gpt-image-2":
            raise MachineTaskError(
                "unsupported_model_profile",
                f"unsupported model profile: {profile_id or '(missing)'}",
            )
        operation = str(task.get("operation") or "").strip().lower()
        if operation not in {
            "generate",
            "edit",
            "deliver",
            "list_models",
            "record_batch",
            "get_batch_manifest",
            "get_delivery_receipt",
        }:
            raise MachineTaskError("invalid_task", f"unsupported operation: {operation or '(missing)'}")
        execution_mode = task.get("executionMode") if "executionMode" in task else None
        if "executionMode" in task and execution_mode != "batch-item":
            raise MachineTaskError(
                "invalid_task",
                "executionMode must be omitted or set to batch-item",
            )
        is_batch_item = execution_mode == "batch-item"
        if config_snapshot is not None:
            if not isinstance(config_snapshot, bytes):
                raise MachineTaskError("image_config_changed", "Image configuration snapshot is unavailable")
            if not isinstance(config_sha256, str) or not re.fullmatch(r"[a-f0-9]{64}", config_sha256):
                raise MachineTaskError("image_config_changed", "Image configuration snapshot is unavailable")
            current_sha256 = hashlib.sha256(config_snapshot).hexdigest()
            if current_sha256 != config_sha256:
                raise MachineTaskError("image_config_changed", "Image configuration changed after project binding")
        elif effective_cfg is None:
            raise MachineTaskError("image_config_changed", "Image configuration snapshot is unavailable")
        if effective_cfg is None:
            try:
                effective_cfg = load_config(
                    require_api_key=operation not in {
                        "list_models",
                        "deliver",
                        "record_batch",
                        "get_batch_manifest",
                        "get_delivery_receipt",
                    },
                    model_profile_id=profile_id,
                    config_snapshot=config_snapshot,
                )
            except ImagegenError as exc:
                raise MachineTaskError("image_config_invalid", str(exc)) from exc
        if effective_cfg.model != "gpt-image-2":
            raise MachineTaskError(
                "unsupported_model_profile",
                f"configured model does not match {profile_id}",
            )
        if operation == "list_models":
            return {
                "ok": True,
                "models": [
                    {
                        "id": profile_id,
                        "provider": effective_cfg.provider_id,
                        "model": effective_cfg.model,
                        "capabilities": normalize_model_capabilities(effective_cfg.capabilities),
                    }
                ],
            }

        if operation == "deliver":
            return run_delivery_task(
                task,
                Path(project_root),
                Path(artifact_root),
                effective_cfg,
            )
        if operation == "record_batch":
            manifest = task.get("manifest")
            if not isinstance(manifest, dict):
                raise MachineTaskError("invalid_task", "batch manifest must be a JSON object")
            repository = ArtifactRepository(Path(project_root), Path(artifact_root))
            try:
                stored_manifest = repository.store_batch_manifest(manifest)
            except ValueError as exc:
                raise MachineTaskError("invalid_task", str(exc)) from exc
            except KeyError as exc:
                raise MachineTaskError("artifact_not_found", str(exc)) from exc
            return {"ok": True, "manifest": stored_manifest}
        if operation == "get_batch_manifest":
            batch_id = task.get("batchId")
            if not isinstance(batch_id, str):
                raise MachineTaskError("invalid_task", "batchId is required")
            repository = ArtifactRepository(Path(project_root), Path(artifact_root))
            try:
                stored_manifest = repository.get_batch_manifest(batch_id)
            except ValueError as exc:
                raise MachineTaskError("invalid_task", str(exc)) from exc
            except (KeyError, FileNotFoundError) as exc:
                raise MachineTaskError("artifact_not_found", str(exc)) from exc
            return {"ok": True, "manifest": stored_manifest}
        if operation == "get_delivery_receipt":
            receipt_id = task.get("deliveryReceiptId")
            if not isinstance(receipt_id, str):
                raise MachineTaskError("invalid_task", "deliveryReceiptId is required")
            repository = ArtifactRepository(Path(project_root), Path(artifact_root))
            try:
                receipt = repository.get_delivery_receipt(receipt_id)
            except ValueError as exc:
                raise MachineTaskError("invalid_task", str(exc)) from exc
            if receipt is None:
                raise MachineTaskError(
                    "artifact_not_found",
                    f"delivery receipt not found: {receipt_id}",
                )
            return {
                "ok": True,
                "deliveryReceiptId": receipt_id,
                "receipt": receipt,
            }

        prompt = str(task.get("prompt") or "").strip()
        if not prompt:
            raise MachineTaskError("invalid_task", "prompt is required")
        input_ids = task.get("inputArtifactIds") or []
        if not isinstance(input_ids, list) or any(not isinstance(item, str) for item in input_ids):
            raise MachineTaskError("invalid_task", "inputArtifactIds must be an array of artifact IDs")
        if operation == "edit" and not input_ids:
            raise MachineTaskError("invalid_task", "edit requires a parent artifact ID")
        if not has_strict_capability(effective_cfg.capabilities, operation):
            raise MachineTaskError(
                "unsupported_capability",
                f"configured model profile does not support {operation}",
            )
        if len(input_ids) > 1 and not has_strict_capability(
            effective_cfg.capabilities,
            "multi_reference",
        ):
            raise MachineTaskError(
                "unsupported_capability",
                "configured model profile does not support multiple reference images",
            )
        submission_id = task.get("submissionId")
        if submission_id is not None:
            if operation != "edit" or not isinstance(submission_id, str) or not SUBMISSION_ID_PATTERN.fullmatch(submission_id):
                raise MachineTaskError("invalid_task", "submissionId must be a valid edit submission ID")
        has_mask_contract = task.get("mask") is not None or task.get("maskPolicy") is not None
        if has_mask_contract:
            if operation != "edit":
                raise MachineTaskError("invalid_task", "mask is only valid for edit tasks")
            if not has_strict_capability(effective_cfg.capabilities, "mask"):
                raise MachineTaskError(
                    "unsupported_capability",
                    "configured model profile does not support mask editing",
                )

        output = task.get("output") or {}
        if not isinstance(output, dict):
            raise MachineTaskError("invalid_task", "output must be a JSON object")
        params = resolve_machine_output(
            output,
            effective_cfg,
            count_limit=16 if is_batch_item else 10,
        )
        repository = ArtifactRepository(Path(project_root), Path(artifact_root))
        if submission_id:
            request_fingerprint = edit_submission_fingerprint(task, params)
            submission_lock = SubmissionLock(
                repository.data_root,
                submission_id,
                timeout=float(params["timeout"]) + 10.0,
            ).acquire()
            try:
                committed = repository.find_edits_by_submission_id(
                    submission_id,
                    parent_id=input_ids[0],
                    annotation_id=task.get("annotationId"),
                    request_fingerprint=request_fingerprint,
                )
            except ValueError as exc:
                raise MachineTaskError("edit_submission_mismatch", str(exc)) from exc
            if committed:
                replay_result: dict[str, Any] = {"ok": True, "artifacts": committed}
                if task.get("delivery") is not None:
                    replay_result["deliveries"] = run_inline_deliveries(
                        task=task,
                        artifacts=committed,
                        profile_id=profile_id,
                        project_root=Path(project_root),
                        artifact_root=Path(artifact_root),
                        cfg=effective_cfg,
                        submission_id=submission_id,
                        request_fingerprint=request_fingerprint,
                    )
                return replay_result
        parent_uploads = [repository.get_image_snapshot(artifact_id) for artifact_id in input_ids]
        parent_paths = [path for path, _ in parent_uploads]
        transparency = resolve_machine_transparency(
            task,
            prompt=prompt,
            operation=operation,
            params=params,
            cfg=effective_cfg,
            repository=repository,
            reference_paths=tuple(parent_paths),
        )
        validate_inline_transparency_override(
            task,
            prompt=prompt,
            operation=operation,
            params=params,
            cfg=effective_cfg,
            repository=repository,
            reference_paths=tuple(parent_paths),
        )
        if transparency is not None:
            params = dict(params)
            params["format"] = "png"
            params["compression"] = None
        validate_inline_delivery(task, transparency)
        planned_prompt = transparency.plan.prompt if transparency is not None else prompt
        try:
            masked_context = prepare_masked_edit(
                task,
                params,
                Path(artifact_root),
                parent_paths[0] if parent_paths else Path(),
                parent_uploads[0][1] if parent_uploads else b"",
                planned_prompt,
            )
        except ValueError as exc:
            raise MachineTaskError("invalid_task", str(exc)) from exc
        request_prompt = masked_context.effective_prompt if masked_context else planned_prompt
        payload = {
            "model": "gpt-image-2",
            "prompt": request_prompt,
            "size": params["size"],
            "quality": params["quality"],
            "n": (
                params["count"]
                if operation != "generate" or is_batch_item
                else 1
            ),
            "background": params["background"],
            "output_format": params["format"],
            "output_compression": params["compression"],
        }
        batch_response: dict[str, Any] | None = None
        if operation == "generate":
            if is_batch_item:
                batch_response = request_json(
                    effective_cfg,
                    "images/generations",
                    payload,
                    params["timeout"],
                )
                images: list[bytes] = []
            else:
                images = []
                for candidate_index in range(params["count"]):
                    response = request_json(effective_cfg, "images/generations", payload, params["timeout"])
                    candidate_images = decode_response_images(
                        response,
                        effective_cfg.user_agent,
                        effective_cfg.url_download.get("proxy_mode") == "direct",
                        max_items=1,
                        total_limit=MAX_TOTAL_IMAGE_RESPONSE_BYTES,
                    )
                    if len(candidate_images) != 1:
                        raise MachineTaskError(
                            "image_task_failed",
                            f"provider returned {len(candidate_images)} image(s) for candidate "
                            f"{candidate_index + 1} of {params['count']}",
                        )
                    images.extend(candidate_images)
            parent_ids: list[str] = []
        else:
            files: list[tuple[str, Path] | tuple[str, Path, bytes]] = []
            for index, (parent_path, parent_snapshot) in enumerate(parent_uploads):
                if masked_context and index == 0:
                    files.append(("image[]", parent_path, masked_context.parent_snapshot))
                else:
                    files.append(("image[]", parent_path, parent_snapshot))
            if masked_context:
                files.append(("mask", masked_context.mask_path, masked_context.mask_snapshot))
            response = request_multipart(
                effective_cfg,
                "images/edits",
                {key: value for key, value in payload.items() if key != "moderation"},
                files,
                params["timeout"],
            )
            parent_ids = [input_ids[0]]
            if is_batch_item:
                batch_response = response
                images = []
            else:
                images = decode_response_images(
                    response,
                    effective_cfg.user_agent,
                    effective_cfg.url_download.get("proxy_mode") == "direct",
                    max_items=params["count"],
                    total_limit=MAX_TOTAL_IMAGE_RESPONSE_BYTES,
                )
                if len(images) != params["count"]:
                    raise MachineTaskError(
                        "image_task_failed",
                        f"provider returned {len(images)} image(s) for a request of {params['count']}",
                    )
                if masked_context:
                    try:
                        images = finalize_masked_images(masked_context, images)
                    except ValueError as exc:
                        raise MachineTaskError("image_task_failed", str(exc)) from exc
        stored_parameters = {key: value for key, value in params.items() if key != "timeout"}
        if transparency is not None:
            stored_parameters["transparency"] = transparency.record
        if masked_context:
            stored_parameters.update(masked_edit_audit(masked_context))
        if submission_id:
            stored_parameters["submissionId"] = submission_id
            stored_parameters["submissionRequestFingerprint"] = request_fingerprint
        api_delivery: dict[str, Any] | None = None
        if is_batch_item:
            if batch_response is None:
                raise MachineTaskError("image_task_failed", "batch response is unavailable")
            records, api_delivery = publish_partial_response_images(
                response=batch_response,
                repository=repository,
                cfg=effective_cfg,
                params=params,
                operation=operation,
                prompt=prompt,
                parameters=stored_parameters,
                parent_ids=parent_ids,
                annotation_id=task.get("annotationId"),
                masked_context=masked_context,
            )
        else:
            records = repository.store_response_images(
                images=images,
                provider=effective_cfg.provider_id,
                model="gpt-image-2",
                operation=operation,
                prompt=prompt,
                parameters=stored_parameters,
                parent_ids=parent_ids,
                annotation_id=task.get("annotationId"),
            )
        result: dict[str, Any] = {
            "ok": True,
            "artifacts": [record.metadata for record in records],
        }
        if api_delivery is not None:
            result["apiDelivery"] = api_delivery
        if task.get("delivery") is not None:
            result["deliveries"] = run_inline_deliveries(
                task=task,
                artifacts=[record.metadata for record in records],
                profile_id=profile_id,
                project_root=Path(project_root),
                artifact_root=Path(artifact_root),
                cfg=effective_cfg,
                submission_id=submission_id,
                request_fingerprint=request_fingerprint if submission_id else None,
            )
        return result
    except Exception as exc:
        code = exc.code if isinstance(exc, MachineTaskError) else "image_task_failed"
        return {
            "ok": False,
            "error": {
                "code": code,
                "message": redact_machine_error(
                    str(exc),
                    effective_cfg,
                    Path(project_root),
                    config_path=None,
                ),
            },
        }
    finally:
        if submission_lock is not None:
            submission_lock.release()


def run_delivery_task(
    task: dict[str, Any],
    project_root: Path,
    artifact_root: Path,
    cfg: Config,
) -> dict[str, Any]:
    input_ids = task.get("inputArtifactIds") or []
    if not isinstance(input_ids, list) or len(input_ids) != 1 or not isinstance(input_ids[0], str):
        raise MachineTaskError("invalid_task", "deliver requires exactly one source artifact ID")
    repository = ArtifactRepository(project_root, artifact_root)
    source_id = input_ids[0]
    requested_receipt_id = task.get("deliveryReceiptId")
    receipt_id = requested_receipt_id or new_delivery_receipt_id()
    if requested_receipt_id is not None:
        try:
            recovered = repository.get_delivery_receipt(receipt_id)
        except ValueError as exc:
            raise MachineTaskError("invalid_task", str(exc)) from exc
        if recovered is not None:
            return {"ok": True, "deliveryReceiptId": receipt_id, **recovered}
    try:
        source = repository.get_artifact(source_id)
    except (KeyError, ValueError, FileNotFoundError) as exc:
        raise MachineTaskError("artifact_not_found", f"source artifact is unavailable: {source_id}") from exc
    delivery_value = task.get("delivery")
    if not isinstance(delivery_value, dict):
        raise MachineTaskError("invalid_task", "delivery must be an object")
    delivery_request = dict(delivery_value)
    explicit_transparency = delivery_request.pop("transparency", None)
    try:
        transparency, transparency_mask = resolve_delivery_transparency(
            source,
            explicit_transparency,
            cfg,
            repository,
        )
    except ValueError as exc:
        raise MachineTaskError("invalid_task", str(exc)) from exc
    except (KeyError, FileNotFoundError) as exc:
        mask_id = ""
        if isinstance(explicit_transparency, dict):
            mask_id = str(explicit_transparency.get("maskImageId") or "")
        raise MachineTaskError(
            "artifact_not_found",
            f"transparency mask artifact is unavailable: {mask_id or '(missing)'}",
        ) from exc
    try:
        delivery = image_delivery.deliver_artifact(
            source_artifact_id=source_id,
            source_bytes=source.image_bytes,
            source_mime_type=str(source.metadata.get("mimeType") or ""),
            delivery=delivery_request,
            transparency_plan=transparency.plan if transparency is not None else None,
            transparency_record=transparency.record if transparency is not None else None,
            transparency_mask_bytes=transparency_mask,
        )
    except DeliveryError as exc:
        raise MachineTaskError(exc.code, str(exc)) from exc

    records: list[dict[str, Any]] = []
    derived_images = delivery.get("artifacts") or []
    delivery_kinds = delivery.get("deliveryKinds") or []
    parameters = delivery.get("parameters") or []
    receipt_payload = {
        "sourceArtifactId": source_id,
        "deliveryReady": bool(delivery.get("deliveryReady")),
        "qa": delivery.get("qa"),
        "warnings": list(delivery.get("warnings") or []),
        "summary": delivery.get("summary"),
        "source": delivery.get("source"),
    }
    if delivery.get("deliveryReady") and derived_images:
        try:
            stored = repository.store_derived_images(
                images=derived_images,
                mime_type="image/png",
                derived_from=source_id,
                delivery_kinds=delivery_kinds,
                parameters=parameters,
                receipt_id=receipt_id,
                receipt=receipt_payload,
            )
            records = [{**record.metadata, "childIds": []} for record in stored]
        except (KeyError, OSError, ValueError) as exc:
            # The source remains valid; no partial derived result is reported.
            return {
                "ok": True,
                "sourceArtifactId": source_id,
                "deliveryReady": False,
                "artifacts": [],
                "qa": delivery.get("qa"),
                "warnings": ["derived artifact publication failed; source artifact was preserved"],
            }
    else:
        try:
            repository.store_derived_images(
                images=[],
                mime_type="image/png",
                derived_from=source_id,
                delivery_kinds=[],
                parameters=[],
                receipt_id=receipt_id,
                receipt=receipt_payload,
            )
        except (KeyError, OSError, ValueError) as exc:
            raise MachineTaskError(
                "delivery_receipt_failed",
                "delivery receipt publication failed; source artifact was preserved",
            ) from exc

    return {
        "ok": True,
        "deliveryReceiptId": receipt_id,
        "sourceArtifactId": source_id,
        "deliveryReady": bool(delivery.get("deliveryReady")),
        "artifacts": records,
        "qa": delivery.get("qa"),
        "warnings": list(delivery.get("warnings") or []),
        "summary": delivery.get("summary"),
        "source": delivery.get("source"),
    }


def run_inline_deliveries(
    *,
    task: dict[str, Any],
    artifacts: list[dict[str, Any]],
    profile_id: str,
    project_root: Path,
    artifact_root: Path,
    cfg: Config,
    submission_id: str | None,
    request_fingerprint: str | None,
) -> list[dict[str, Any]]:
    delivery_value = task.get("delivery")
    if not isinstance(delivery_value, dict):
        raise MachineTaskError("invalid_task", "delivery must be an object")
    delivery_request = dict(delivery_value)
    if task.get("transparency") is None:
        delivery_request.pop("transparency", None)

    deliveries: list[dict[str, Any]] = []
    for artifact in artifacts:
        source_id = str(artifact.get("id") or "")
        receipt_id = (
            inline_delivery_receipt_id(submission_id, source_id, request_fingerprint)
            if submission_id is not None and request_fingerprint is not None
            else None
        )
        delivery_task = {
            "operation": "deliver",
            "modelProfileId": profile_id,
            "inputArtifactIds": [source_id],
            "delivery": delivery_request,
        }
        if receipt_id is not None:
            delivery_task["deliveryReceiptId"] = receipt_id
        try:
            receipt = run_delivery_task(
                delivery_task,
                project_root,
                artifact_root,
                cfg,
            )
        except Exception:
            receipt = {
                "ok": True,
                "sourceArtifactId": source_id,
                "deliveryReady": False,
                "artifacts": [],
                "qa": None,
                "warnings": [
                    "local delivery failed; the generated API original was preserved"
                ],
            }
        deliveries.append(receipt)
    return deliveries


def inline_delivery_receipt_id(
    submission_id: str,
    source_id: str,
    request_fingerprint: str,
) -> str:
    canonical = f"{submission_id}\0{source_id}\0{request_fingerprint}"
    return f"delivery_{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"


def resolve_machine_transparency(
    task: dict[str, Any],
    *,
    prompt: str,
    operation: str,
    params: dict[str, Any],
    cfg: Config,
    repository: ArtifactRepository,
    reference_paths: tuple[Path, ...],
) -> ResolvedTransparency | None:
    value = task.get("transparency")
    delivery = task.get("delivery")
    if value is None and isinstance(delivery, dict):
        value = delivery.get("transparency")
    if value is None:
        return None
    try:
        request = parse_transparency_request(value)
    except ValueError as exc:
        raise MachineTaskError("invalid_task", str(exc)) from exc
    mask_path: Path | None = None
    mask_image_id = request.get("maskImageId")
    if mask_image_id is not None:
        try:
            validate_artifact_id(mask_image_id)
        except ValueError as exc:
            raise MachineTaskError("invalid_task", str(exc)) from exc
        try:
            mask_path, _ = repository.get_image_snapshot(mask_image_id)
        except (KeyError, FileNotFoundError) as exc:
            raise MachineTaskError(
                "artifact_not_found",
                f"transparency mask artifact is unavailable: {mask_image_id}",
            ) from exc
    try:
        return resolve_transparency_request(
            value,
            prompt=prompt,
            model=cfg.model,
            mode=operation,
            size=str(params["size"]),
            postprocess_enabled=bool(cfg.postprocess.get("enabled")),
            policy=cfg.transparency,
            reference_paths=reference_paths,
            mask_path=mask_path,
        )
    except ValueError as exc:
        raise MachineTaskError("invalid_task", str(exc)) from exc


def validate_inline_delivery(
    task: dict[str, Any],
    transparency: ResolvedTransparency | None,
) -> None:
    value = task.get("delivery")
    if value is None:
        return
    if not isinstance(value, dict):
        raise MachineTaskError("invalid_task", "delivery must be an object")
    delivery = dict(value)
    explicit_transparency = delivery.pop("transparency", None)
    try:
        image_delivery.parse_delivery_request(
            delivery,
            transparency_requested=(
                transparency is not None or explicit_transparency is not None
            ),
        )
    except DeliveryError as exc:
        raise MachineTaskError(exc.code, str(exc)) from exc


def validate_inline_transparency_override(
    task: dict[str, Any],
    *,
    prompt: str,
    operation: str,
    params: dict[str, Any],
    cfg: Config,
    repository: ArtifactRepository,
    reference_paths: tuple[Path, ...],
) -> None:
    delivery = task.get("delivery")
    if not isinstance(delivery, dict) or delivery.get("transparency") is None:
        return
    if task.get("transparency") is None:
        # resolve_machine_transparency already resolved the nested request.
        return
    resolve_machine_transparency(
        {"transparency": delivery["transparency"]},
        prompt=prompt,
        operation=operation,
        params=params,
        cfg=cfg,
        repository=repository,
        reference_paths=reference_paths,
    )


def resolve_delivery_transparency(
    source: Any,
    explicit_request: Any,
    cfg: Config,
    repository: ArtifactRepository,
) -> tuple[ResolvedTransparency | None, bytes | None]:
    metadata = source.metadata
    parameters = metadata.get("parameters")
    parameters = parameters if isinstance(parameters, dict) else {}
    stored_record = parameters.get("transparency")
    request_value = explicit_request
    mask_image_id: str | None = None
    if request_value is not None:
        request = parse_transparency_request(request_value)
        mask_image_id = request.get("maskImageId")
    elif isinstance(stored_record, dict):
        stored_mask_id = stored_record.get("maskImageId")
        mask_image_id = stored_mask_id if isinstance(stored_mask_id, str) else None
    else:
        return None, None

    mask_path: Path | None = None
    mask_bytes: bytes | None = None
    if mask_image_id is not None:
        mask_path, mask_bytes = repository.get_image_snapshot(mask_image_id)

    if request_value is not None:
        source_path, _ = repository.get_image_snapshot(str(metadata.get("id") or ""))
        size = parameters.get("size")
        if not isinstance(size, str) or not size:
            size = f"{metadata.get('width')}x{metadata.get('height')}"
        resolved = resolve_transparency_request(
            request_value,
            prompt=str(metadata.get("prompt") or ""),
            model=str(metadata.get("model") or cfg.model),
            mode=str(metadata.get("operation") or "derive"),
            size=size,
            postprocess_enabled=bool(cfg.postprocess.get("enabled")),
            policy=cfg.transparency,
            reference_paths=(source_path,),
            mask_path=mask_path,
        )
    else:
        resolved = restore_transparency_plan(
            stored_record,
            prompt=str(metadata.get("prompt") or ""),
            mask_path=mask_path,
        )
    return resolved, mask_bytes


def edit_submission_fingerprint(
    task: dict[str, Any],
    params: dict[str, Any],
) -> str:
    semantics = {
        "version": 1,
        "operation": "edit",
        "modelProfileId": task.get("modelProfileId"),
        "prompt": str(task.get("prompt") or "").strip(),
        "inputArtifactIds": task.get("inputArtifactIds") or [],
        "annotationId": task.get("annotationId"),
        "output": {key: value for key, value in params.items() if key != "timeout"},
        "hasMask": task.get("mask") is not None,
        "maskPolicy": task.get("maskPolicy"),
        "transparency": task.get("transparency"),
        "delivery": task.get("delivery"),
    }
    canonical = json.dumps(semantics, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

def resolve_machine_output(
    output: dict[str, Any],
    cfg: Config,
    *,
    count_limit: int = 10,
) -> dict[str, Any]:
    output_format = str(output.get("format") or cfg.defaults.get("output_format") or DEFAULT_FORMAT).lower()
    if output_format == "jpg":
        output_format = "jpeg"
    if output_format not in {"png", "jpeg", "webp"}:
        raise MachineTaskError("invalid_task", f"unsupported output format: {output_format}")
    try:
        count_value = output.get("count")
        count = int(1 if count_value is None else count_value)
        timeout = int(cfg.defaults.get("timeout_seconds") or DEFAULT_TIMEOUT_SECONDS)
    except (TypeError, ValueError) as exc:
        raise MachineTaskError("invalid_task", "count and timeout must be integers") from exc
    if count < 1 or count > count_limit:
        raise MachineTaskError(
            "invalid_task",
            f"count must be between 1 and {count_limit}",
        )
    size = str(output.get("size") or cfg.defaults.get("size") or DEFAULT_SIZE)
    parse_size(size)
    quality = str(output.get("quality") or cfg.defaults.get("quality") or DEFAULT_QUALITY)
    if quality not in {"auto", "low", "medium", "high"}:
        raise MachineTaskError("invalid_task", f"unsupported quality: {quality}")
    background = str(output.get("background") or "opaque")
    if background not in {"auto", "opaque"}:
        raise MachineTaskError("invalid_task", f"unsupported background: {background}")
    compression = output.get("compression")
    if compression is not None:
        try:
            compression = int(compression)
        except (TypeError, ValueError) as exc:
            raise MachineTaskError("invalid_task", "compression must be an integer") from exc
        if compression < 0 or compression > 100:
            raise MachineTaskError("invalid_task", "compression must be between 0 and 100")
    if timeout < 1:
        raise MachineTaskError("invalid_task", "timeout must be positive")
    return {
        "size": size,
        "quality": quality,
        "format": output_format,
        "count": count,
        "background": background,
        "compression": compression,
        "timeout": timeout,
    }


def machine_mime_type(output_format: str) -> str:
    return "image/jpeg" if output_format == "jpeg" else f"image/{output_format}"


def redact_machine_error(
    message: str,
    cfg: Config | None,
    project_root: Path,
    *,
    config_path: Path | None = None,
) -> str:
    redacted = message
    secrets_to_remove = [str(project_root.absolute()), str(SKILL_DIR)]
    if config_path is not None:
        secrets_to_remove.append(str(Path(config_path).absolute()))
    if cfg is not None:
        secrets_to_remove.extend([cfg.api_key, cfg.base_url])
    for value in secrets_to_remove:
        if value:
            redacted = redacted.replace(value, "[REDACTED]")
            redacted = redacted.replace(value.replace("\\", "/"), "[REDACTED]")
    return redacted[:1000]


def machine_command(args: argparse.Namespace) -> int:
    try:
        envelope = json.loads(sys.stdin.read())
    except json.JSONDecodeError as exc:
        result = {"ok": False, "error": {"code": "invalid_json", "message": f"invalid JSON: {exc.msg}"}}
    else:
        if not isinstance(envelope, dict):
            envelope = {}
        effective_config_json = envelope.get("effectiveConfigJson")
        config_snapshot = (
            effective_config_json.encode("utf-8")
            if isinstance(effective_config_json, str)
            else None
        )
        result = run_machine_task(
            envelope.get("task"),
            Path(args.project_root),
            Path(args.artifact_root),
            config_snapshot=config_snapshot,
            config_sha256=envelope.get("effectiveConfigSha256"),
        )
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    if not result.get("ok"):
        print(f"image task failed: {result['error']['code']}", file=sys.stderr)
        return 1
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("machine", nargs="?", default="machine")
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--artifact-root", required=True)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return machine_command(args)
    except ImagegenError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"error: unexpected failure: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
