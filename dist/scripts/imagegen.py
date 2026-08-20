#!/usr/bin/env python3
"""OpenAI-compatible image generation helper for Codex skills."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
for import_root in (SCRIPT_DIR, SKILL_DIR):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))

import image_transport
from scripts.image_download import (
    ImageDownloadError,
    download_image_url as _download_image_url,
    is_complete_image_data,
)
from provider_config import (
    DEFAULT_USER_AGENT,
    EffectiveImageConfig,
    ProviderConfigError,
    parse_standalone_config,
)
from image_preview import preview_board_image as build_preview_board
from image_cli import build_parser as build_cli_parser
from image_batch import (
    fail_record,
    normalize_batch_args,
    normalize_batch_shared,
    normalize_batch_tasks,
    prepare_batch_targets as plan_batch_targets,
    read_jsonl,
    task_mode,
    validate_output_path,
    write_manifest as write_batch_manifest,
)
from image_png import (
    PNG_SIGNATURE,
    alpha_bbox,
    crop_pixels as crop_png_pixels,
    grid_edges as png_grid_edges,
    read_png_rgba as read_png,
    write_png_rgba as write_png,
)
from image_qa import analyze_pixels, evaluate_delivery as evaluate_delivery_report, sha256_file
from image_reference import inspect_reference_metadata, normalize_paths
from image_postprocess import (
    PostprocessOperations,
    run as run_postprocess,
    validate_request as validate_postprocess_request,
)
from image_resize import fit_to_canvas as fit_pixels_to_canvas, resize_pixels
from image_transparency import (
    LOCAL_ROUTES,
    TransparencyPlan,
    TransparencyUnavailableError,
    normalize_route_options,
    parse_option_assignments,
    process_file as process_transparency_file,
)
from image_transparency_runtime import (
    apply_prompt_directives,
    resolve_request as resolve_transparency_request,
    transparent_intent,
)
from image_response import (
    MAX_IMAGE_RESPONSE_BYTES,
    MAX_JSON_RESPONSE_BYTES,
    decode_base64_image,
    detect_image_format,
    image_dimensions,
    publish_response_images,
    read_json_response,
    read_limited_bytes,
    safe_error_body,
)
from image_transaction import OutputTransaction, remap_transaction_paths


SKILL_DIR = Path(__file__).resolve().parents[1]
AUTH_PATH = SKILL_DIR / "auth.json"
EXAMPLE_AUTH_PATH = SKILL_DIR / "examples" / "auth.example.json"
DEFAULT_CONCURRENCY = 3
DEFAULT_TIMEOUT_SECONDS = 600
DEFAULT_MODEL = "gpt-image-2"
DEFAULT_SIZE = "1024x1024"
DEFAULT_QUALITY = "medium"
DEFAULT_FORMAT = "png"
DEFAULT_RESOLUTION = "1K"
MAX_IMAGES_PER_REQUEST = 16
SUPPORTED_ASPECTS = {"1:1", "16:9", "4:3", "3:4", "9:16"}
SUPPORTED_RESOLUTIONS = {"1K", "2K", "4K"}
SIZE_PRESETS = {
    ("1:1", "1K"): "1024x1024",
    ("16:9", "1K"): "1536x864",
    ("4:3", "1K"): "1536x1152",
    ("3:4", "1K"): "1152x1536",
    ("9:16", "1K"): "864x1536",
    ("1:1", "2K"): "2048x2048",
    ("16:9", "2K"): "2048x1152",
    ("4:3", "2K"): "2048x1536",
    ("3:4", "2K"): "1536x2048",
    ("9:16", "2K"): "1152x2048",
    ("1:1", "4K"): "4096x4096",
    ("16:9", "4K"): "3840x2160",
    ("4:3", "4K"): "4096x3072",
    ("3:4", "4K"): "3072x4096",
    ("9:16", "4K"): "2160x3840",
}
class ImagegenError(Exception):
    """User-facing script error."""


class ApiRequestError(ImagegenError):
    """An image API request was rejected or failed before an image existed."""

    def __init__(
        self,
        message: str,
        status_code: int | None = None,
        operation: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.operation = operation
        self.details = details or {}
        self.error_kind = (
            "api_rejected"
            if status_code is not None and 400 <= status_code < 500
            else "api_http_error"
        )


Config = EffectiveImageConfig


def load_config(require_api_key: bool = True) -> Config:
    if not AUTH_PATH.is_file():
        raise ImagegenError(
            f"missing auth.json: {display_path(AUTH_PATH)}\n"
            f"Run: python {display_path(Path(__file__).resolve().with_name('quick-init.py'))}\n"
            "Then run info to confirm the redacted configuration summary."
        )
    try:
        raw = json.loads(AUTH_PATH.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise ImagegenError(f"auth.json is not valid JSON: {exc}") from exc
    try:
        return parse_standalone_config(raw, require_api_key=require_api_key)
    except ProviderConfigError as exc:
        raise ImagegenError(str(exc)) from exc


def display_path(path: Path) -> str:
    return path.resolve().as_posix()


def init_auth(args: argparse.Namespace) -> int:
    if AUTH_PATH.exists() and not args.force:
        print(f"auth.json already exists: {display_path(AUTH_PATH)}")
        print("Use --force to recreate it. Existing api_key is never printed.")
        try:
            return info(load_config(require_api_key=False))
        except ImagegenError as exc:
            print(f"warning: {exc}", file=sys.stderr)
            return 0

    if not EXAMPLE_AUTH_PATH.is_file():
        raise ImagegenError(f"missing example auth template: {display_path(EXAMPLE_AUTH_PATH)}")
    try:
        data = json.loads(EXAMPLE_AUTH_PATH.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise ImagegenError(f"example auth template is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ImagegenError("example auth template must be a JSON object")

    if args.base_url:
        data["base_url"] = args.base_url.strip().rstrip("/")
    if args.model:
        data["model"] = args.model.strip()
    if args.api_key_env:
        data["api_key_env"] = args.api_key_env.strip()
    data.pop("capabilities", None)
    postprocess_value = getattr(args, "postprocess", None)
    if postprocess_value is not None:
        postprocess = data.get("postprocess") if isinstance(data.get("postprocess"), dict) else {}
        postprocess["enabled"] = bool(postprocess_value)
        data["postprocess"] = postprocess

    AUTH_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"created local auth config: {display_path(AUTH_PATH)}")
    print("Next steps:")
    print("1. Edit auth.json and set api_key, or set the configured api_key_env environment variable.")
    print(f"2. Run: python {display_path(Path(__file__).resolve())} info")
    return 0


def now_stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def slugify(value: str, limit: int = 40) -> str:
    output = []
    for char in value.lower():
        if char.isalnum():
            output.append(char)
        elif char in (" ", "-", "_"):
            output.append("-")
    slug = "".join(output).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return (slug[:limit].strip("-") or "image")


def normalize_format(value: str | None, cfg: Config) -> str:
    selected = value or str(cfg.defaults.get("output_format") or DEFAULT_FORMAT)
    selected = selected.lower().strip().lstrip(".")
    if selected not in {"png", "jpeg", "jpg", "webp"}:
        raise ImagegenError(f"unsupported format: {selected}")
    return "jpeg" if selected == "jpg" else selected


def normalize_aspect(value: Any) -> str | None:
    if value in (None, ""):
        return None
    selected = str(value).strip().replace(" ", "")
    if selected not in SUPPORTED_ASPECTS:
        raise ImagegenError(f"unsupported aspect: {selected}")
    return selected


def normalize_resolution(value: Any) -> str | None:
    if value in (None, ""):
        return None
    selected = str(value).strip().upper()
    if selected not in SUPPORTED_RESOLUTIONS:
        raise ImagegenError(f"unsupported resolution: {selected}")
    return selected


def resolve_size(args: argparse.Namespace, cfg: Config, task: dict[str, Any]) -> tuple[str, str | None, str | None]:
    explicit_size = get_value("size", args, task, None)
    if explicit_size:
        size = str(explicit_size)
        return size, None, infer_resolution_from_size(size)

    aspect = normalize_aspect(get_value("aspect", args, task, None) or cfg.defaults.get("aspect"))
    resolution = normalize_resolution(
        get_value("resolution", args, task, None) or cfg.defaults.get("resolution") or DEFAULT_RESOLUTION
    )
    if aspect:
        assert resolution is not None
        return SIZE_PRESETS[(aspect, resolution)], aspect, resolution

    size = str(cfg.defaults.get("size") or DEFAULT_SIZE)
    return size, None, infer_resolution_from_size(size)


def infer_resolution_from_size(size: str) -> str | None:
    try:
        width, height = parse_size(size)
    except ImagegenError:
        return None
    longest = max(width, height)
    if longest >= 3800:
        return "4K"
    if longest >= 2000:
        return "2K"
    return "1K"


def resolve_common_params(args: argparse.Namespace, cfg: Config, task: dict[str, Any] | None = None) -> dict[str, Any]:
    task = task or {}
    asset = bool(get_value("asset", args, task, False))
    background = normalize_background(get_value("background", args, task, None))
    transparent = transparent_intent(args, task)
    fmt = normalize_format(get_value("format", args, task, None), cfg)
    if asset:
        fmt = "png"
    if transparent:
        fmt = "png"

    quality = get_value("quality", args, task, None) or cfg.defaults.get("quality") or DEFAULT_QUALITY
    model = get_value("model", args, task, None) or cfg.model
    size, aspect, resolution = resolve_size(args, cfg, task)
    timeout = get_value("timeout", args, task, None) or cfg.defaults.get("timeout_seconds") or DEFAULT_TIMEOUT_SECONDS
    n = get_value("n", args, task, None) or 1

    try:
        timeout = int(timeout)
    except (TypeError, ValueError) as exc:
        raise ImagegenError(f"invalid timeout_seconds: {timeout}") from exc
    try:
        n = int(n)
    except (TypeError, ValueError) as exc:
        raise ImagegenError(f"invalid n: {n}") from exc
    if n < 1:
        raise ImagegenError("n must be >= 1")
    if n > MAX_IMAGES_PER_REQUEST:
        raise ImagegenError(f"n must be <= {MAX_IMAGES_PER_REQUEST}")

    output_compression = get_value("compression", args, task, None)
    if output_compression is not None:
        try:
            output_compression = int(output_compression)
        except (TypeError, ValueError) as exc:
            raise ImagegenError(f"invalid compression: {output_compression}") from exc
        if output_compression < 0 or output_compression > 100:
            raise ImagegenError("compression must be 0-100")

    return {
        "model": str(model),
        "size": str(size),
        "aspect": aspect,
        "resolution": resolution,
        "quality": str(quality),
        "n": n,
        "output_format": fmt,
        "background": background,
        "moderation": get_value("moderation", args, task, None),
        "output_compression": output_compression,
        "timeout": timeout,
        "direct_url_download": bool(
            cfg.url_download.get("proxy_mode") == "direct"
            or getattr(args, "allow_direct_url_download", False)
        ),
    }


def normalize_background(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ImagegenError(f"invalid background: {value}")
    background = value.strip().lower()
    if not background:
        return None
    if background == "transparent":
        raise ImagegenError("background=transparent has been removed; use transparent=true for delivery intent")
    if background not in {"auto", "opaque"}:
        raise ImagegenError(f"invalid background: {value}")
    return background


def get_value(name: str, args: argparse.Namespace, task: dict[str, Any], fallback: Any) -> Any:
    if name in task and task[name] not in (None, ""):
        return task[name]
    return getattr(args, name, fallback)


def resolve_request_transparency(
    prompt: str,
    mode: str,
    params: dict[str, Any],
    args: argparse.Namespace,
    cfg: Config,
    task: dict[str, Any],
    reference_paths: list[Path] | None = None,
) -> TransparencyPlan:
    try:
        plan = resolve_transparency_request(
            prompt,
            mode,
            params,
            args,
            cfg.postprocess,
            cfg.transparency,
            task,
            reference_paths,
        )
    except (TransparencyUnavailableError, ValueError) as exc:
        raise ImagegenError(str(exc)) from exc
    if plan.mode == "prompt-alpha" and params.get("background") == "opaque":
        raise ImagegenError(
            "transparent prompt-only delivery conflicts with background=opaque; "
            "remove the API background option or allow local post-processing"
        )
    return plan


def validate_postprocess_args(args: argparse.Namespace, task: dict[str, Any]) -> None:
    try:
        validate_postprocess_request(args, task)
    except ValueError as exc:
        raise ImagegenError(str(exc)) from exc


def api_url(cfg: Config, path: str) -> str:
    try:
        return image_transport.api_url(cfg.base_url, path)
    except ValueError as exc:
        raise ImagegenError("auth.json base_url must be an http(s) URL ending in /v1")



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
            proxy_url=cfg.proxy.get("url"),
        )
    except image_transport.TransportError as exc:
        if exc.status_code is not None:
            raise ApiRequestError(str(exc), exc.status_code, exc.operation or path) from exc
        raise ImagegenError(str(exc)) from exc
    except ValueError as exc:
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
            proxy_url=cfg.proxy.get("url"),
        )
    except image_transport.TransportError as exc:
        if exc.status_code is not None:
            raise ApiRequestError(str(exc), exc.status_code, exc.operation or path) from exc
        raise ImagegenError(str(exc)) from exc
    except ValueError as exc:
        raise ImagegenError(str(exc)) from exc


def request_headers(cfg: Config, content_type: str) -> dict[str, str]:
    return image_transport.request_headers(cfg.api_key, cfg.user_agent, content_type)


def build_multipart_body(
    boundary: str,
    fields: dict[str, Any],
    files: list[image_transport.MultipartUpload],
) -> bytes:
    try:
        return image_transport.build_multipart_body(boundary, fields, files)
    except ValueError as exc:
        raise ImagegenError(str(exc)) from exc


def drop_none(values: dict[str, Any]) -> dict[str, Any]:
    return image_transport.drop_none(values)


def generate(cfg: Config, args: argparse.Namespace, task: dict[str, Any] | None = None) -> dict[str, Any]:
    task = task or {}
    prompt = str(get_value("prompt", args, task, "") or "").strip()
    if not prompt:
        raise ImagegenError("prompt is required")
    params = resolve_common_params(args, cfg, task)
    transparency_plan = resolve_request_transparency(prompt, "generate", params, args, cfg, task)
    validate_postprocess_args(args, task)
    prompt = apply_prompt_directives(prompt, args, task, transparency_plan)
    out_file = resolve_output_file(args, task, params["output_format"], prompt)
    payload = {
        "model": params["model"],
        "prompt": prompt,
        "size": params["size"],
        "quality": params["quality"],
        "n": params["n"],
        "background": params["background"],
        "moderation": params["moderation"],
        "output_format": params["output_format"],
        "output_compression": params["output_compression"],
    }
    response = request_json(cfg, "images/generations", payload, params["timeout"])
    delivery = write_response_images(
        response,
        out_file,
        params["output_format"],
        cfg.user_agent,
        params["direct_url_download"],
        cfg.proxy.get("url"),
        expected_count=params["n"],
        expected_size=parse_size(params["size"]),
        planned_extra_dir=_planned_extra_dir(task),
    )
    return success_record(task, prompt, "generate", delivery, params, transparency_plan)


def edit(cfg: Config, args: argparse.Namespace, task: dict[str, Any] | None = None) -> dict[str, Any]:
    task = task or {}
    prompt = str(get_value("prompt", args, task, "") or "").strip()
    if not prompt:
        raise ImagegenError("prompt is required")

    images_value = task.get("images") if "images" in task else getattr(args, "image", None)
    image_paths = normalize_paths(images_value)
    if not image_paths:
        raise ImagegenError("edit requires at least one --image")
    reference_report = inspect_reference_metadata(image_paths)
    mask_value = task.get("mask") if "mask" in task else getattr(args, "mask", None)
    mask_path = Path(mask_value).expanduser().resolve() if mask_value else None

    params = resolve_common_params(args, cfg, task)
    transparency_plan = resolve_request_transparency(
        prompt,
        "edit",
        params,
        args,
        cfg,
        task,
        image_paths,
    )
    validate_postprocess_args(args, task)
    prompt = apply_prompt_directives(prompt, args, task, transparency_plan)
    out_file = resolve_output_file(args, task, params["output_format"], prompt)
    fields = {
        "model": params["model"],
        "prompt": prompt,
        "size": params["size"],
        "quality": params["quality"],
        "n": params["n"],
        "background": params["background"],
        "output_format": params["output_format"],
        "output_compression": params["output_compression"],
    }
    files = [("image[]", path) for path in image_paths]
    if mask_path:
        files.append(("mask", mask_path))
    try:
        response = request_multipart(cfg, "images/edits", fields, files, params["timeout"])
    except ApiRequestError as exc:
        exc.details["references"] = reference_report
        raise
    delivery = write_response_images(
        response,
        out_file,
        params["output_format"],
        cfg.user_agent,
        params["direct_url_download"],
        cfg.proxy.get("url"),
        expected_count=params["n"],
        expected_size=parse_size(params["size"]),
        planned_extra_dir=_planned_extra_dir(task),
    )
    return success_record(
        task,
        prompt,
        "edit",
        delivery,
        params,
        transparency_plan,
        references=reference_report,
    )


def resolve_output_file(args: argparse.Namespace, task: dict[str, Any], fmt: str, prompt: str) -> Path:
    file_value = task.get("file") or getattr(args, "file", None)
    if file_value:
        try:
            return validate_output_path(Path(str(file_value)).expanduser().resolve(), fmt)
        except ValueError as exc:
            raise ImagegenError(str(exc)) from exc

    out_dir = Path(str(task.get("out") or getattr(args, "out", "") or ".")).expanduser().resolve()
    task_id = str(task.get("id") or "").strip()
    name = task_id or f"{now_stamp()}-{slugify(prompt)}"
    return out_dir / f"{name}.{fmt}"


def write_response_images(
    response: dict[str, Any],
    out_file: Path,
    fmt: str,
    user_agent: str = DEFAULT_USER_AGENT,
    direct_url_download: bool = False,
    proxy_url: str | None = None,
    expected_count: int | None = None,
    expected_size: tuple[int, int] | None = None,
    planned_extra_dir: Path | None = None,
) -> dict[str, Any]:
    try:
        return publish_response_images(
            response,
            out_file,
            fmt,
            lambda item: decode_image_item(item, user_agent, direct_url_download, proxy_url),
            expected_count=expected_count,
            expected_size=expected_size,
            planned_extra_dir=planned_extra_dir,
        )
    except ValueError as exc:
        raise ImagegenError(str(exc)) from exc


def _planned_extra_dir(task: dict[str, Any]) -> Path | None:
    value = task.get("_api_extra_dir")
    return Path(str(value)).expanduser().resolve() if value else None


def decode_image_item(
    item: dict[str, Any],
    user_agent: str = DEFAULT_USER_AGENT,
    direct_url_download: bool = False,
    proxy_url: str | None = None,
) -> bytes:
    b64_value = item.get("b64_json")
    if isinstance(b64_value, str) and b64_value.strip():
        try:
            return decode_base64_image(strip_data_url_prefix(b64_value), MAX_IMAGE_RESPONSE_BYTES)
        except ValueError as exc:
            raise ImagegenError(str(exc)) from exc
    url = item.get("url")
    if isinstance(url, str) and url.strip():
        return download_image_url(url, user_agent, direct_url_download, proxy_url)
    raise ImagegenError("image item has neither b64_json nor url")


def download_image_url(
    url: str,
    user_agent: str = DEFAULT_USER_AGENT,
    direct_url_download: bool = False,
    proxy_url: str | None = None,
) -> bytes:
    try:
        return _download_image_url(
            url,
            user_agent,
            DEFAULT_TIMEOUT_SECONDS,
            direct_url_download=direct_url_download,
            proxy_url=proxy_url,
            direct_download_guidance=(
                "direct fallback is disabled. Ask the user before retrying with "
                "--allow-direct-url-download or enabling auth.json "
                "url_download.proxy_mode=direct"
            ),
            response_limit=MAX_IMAGE_RESPONSE_BYTES,
        )
    except ImageDownloadError as exc:
        raise ImagegenError(str(exc)) from exc


def inspect_image_file(path: Path, include_components: bool = False) -> dict[str, Any]:
    image = read_png_rgba(path)
    metrics = analyze_pixels(
        image["pixels"],
        image["width"],
        image["height"],
        include_components=include_components,
    )
    return {
        "path": display_path(path),
        "format": "png",
        "width": image["width"],
        "height": image["height"],
        "mode": "rgba",
        "has_alpha": any(pixel[3] < 255 for pixel in image["pixels"]),
        "sha256": sha256_file(path),
        **metrics,
    }


def evaluate_delivery(
    paths: list[Path],
    expectations: dict[str, Any] | None = None,
    conditions: list[dict[str, Any]] | None = None,
    source_paths: list[Path] | None = None,
) -> dict[str, Any]:
    return evaluate_delivery_report(
        paths,
        expectations=expectations,
        conditions=conditions,
        inspect_fn=inspect_image_file,
        source_paths=source_paths,
    )


def normalize_image_file(
    source: Path,
    output: Path,
    delivery_size: tuple[int, int],
    resample: str = "bilinear",
    fit_mode: str = "stretch",
    safe_margin: float = 0.0,
) -> dict[str, Any]:
    image = read_png_rgba(source)
    if fit_mode == "stretch":
        if safe_margin:
            raise ImagegenError("safe margin requires fit_mode=contain")
        resized = resize_pixels(
            image["pixels"],
            image["width"],
            image["height"],
            delivery_size[0],
            delivery_size[1],
            resample,
        )
    elif fit_mode == "contain":
        resized = fit_to_canvas(
            image["pixels"],
            image["width"],
            image["height"],
            delivery_size[0],
            delivery_size[1],
            resample=resample,
            safe_margin=safe_margin,
        )
    else:
        raise ImagegenError(f"unsupported fit mode: {fit_mode}")
    write_png_rgba(output, delivery_size[0], delivery_size[1], resized)
    return {
        "source": display_path(source),
        "file": display_path(output),
        "transform": {
            "delivery_size": list(delivery_size),
            "resample": resample,
            "fit": fit_mode,
            "safe_margin": safe_margin,
        },
        "input": inspect_image_payload(source, image),
        "output": inspect_image_file(output),
    }


def split_grid_image(
    source: Path,
    out_dir: Path,
    rows: int,
    cols: int,
    delivery_size: tuple[int, int],
    expected_count: int | None = None,
    resample: str = "bilinear",
    safe_margin: float = 0.0,
) -> dict[str, Any]:
    if rows < 1 or cols < 1:
        raise ImagegenError("grid rows and cols must be >= 1")
    count = rows * cols
    if expected_count is not None and expected_count != count:
        raise ImagegenError(f"grid count {count} does not match expected count {expected_count}")

    image = read_png_rgba(source)
    out_dir.mkdir(parents=True, exist_ok=True)
    x_edges = grid_edges(image["width"], cols)
    y_edges = grid_edges(image["height"], rows)
    outputs: list[dict[str, Any]] = []
    for row in range(rows):
        for col in range(cols):
            index = row * cols + col + 1
            cell_left = x_edges[col]
            cell_top = y_edges[row]
            cell_w = x_edges[col + 1] - cell_left
            cell_h = y_edges[row + 1] - cell_top
            cell = crop_pixels(
                image["pixels"],
                image["width"],
                image["height"],
                cell_left,
                cell_top,
                cell_w,
                cell_h,
            )
            cell_bbox = alpha_bbox(cell, cell_w, cell_h)
            if cell_bbox:
                content_left, content_top, content_right, content_bottom = cell_bbox
                cropped = crop_pixels(
                    cell,
                    cell_w,
                    cell_h,
                    content_left,
                    content_top,
                    content_right - content_left + 1,
                    content_bottom - content_top + 1,
                )
                crop_w = content_right - content_left + 1
                crop_h = content_bottom - content_top + 1
            else:
                cropped = cell
                crop_w = cell_w
                crop_h = cell_h
            resized = fit_to_canvas(
                cropped,
                crop_w,
                crop_h,
                delivery_size[0],
                delivery_size[1],
                resample=resample,
                safe_margin=safe_margin,
            )
            target = out_dir / f"{source.stem}_{index:02d}.png"
            write_png_rgba(target, delivery_size[0], delivery_size[1], resized)
            outputs.append(
                {
                    "index": index,
                    "row": row + 1,
                    "col": col + 1,
                    "source_cell": [cell_left, cell_top, cell_w, cell_h],
                    "content_bbox": list(cell_bbox) if cell_bbox else None,
                    "file": display_path(target),
                }
            )

    return {
        "source": display_path(source),
        "grid": {"rows": rows, "cols": cols, "count": count},
        "delivery_size": list(delivery_size),
        "resample": resample,
        "safe_margin": safe_margin,
        "outputs": outputs,
    }


def inspect_image_payload(path: Path, image: dict[str, Any]) -> dict[str, Any]:
    bbox = alpha_bbox(image["pixels"], image["width"], image["height"])
    return {
        "path": display_path(path),
        "format": "png",
        "width": image["width"],
        "height": image["height"],
        "has_alpha": any(pixel[3] < 255 for pixel in image["pixels"]),
        "alpha_bbox": list(bbox) if bbox else None,
    }


def read_png_rgba(path: Path) -> dict[str, Any]:
    try:
        return read_png(path)
    except (OSError, ValueError) as exc:
        raise ImagegenError(str(exc)) from exc


def write_png_rgba(path: Path, width: int, height: int, pixels: list[tuple[int, int, int, int]]) -> None:
    try:
        write_png(path, width, height, pixels)
    except (OSError, ValueError) as exc:
        raise ImagegenError(str(exc)) from exc


def crop_pixels(
    pixels: list[tuple[int, int, int, int]],
    source_w: int,
    source_h: int,
    left: int,
    top: int,
    width: int,
    height: int,
) -> list[tuple[int, int, int, int]]:
    try:
        return crop_png_pixels(pixels, source_w, source_h, left, top, width, height)
    except ValueError as exc:
        raise ImagegenError(str(exc)) from exc


def grid_edges(length: int, parts: int) -> list[int]:
    try:
        return png_grid_edges(length, parts)
    except ValueError as exc:
        raise ImagegenError(str(exc)) from exc


def resize_nearest(
    pixels: list[tuple[int, int, int, int]],
    source_w: int,
    source_h: int,
    target_w: int,
    target_h: int,
) -> list[tuple[int, int, int, int]]:
    try:
        return resize_pixels(pixels, source_w, source_h, target_w, target_h, "nearest")
    except ValueError as exc:
        raise ImagegenError(str(exc)) from exc


def fit_to_canvas(
    pixels: list[tuple[int, int, int, int]],
    source_w: int,
    source_h: int,
    target_w: int,
    target_h: int,
    resample: str = "bilinear",
    safe_margin: float = 0.0,
) -> list[tuple[int, int, int, int]]:
    try:
        return fit_pixels_to_canvas(
            pixels,
            source_w,
            source_h,
            target_w,
            target_h,
            resample=resample,
            safe_margin=safe_margin,
        )
    except ValueError as exc:
        raise ImagegenError(str(exc)) from exc


def preview_board_image(
    source: Path,
    out_dir: Path,
    sizes: list[tuple[int, int]],
    backgrounds: list[str],
    resample: str = "bilinear",
) -> dict[str, Any]:
    try:
        return build_preview_board(source, out_dir, sizes, backgrounds, resample)
    except (OSError, ValueError) as exc:
        raise ImagegenError(str(exc)) from exc


def strip_data_url_prefix(value: str) -> str:
    if value.startswith("data:") and "," in value:
        return value.split(",", 1)[1]
    return value


def parse_size(value: str) -> tuple[int, int]:
    parts = value.lower().replace("*", "x").split("x", 1)
    if len(parts) != 2:
        raise ImagegenError(f"invalid size: {value}")
    try:
        width = int(parts[0])
        height = int(parts[1])
    except ValueError as exc:
        raise ImagegenError(f"invalid size: {value}") from exc
    if width < 1 or height < 1:
        raise ImagegenError("size dimensions must be positive")
    return width, height


def parse_grid(value: str) -> tuple[int, int]:
    rows, cols = parse_size(value)
    return rows, cols


def success_record(
    task: dict[str, Any],
    prompt: str,
    mode: str,
    delivery: dict[str, Any],
    params: dict[str, Any],
    transparency_plan: TransparencyPlan | None = None,
    references: dict[str, Any] | None = None,
) -> dict[str, Any]:
    result = {
        "id": task.get("id"),
        "mode": mode,
        "ok": True,
        "delivery_ready": True,
        "prompt": prompt,
        "files": list(delivery["files"]),
        "original_files": list(delivery["files"]),
        "warnings": list(delivery.get("warnings", [])),
        "api_delivery": dict(delivery["api_delivery"]),
        "params": {key: value for key, value in params.items() if key != "timeout"},
    }
    if transparency_plan and transparency_plan.mode != "none":
        result["transparency"] = transparency_plan.to_record()
    if references is not None:
        result["references"] = references
    return result


def apply_postprocess(
    record: dict[str, Any],
    args: argparse.Namespace,
    cfg: Config,
    task: dict[str, Any] | None = None,
) -> dict[str, Any]:
    _ = cfg
    operations = PostprocessOperations(
        normalize=normalize_image_file,
        split_grid=split_grid_image,
        evaluate=evaluate_delivery,
    )
    try:
        return run_postprocess(record, args, task, operations)
    except ValueError as exc:
        raise ImagegenError(str(exc)) from exc


def run_one_task(cfg: Config, base_args: argparse.Namespace, task: dict[str, Any]) -> dict[str, Any]:
    mode = task_mode(task)
    try:
        if mode == "generate":
            return apply_postprocess(generate(cfg, base_args, task), base_args, cfg, task)
        if mode in {"edit", "multi-reference", "multi_reference"}:
            return apply_postprocess(edit(cfg, base_args, task), base_args, cfg, task)
        raise ImagegenError(f"unsupported batch mode: {mode}")
    except Exception as exc:
        return fail_record(task, mode, exc)


def batch(cfg: Config, args: argparse.Namespace) -> int:
    input_path = Path(args.input).expanduser().resolve()
    out_dir = Path(args.out).expanduser().resolve()
    tasks = normalize_batch_tasks(read_jsonl(input_path), input_path.parent, out_dir)
    batch_args = normalize_batch_args(args, input_path, out_dir)
    shared = normalize_batch_shared(
        {
            name: getattr(batch_args, name, None)
            for name in (
                "file",
                "format",
                "n",
                "transparent",
                "delivery_size",
                "grid",
                "postprocess_out_dir",
                "transparency_route",
                "transparency_mask",
                "transparency_param",
                "transparency_options",
            )
        },
        input_path.parent,
        out_dir,
    )
    try:
        plan_batch_targets(
            tasks,
            shared,
            out_dir,
            now_stamp(),
            slugify,
            lambda task: str(resolve_common_params(batch_args, cfg, task)["output_format"]),
            lambda task: resolve_batch_transparency(task, batch_args, cfg).mode in LOCAL_ROUTES,
        )
    except (TypeError, ValueError) as exc:
        raise ImagegenError(str(exc)) from exc

    out_dir.mkdir(parents=True, exist_ok=True)

    concurrency = args.concurrency or cfg.defaults.get("concurrency") or DEFAULT_CONCURRENCY
    try:
        concurrency = int(concurrency)
    except (TypeError, ValueError) as exc:
        raise ImagegenError(f"invalid concurrency: {concurrency}") from exc
    if concurrency < 1:
        raise ImagegenError("concurrency must be >= 1")

    results: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        future_map = {executor.submit(run_one_task, cfg, batch_args, task): task for task in tasks}
        for future in concurrent.futures.as_completed(future_map):
            results.append(future.result())

    results.sort(key=lambda item: str(item.get("id") or ""))
    manifest, path_contract_ok = write_batch_manifest(out_dir, results)
    print_summary(results, manifest)
    return 0 if all(item.get("ok") for item in results) and path_contract_ok else 1


def resolve_batch_transparency(
    task: dict[str, Any],
    args: argparse.Namespace,
    cfg: Config,
) -> TransparencyPlan:
    mode = task_mode(task)
    params = resolve_common_params(args, cfg, task)
    prompt = str(task.get("prompt") or "").strip()
    references = normalize_paths(task.get("images")) if mode == "edit" else []
    return resolve_request_transparency(prompt, mode, params, args, cfg, task, references)


def print_summary(results: list[dict[str, Any]], manifest: Path | None = None) -> None:
    ok_count = sum(1 for item in results if item.get("ok"))
    failed_count = len(results) - ok_count
    for item in results:
        if item.get("ok"):
            for file_path in item.get("files", []):
                print(file_path)
            for warning in item.get("warnings", []):
                print(f"WARNING {item.get('id') or ''}: {warning}", file=sys.stderr)
        else:
            print(f"FAILED {item.get('id') or ''}: {item.get('error')}", file=sys.stderr)
    if manifest:
        print(f"manifest: {manifest}")
    print(f"summary: ok={ok_count} failed={failed_count} total={len(results)}")


def info(cfg: Config) -> int:
    defaults = {
        "model": cfg.model,
        "base_url": cfg.base_url,
        "user_agent": cfg.user_agent,
        "defaults": cfg.defaults,
        "postprocess": cfg.postprocess,
        "transparency": {
            "default_route": cfg.transparency.default_route,
            "prompt_only_allow": [
                {"model": rule.model, "mode": rule.mode, "size": rule.size}
                for rule in cfg.transparency.prompt_only_allow
            ],
            "llm_assisted": cfg.transparency.llm_assisted.to_record(),
        },
        "url_download": cfg.url_download,
        "proxy": {"configured": bool(cfg.proxy.get("url"))},
        "script_path": display_path(Path(__file__).resolve()),
        "auth_json": display_path(AUTH_PATH),
        "api_key_source": cfg.api_key_source,
        "api_key": "***REDACTED***",
    }
    print(json.dumps(defaults, ensure_ascii=False, indent=2))
    return 0


def inspect_image_command(args: argparse.Namespace) -> int:
    path = Path(args.file).expanduser().resolve()
    if args.expected_size or args.expect_transparent:
        expectations: dict[str, Any] = {"components": args.components}
        if args.expected_size:
            expectations["expected_size"] = list(parse_size(args.expected_size))
        conditions = [{"kind": "transparent", "requested": True}] if args.expect_transparent else None
        result = evaluate_delivery([path], expectations=expectations, conditions=conditions)
    else:
        result = inspect_image_file(path, include_components=args.components)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def normalize_command(args: argparse.Namespace) -> int:
    delivery_size = parse_size(args.delivery_size)
    result = normalize_image_file(
        Path(args.file).expanduser().resolve(),
        Path(args.out).expanduser().resolve(),
        delivery_size,
        resample=args.resample,
        fit_mode=args.fit,
        safe_margin=args.safe_margin,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def split_grid_command(args: argparse.Namespace) -> int:
    rows, cols = parse_grid(args.grid)
    delivery_size = parse_size(args.delivery_size)
    result = split_grid_image(
        Path(args.file).expanduser().resolve(),
        Path(args.out_dir).expanduser().resolve(),
        rows=rows,
        cols=cols,
        delivery_size=delivery_size,
        expected_count=args.expected_count,
        resample=args.resample,
        safe_margin=args.safe_margin,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def preview_board_command(args: argparse.Namespace) -> int:
    sizes = [parse_size(value) for value in args.size]
    backgrounds = args.preview_background or ["transparent", "white", "black", "gray", "checker"]
    result = preview_board_image(
        Path(args.file).expanduser().resolve(),
        Path(args.out_dir).expanduser().resolve(),
        sizes=sizes,
        backgrounds=backgrounds,
        resample=args.resample,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def apply_transparency_command(args: argparse.Namespace) -> int:
    source = Path(args.file).expanduser().resolve()
    target = Path(args.out).expanduser().resolve()
    key = args.key.strip() if args.key else None
    mask_path = Path(args.transparency_mask).expanduser().resolve() if args.transparency_mask else None
    if args.route == "chroma-matting" and not key:
        raise ImagegenError("apply-transparency chroma-matting requires --key")
    if args.route != "chroma-matting" and key:
        raise ImagegenError(f"apply-transparency {args.route} does not accept --key")
    if args.route == "mask-alpha" and mask_path is None:
        raise ImagegenError("apply-transparency mask-alpha requires --transparency-mask")
    if args.route != "mask-alpha" and mask_path is not None:
        raise ImagegenError(f"apply-transparency {args.route} does not accept --transparency-mask")
    try:
        options = parse_option_assignments(args.transparency_param)
        normalized_options = normalize_route_options(args.route, options)
    except ValueError as exc:
        raise ImagegenError(str(exc)) from exc
    plan = TransparencyPlan(
        mode=args.route,
        prompt="",
        key_hex=key,
        mask_path=mask_path,
        options=normalized_options,
    )
    with OutputTransaction() as transaction:
        staged = transaction.stage_path(target)
        result = process_transparency_file(source, staged, plan)
        if result.get("status") == "pass" and result.get("changed"):
            mapping = transaction.commit()
            result = remap_transaction_paths(result, mapping)
        else:
            result["file"] = display_path(source)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    return build_cli_parser(SUPPORTED_ASPECTS, SUPPORTED_RESOLUTIONS)


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "inspect-image":
            return inspect_image_command(args)
        if args.command == "normalize":
            return normalize_command(args)
        if args.command == "split-grid":
            return split_grid_command(args)
        if args.command == "preview-board":
            return preview_board_command(args)
        if args.command == "apply-transparency":
            return apply_transparency_command(args)
        if args.command == "init":
            return init_auth(args)
        cfg = load_config(require_api_key=args.command != "info")
        if args.command == "info":
            return info(cfg)
        if args.command == "generate":
            result = apply_postprocess(generate(cfg, args), args, cfg)
            print_summary([result])
            return 0
        if args.command == "edit":
            result = apply_postprocess(edit(cfg, args), args, cfg)
            print_summary([result])
            return 0
        if args.command == "batch":
            return batch(cfg, args)
        raise ImagegenError(f"unsupported command: {args.command}")
    except ApiRequestError as exc:
        fields = [f"error_kind={exc.error_kind}"]
        if exc.status_code is not None:
            fields.append(f"status_code={exc.status_code}")
        if exc.operation:
            fields.append(f"operation={exc.operation}")
        print(f"error: {' '.join(fields)}: {exc}", file=sys.stderr)
        return 2
    except ImagegenError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"error: unexpected failure: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
