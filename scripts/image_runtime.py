#!/usr/bin/env python3
"""Codex Plugin machine adapter for OpenAI-compatible image tasks."""

from __future__ import annotations

import argparse
import base64
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

import image_transport
from scripts.artifact_repository import ArtifactRepository
from scripts.image_download import ImageDownloadError, download_image_url
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
    parse_config,
)
from scripts.windows_repository_fs import SubmissionLock


SUBMISSION_ID_PATTERN = re.compile(r"^sub_[0-9a-f]{32}$")


AUTH_PATH = SKILL_DIR / "auth.json"
DEFAULT_TIMEOUT_SECONDS = 600
DEFAULT_SIZE = "1024x1024"
DEFAULT_QUALITY = "medium"
DEFAULT_FORMAT = "png"
DEFAULT_RESOLUTION = "1K"


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
    auth_path = Path(config_path) if config_path is not None else AUTH_PATH
    if config_snapshot is None and not auth_path.is_file():
        raise ImagegenError(
            f"missing auth.json: {display_path(auth_path)}\n"
            f"Run: python {display_path(Path(__file__).resolve().with_name('quick-init.py'))}\n"
            "Then run info to confirm the redacted configuration summary."
        )
    try:
        snapshot = config_snapshot if config_snapshot is not None else auth_path.read_bytes()
        raw = json.loads(snapshot.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ImagegenError(f"auth.json is not valid JSON: {exc}") from exc

    try:
        return parse_config(
            raw,
            require_api_key=require_api_key,
            model_profile_id=model_profile_id,
            require_v2=config_path is not None,
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
            response_limit=None,
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
            response_limit=None,
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
) -> list[bytes]:
    data = response.get("data")
    if not isinstance(data, list) or not data:
        raise ImagegenError("API response did not include data images")
    images = [decode_image_item(item, user_agent, direct_url_download) for item in data if isinstance(item, dict)]
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
        return base64.b64decode(strip_data_url_prefix(b64_value))
    url = item.get("url")
    if isinstance(url, str) and url.strip():
        try:
            return download_image_url(url, user_agent, DEFAULT_TIMEOUT_SECONDS, direct_url_download)
        except ImageDownloadError as exc:
            raise ImagegenError(str(exc)) from exc
    raise ImagegenError("image item has neither b64_json nor url")


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


def infer_resolution_from_size(size: str) -> str | None:
    width, height = parse_size(size)
    longest = max(width, height)
    if longest <= 1536:
        return "1K"
    if longest <= 2048:
        return "2K"
    if longest <= 4096:
        return "4K"
    return None


def validate_transparent_background_request(model: str, background: str | None, resolution: str | None) -> None:
    if model == "gpt-image-2" and background == "transparent" and resolution in {"2K", "4K"}:
        raise ImagegenError(
            "gpt-image-2 transparent background is limited to 1K; "
            "choose a 1K size or use an opaque background"
        )


def run_machine_task(
    task: dict[str, Any],
    project_root: Path,
    artifact_root: Path,
    cfg: Config | None = None,
    config_path: Path | None = None,
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
        if operation not in {"generate", "edit", "list_models"}:
            raise MachineTaskError("invalid_task", f"unsupported operation: {operation or '(missing)'}")
        config_snapshot: bytes | None = None
        if config_path is not None:
            if not isinstance(config_sha256, str) or not re.fullmatch(r"[a-f0-9]{64}", config_sha256):
                raise MachineTaskError("v2_config_changed", "V2 configuration snapshot is unavailable")
            try:
                config_snapshot = Path(config_path).read_bytes()
                current_sha256 = hashlib.sha256(config_snapshot).hexdigest()
            except OSError as exc:
                raise MachineTaskError("v2_config_changed", "V2 configuration snapshot is unavailable") from exc
            if current_sha256 != config_sha256:
                raise MachineTaskError("v2_config_changed", "V2 configuration changed after project binding")
        effective_cfg = effective_cfg or load_config(
            require_api_key=operation != "list_models",
            config_path=config_path,
            model_profile_id=profile_id,
            config_snapshot=config_snapshot,
        )
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
                        "provider": profile_id.split("/", 1)[0],
                        "model": effective_cfg.model,
                        "capabilities": normalize_model_capabilities(effective_cfg.capabilities),
                    }
                ],
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
        params = resolve_machine_output(output, effective_cfg)
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
                return {"ok": True, "artifacts": committed}
        parent_uploads = [repository.get_image_snapshot(artifact_id) for artifact_id in input_ids]
        parent_paths = [path for path, _ in parent_uploads]
        try:
            masked_context = prepare_masked_edit(
                task,
                params,
                Path(artifact_root),
                parent_paths[0] if parent_paths else Path(),
                parent_uploads[0][1] if parent_uploads else b"",
                prompt,
            )
        except ValueError as exc:
            raise MachineTaskError("invalid_task", str(exc)) from exc
        request_prompt = masked_context.effective_prompt if masked_context else prompt
        payload = {
            "model": "gpt-image-2",
            "prompt": request_prompt,
            "size": params["size"],
            "quality": params["quality"],
            "n": 1 if operation == "generate" else params["count"],
            "background": params["background"],
            "output_format": params["format"],
            "output_compression": params["compression"],
        }
        if operation == "generate":
            images: list[bytes] = []
            for candidate_index in range(params["count"]):
                response = request_json(effective_cfg, "images/generations", payload, params["timeout"])
                candidate_images = decode_response_images(
                    response,
                    effective_cfg.user_agent,
                    effective_cfg.url_download.get("proxy_mode") == "direct",
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
            images = decode_response_images(
                response,
                effective_cfg.user_agent,
                effective_cfg.url_download.get("proxy_mode") == "direct",
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
        mime_type = machine_mime_type(params["format"])
        stored_parameters = {key: value for key, value in params.items() if key != "timeout"}
        if masked_context:
            stored_parameters.update(masked_edit_audit(masked_context))
        if submission_id:
            stored_parameters["submissionId"] = submission_id
            stored_parameters["submissionRequestFingerprint"] = request_fingerprint
        records = repository.store_images(
            images=images,
            mime_type=mime_type,
            provider="primary",
            model="gpt-image-2",
            operation=operation,
            prompt=prompt,
            parameters=stored_parameters,
            parent_ids=parent_ids,
            annotation_id=task.get("annotationId"),
        )
        return {"ok": True, "artifacts": [record.metadata for record in records]}
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
                    config_path=config_path,
                ),
            },
        }
    finally:
        if submission_lock is not None:
            submission_lock.release()


def edit_submission_fingerprint(task: dict[str, Any], params: dict[str, Any]) -> str:
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
    }
    canonical = json.dumps(semantics, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

def resolve_machine_output(output: dict[str, Any], cfg: Config) -> dict[str, Any]:
    output_format = str(output.get("format") or cfg.defaults.get("output_format") or DEFAULT_FORMAT).lower()
    if output_format == "jpg":
        output_format = "jpeg"
    if output_format not in {"png", "jpeg", "webp"}:
        raise MachineTaskError("invalid_task", f"unsupported output format: {output_format}")
    try:
        count = int(output.get("count") or 1)
        timeout = int(cfg.defaults.get("timeout_seconds") or DEFAULT_TIMEOUT_SECONDS)
    except (TypeError, ValueError) as exc:
        raise MachineTaskError("invalid_task", "count and timeout must be integers") from exc
    if count < 1 or count > 10:
        raise MachineTaskError("invalid_task", "count must be between 1 and 10")
    size = str(output.get("size") or cfg.defaults.get("size") or DEFAULT_SIZE)
    parse_size(size)
    quality = str(output.get("quality") or cfg.defaults.get("quality") or DEFAULT_QUALITY)
    if quality not in {"auto", "low", "medium", "high"}:
        raise MachineTaskError("invalid_task", f"unsupported quality: {quality}")
    background = str(output.get("background") or "opaque")
    if background not in {"auto", "opaque", "transparent"}:
        raise MachineTaskError("invalid_task", f"unsupported background: {background}")
    if background == "transparent" and cfg.capabilities.get("transparent_background") is not True:
        raise MachineTaskError(
            "unsupported_capability",
            "configured model profile does not support transparent background",
        )
    validate_transparent_background_request("gpt-image-2", background, infer_resolution_from_size(size))
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
        task = json.loads(sys.stdin.read())
    except json.JSONDecodeError as exc:
        result = {"ok": False, "error": {"code": "invalid_json", "message": f"invalid JSON: {exc.msg}"}}
    else:
        result = run_machine_task(
            task,
            Path(args.project_root),
            Path(args.artifact_root),
            config_path=Path(args.config) if args.config else None,
            config_sha256=args.config_sha256,
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
    parser.add_argument("--config")
    parser.add_argument("--config-sha256")
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
