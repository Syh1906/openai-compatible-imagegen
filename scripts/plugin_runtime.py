#!/usr/bin/env python3
"""OpenAI-compatible image generation helper for Codex skills."""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import hashlib
import json
import mimetypes
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any


SKILL_DIR = Path(__file__).resolve().parents[1]
if str(SKILL_DIR) not in sys.path:
    sys.path.insert(0, str(SKILL_DIR))

from scripts.artifact_repository import ArtifactRepository
from scripts.image_download import ImageDownloadError, download_image_url
from scripts.imagegen_cli import build_parser as build_cli_parser
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
    DEFAULT_MODEL,
    DEFAULT_POSTPROCESS,
    DEFAULT_USER_AGENT,
    PLACEHOLDER_API_KEYS,
    ProviderConfigError,
    auth_setup_message,
    is_placeholder_api_key,
    normalize_model_capabilities,
    parse_config,
    resolve_api_key,
    resolve_postprocess_config,
    resolve_url_download_config,
    resolve_user_agent,
)
from scripts.windows_repository_fs import SubmissionLock


SUBMISSION_ID_PATTERN = re.compile(r"^sub_[0-9a-f]{32}$")


AUTH_PATH = SKILL_DIR / "auth.json"
EXAMPLE_AUTH_PATH = SKILL_DIR / "examples" / "auth.example.json"
DEFAULT_CONCURRENCY = 3
DEFAULT_TIMEOUT_SECONDS = 600
DEFAULT_SIZE = "1024x1024"
DEFAULT_QUALITY = "medium"
DEFAULT_FORMAT = "png"
DEFAULT_RESOLUTION = "1K"
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
    if args.transparent_background is not None:
        capabilities = data.get("capabilities") if isinstance(data.get("capabilities"), dict) else {}
        capabilities["transparent_background"] = bool(args.transparent_background)
        data["capabilities"] = capabilities

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


def validate_transparent_background_request(model: str, background: str | None, resolution: str | None) -> None:
    if background != "transparent":
        return
    if model == "gpt-image-2" and resolution in {"2K", "4K"}:
        raise ImagegenError(
            f"transparent background with gpt-image-2 at {resolution} is not supported. "
            "Ask the user to choose: switch to gpt-image-1.5 and keep transparent background, "
            "or keep gpt-image-2 and use background=auto."
        )


def resolve_common_params(args: argparse.Namespace, cfg: Config, task: dict[str, Any] | None = None) -> dict[str, Any]:
    task = task or {}
    asset = bool(get_value("asset", args, task, False))
    transparent = bool(get_value("transparent", args, task, False))
    fmt = normalize_format(get_value("format", args, task, None), cfg)
    if asset:
        fmt = "png"
    if transparent:
        fmt = "png"

    background = get_value("background", args, task, None)
    if transparent:
        background = "transparent" if cfg.capabilities.get("transparent_background") else None
    elif background == "transparent" and not cfg.capabilities.get("transparent_background"):
        background = None

    quality = get_value("quality", args, task, None) or cfg.defaults.get("quality") or DEFAULT_QUALITY
    model = get_value("model", args, task, None) or cfg.model
    size, aspect, resolution = resolve_size(args, cfg, task)
    validate_transparent_background_request(str(model), background, resolution)
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


def apply_prompt_directives(prompt: str, args: argparse.Namespace, task: dict[str, Any]) -> str:
    transparent = bool(get_value("transparent", args, task, False))
    asset = bool(get_value("asset", args, task, False))
    directives: list[str] = []
    if asset:
        directives.append("single isolated asset, centered composition, no text unless explicitly requested")
    if transparent:
        directives.append(
            "transparent background intent: isolated subject, clean alpha-friendly edges, no floor, no shadow backdrop, no solid background"
        )
    if not directives:
        return prompt
    lower_prompt = prompt.lower()
    additions = [item for item in directives if item.lower() not in lower_prompt]
    if not additions:
        return prompt
    return f"{prompt}\n\nGeneration constraints: {'; '.join(additions)}."


def get_value(name: str, args: argparse.Namespace, task: dict[str, Any], fallback: Any) -> Any:
    if name in task and task[name] not in (None, ""):
        return task[name]
    return getattr(args, name, fallback)


def api_url(cfg: Config, path: str) -> str:
    parsed = urllib.parse.urlparse(cfg.base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ImagegenError("auth.json base_url must be an http(s) URL ending in /v1")
    return f"{cfg.base_url}/{path.lstrip('/')}"


def request_json(cfg: Config, path: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    body = json.dumps(drop_none(payload)).encode("utf-8")
    req = urllib.request.Request(
        api_url(cfg, path),
        data=body,
        method="POST",
        headers=request_headers(cfg, "application/json"),
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = safe_error_body(exc)
        raise ImagegenError(f"API HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ImagegenError(f"API request failed: {exc.reason}") from exc


def request_multipart(
    cfg: Config,
    path: str,
    fields: dict[str, Any],
    files: list[tuple[str, Path] | tuple[str, Path, bytes]],
    timeout: int,
) -> dict[str, Any]:
    boundary = f"----codex-imagegen-{int(time.time() * 1000)}"
    body = build_multipart_body(boundary, fields, files)
    req = urllib.request.Request(
        api_url(cfg, path),
        data=body,
        method="POST",
        headers=request_headers(cfg, f"multipart/form-data; boundary={boundary}"),
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = safe_error_body(exc)
        raise ImagegenError(f"API HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ImagegenError(f"API request failed: {exc.reason}") from exc


def request_headers(cfg: Config, content_type: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {cfg.api_key}",
        "Content-Type": content_type,
        "Accept": "application/json",
        "User-Agent": cfg.user_agent,
    }


def build_multipart_body(
    boundary: str,
    fields: dict[str, Any],
    files: list[tuple[str, Path] | tuple[str, Path, bytes]],
) -> bytes:
    chunks: list[bytes] = []
    for name, value in drop_none(fields).items():
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
                str(value).encode("utf-8"),
                b"\r\n",
            ]
        )
    for upload in files:
        field_name, path = upload[:2]
        if not path.is_file():
            raise ImagegenError(f"input file not found: {path}")
        snapshot = upload[2] if len(upload) == 3 else path.read_bytes()
        if not isinstance(snapshot, bytes):
            raise ImagegenError("multipart file snapshot must be bytes")
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                (
                    f'Content-Disposition: form-data; name="{field_name}"; '
                    f'filename="{path.name}"\r\n'
                ).encode(),
                f"Content-Type: {mime}\r\n\r\n".encode(),
                snapshot,
                b"\r\n",
            ]
        )
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks)


def safe_error_body(exc: urllib.error.HTTPError) -> str:
    try:
        text = exc.read().decode("utf-8", errors="replace")
    except Exception:
        return exc.reason
    return text[:2000]


def drop_none(values: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None}


def generate(cfg: Config, args: argparse.Namespace, task: dict[str, Any] | None = None) -> dict[str, Any]:
    task = task or {}
    prompt = str(get_value("prompt", args, task, "") or "").strip()
    if not prompt:
        raise ImagegenError("prompt is required")
    params = resolve_common_params(args, cfg, task)
    prompt = apply_prompt_directives(prompt, args, task)
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
    written = write_response_images(
        response,
        out_file,
        params["output_format"],
        cfg.user_agent,
        params["direct_url_download"],
    )
    return success_record(task, prompt, "generate", written, params)


def edit(cfg: Config, args: argparse.Namespace, task: dict[str, Any] | None = None) -> dict[str, Any]:
    task = task or {}
    prompt = str(get_value("prompt", args, task, "") or "").strip()
    if not prompt:
        raise ImagegenError("prompt is required")

    images_value = task.get("images") if "images" in task else getattr(args, "image", None)
    image_paths = normalize_paths(images_value)
    if not image_paths:
        raise ImagegenError("edit requires at least one --image")
    mask_value = task.get("mask") if "mask" in task else getattr(args, "mask", None)
    mask_path = Path(mask_value).expanduser().resolve() if mask_value else None

    params = resolve_common_params(args, cfg, task)
    prompt = apply_prompt_directives(prompt, args, task)
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
    response = request_multipart(cfg, "images/edits", fields, files, params["timeout"])
    written = write_response_images(
        response,
        out_file,
        params["output_format"],
        cfg.user_agent,
        params["direct_url_download"],
    )
    return success_record(task, prompt, "edit", written, params)


def normalize_paths(value: Any) -> list[Path]:
    if not value:
        return []
    values = value if isinstance(value, list) else [value]
    return [Path(str(item)).expanduser().resolve() for item in values if str(item).strip()]


def resolve_output_file(args: argparse.Namespace, task: dict[str, Any], fmt: str, prompt: str) -> Path:
    file_value = task.get("file") or getattr(args, "file", None)
    if file_value:
        return Path(str(file_value)).expanduser().resolve()

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
) -> list[str]:
    out_file.parent.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    images = decode_response_images(response, user_agent, direct_url_download)
    for index, raw in enumerate(images):
        target = numbered_path(out_file, index, len(images), fmt)
        target.write_bytes(raw)
        written.append(str(target))
    return written


def decode_response_images(
    response: dict[str, Any],
    user_agent: str,
    direct_url_download: bool = False,
) -> list[bytes]:
    data = response.get("data")
    if not isinstance(data, list) or not data:
        raise ImagegenError("API response did not include data images")
    images = [
        decode_image_item(item, user_agent, direct_url_download)
        for item in data
        if isinstance(item, dict)
    ]
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
            return download_image_url(
                url,
                user_agent,
                DEFAULT_TIMEOUT_SECONDS,
                direct_url_download,
            )
        except ImageDownloadError as exc:
            raise ImagegenError(str(exc)) from exc
    raise ImagegenError("image item has neither b64_json nor url")


def inspect_image_file(path: Path) -> dict[str, Any]:
    image = read_png_rgba(path)
    bbox = alpha_bbox(image["pixels"], image["width"], image["height"])
    return {
        "path": display_path(path),
        "format": "png",
        "width": image["width"],
        "height": image["height"],
        "mode": "rgba",
        "has_alpha": any(pixel[3] < 255 for pixel in image["pixels"]),
        "alpha_bbox": list(bbox) if bbox else None,
        "nontransparent_pixels": sum(1 for pixel in image["pixels"] if pixel[3] > 0),
    }


def normalize_image_file(source: Path, output: Path, delivery_size: tuple[int, int]) -> dict[str, Any]:
    image = read_png_rgba(source)
    resized = resize_nearest(image["pixels"], image["width"], image["height"], delivery_size[0], delivery_size[1])
    write_png_rgba(output, delivery_size[0], delivery_size[1], resized)
    return {
        "source": display_path(source),
        "file": display_path(output),
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
            resized = fit_to_canvas(cropped, crop_w, crop_h, delivery_size[0], delivery_size[1])
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
        decoded = decode_png_rgba(path.read_bytes())
    except ValueError as exc:
        raise ImagegenError(str(exc)) from exc
    pixels = [
        tuple(decoded.pixels[index : index + 4])
        for index in range(0, len(decoded.pixels), 4)
    ]
    return {"width": decoded.width, "height": decoded.height, "pixels": pixels}


def write_png_rgba(path: Path, width: int, height: int, pixels: list[tuple[int, int, int, int]]) -> None:
    if len(pixels) != width * height:
        raise ImagegenError("pixel count does not match image dimensions")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.write_bytes(encode_png_rgba(width, height, bytes(channel for pixel in pixels for channel in pixel)))
    except ValueError as exc:
        raise ImagegenError(str(exc)) from exc


def alpha_bbox(
    pixels: list[tuple[int, int, int, int]],
    width: int,
    height: int,
) -> tuple[int, int, int, int] | None:
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
    return (min_x, min_y, max_x, max_y)


def crop_pixels(
    pixels: list[tuple[int, int, int, int]],
    source_w: int,
    source_h: int,
    left: int,
    top: int,
    width: int,
    height: int,
) -> list[tuple[int, int, int, int]]:
    if left < 0 or top < 0 or width < 1 or height < 1 or left + width > source_w or top + height > source_h:
        raise ImagegenError("crop is outside image bounds")
    return [pixels[(top + y) * source_w + left + x] for y in range(height) for x in range(width)]


def grid_edges(length: int, parts: int) -> list[int]:
    if parts < 1 or length < parts:
        raise ImagegenError("grid parts must fit inside the image dimensions")
    return [round(index * length / parts) for index in range(parts + 1)]


def resize_nearest(
    pixels: list[tuple[int, int, int, int]],
    source_w: int,
    source_h: int,
    target_w: int,
    target_h: int,
) -> list[tuple[int, int, int, int]]:
    if target_w < 1 or target_h < 1:
        raise ImagegenError("target size must be positive")
    return [
        pixels[min(source_h - 1, (y * source_h) // target_h) * source_w + min(source_w - 1, (x * source_w) // target_w)]
        for y in range(target_h)
        for x in range(target_w)
    ]


def fit_to_canvas(
    pixels: list[tuple[int, int, int, int]],
    source_w: int,
    source_h: int,
    target_w: int,
    target_h: int,
) -> list[tuple[int, int, int, int]]:
    scale = min(target_w / source_w, target_h / source_h)
    scaled_w = max(1, int(round(source_w * scale)))
    scaled_h = max(1, int(round(source_h * scale)))
    scaled = resize_nearest(pixels, source_w, source_h, scaled_w, scaled_h)
    canvas = [(0, 0, 0, 0)] * (target_w * target_h)
    offset_x = (target_w - scaled_w) // 2
    offset_y = (target_h - scaled_h) // 2
    for y in range(scaled_h):
        for x in range(scaled_w):
            canvas[(offset_y + y) * target_w + offset_x + x] = scaled[y * scaled_w + x]
    return canvas


def strip_data_url_prefix(value: str) -> str:
    if value.startswith("data:") and "," in value:
        return value.split(",", 1)[1]
    return value


def numbered_path(out_file: Path, index: int, count: int, fmt: str) -> Path:
    suffix = out_file.suffix or f".{fmt}"
    if count == 1:
        return out_file.with_suffix(suffix)
    return out_file.with_name(f"{out_file.stem}_{index + 1}{suffix}")


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
    written: list[str],
    params: dict[str, Any],
) -> dict[str, Any]:
    return {
        "id": task.get("id"),
        "mode": mode,
        "ok": True,
        "prompt": prompt,
        "files": written,
        "params": {key: value for key, value in params.items() if key != "timeout"},
    }


def apply_postprocess(record: dict[str, Any], args: argparse.Namespace, cfg: Config) -> dict[str, Any]:
    if not record.get("ok"):
        return record
    explicit = any(
        [
            bool(getattr(args, "postprocess", False)),
            bool(getattr(args, "delivery_size", None)),
            bool(getattr(args, "grid", None)),
        ]
    )
    if not explicit and not cfg.postprocess.get("enabled"):
        return record

    delivery_value = getattr(args, "delivery_size", None)
    if not delivery_value:
        return record
    delivery_size = parse_size(str(delivery_value))
    grid_value = getattr(args, "grid", None)
    expected_count = getattr(args, "expected_count", None)
    out_dir_value = getattr(args, "postprocess_out_dir", None)

    output_files: list[str] = []
    postprocess_results: list[dict[str, Any]] = []
    original_files = list(record.get("files", []))
    for file_text in original_files:
        source = Path(file_text).expanduser().resolve()
        if out_dir_value:
            out_dir = Path(out_dir_value).expanduser().resolve()
        else:
            out_dir = source.parent / f"{source.stem}-postprocess"
        if grid_value:
            rows, cols = parse_grid(str(grid_value))
            result = split_grid_image(source, out_dir, rows, cols, delivery_size, expected_count=expected_count)
            output_files.extend(item["file"] for item in result["outputs"])
            postprocess_results.append(result)
        else:
            target = out_dir / f"{source.stem}-{delivery_size[0]}x{delivery_size[1]}.png"
            result = normalize_image_file(source, target, delivery_size)
            output_files.append(result["file"])
            postprocess_results.append(result)

    updated = dict(record)
    updated["original_files"] = original_files
    updated["files"] = output_files
    updated["postprocess"] = postprocess_results
    return updated


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
            raise ImagegenError(f"invalid JSONL at line {line_no}: {exc}") from exc
        if not isinstance(task, dict):
            raise ImagegenError(f"invalid JSONL at line {line_no}: expected object")
        tasks.append(task)
    return tasks


def run_one_task(cfg: Config, base_args: argparse.Namespace, task: dict[str, Any]) -> dict[str, Any]:
    mode = str(task.get("mode") or "").strip().lower()
    if not mode:
        mode = "edit" if task.get("images") else "generate"
    try:
        if mode == "generate":
            return apply_postprocess(generate(cfg, base_args, task), base_args, cfg)
        if mode in {"edit", "multi-reference", "multi_reference"}:
            return apply_postprocess(edit(cfg, base_args, task), base_args, cfg)
        raise ImagegenError(f"unsupported batch mode: {mode}")
    except Exception as exc:
        return fail_record(task, mode, exc)


def batch(cfg: Config, args: argparse.Namespace) -> int:
    input_path = Path(args.input).expanduser().resolve()
    tasks = read_jsonl(input_path)
    out_dir = Path(args.out).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    for task in tasks:
        task.setdefault("out", str(out_dir))

    concurrency = args.concurrency or cfg.defaults.get("concurrency") or DEFAULT_CONCURRENCY
    try:
        concurrency = int(concurrency)
    except (TypeError, ValueError) as exc:
        raise ImagegenError(f"invalid concurrency: {concurrency}") from exc
    if concurrency < 1:
        raise ImagegenError("concurrency must be >= 1")

    results: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        future_map = {executor.submit(run_one_task, cfg, args, task): task for task in tasks}
        for future in concurrent.futures.as_completed(future_map):
            results.append(future.result())

    results.sort(key=lambda item: str(item.get("id") or ""))
    manifest = write_manifest(out_dir, results)
    print_summary(results, manifest)
    return 0 if all(item.get("ok") for item in results) else 1


def write_manifest(out_dir: Path, results: list[dict[str, Any]]) -> Path:
    manifest = out_dir / "manifest.json"
    payload = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "results": results,
        "summary": {
            "total": len(results),
            "ok": sum(1 for item in results if item.get("ok")),
            "failed": sum(1 for item in results if not item.get("ok")),
        },
    }
    manifest.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def print_summary(results: list[dict[str, Any]], manifest: Path | None = None) -> None:
    ok_count = sum(1 for item in results if item.get("ok"))
    failed_count = len(results) - ok_count
    for item in results:
        if item.get("ok"):
            for file_path in item.get("files", []):
                print(file_path)
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
        "capabilities": cfg.capabilities,
        "defaults": cfg.defaults,
        "postprocess": cfg.postprocess,
        "url_download": cfg.url_download,
        "auth_json": display_path(AUTH_PATH),
        "api_key_source": cfg.api_key_source,
        "api_key": "***REDACTED***",
    }
    print(json.dumps(defaults, ensure_ascii=False, indent=2))
    return 0


def inspect_image_command(args: argparse.Namespace) -> int:
    result = inspect_image_file(Path(args.file).expanduser().resolve())
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def normalize_command(args: argparse.Namespace) -> int:
    delivery_size = parse_size(args.delivery_size)
    result = normalize_image_file(
        Path(args.file).expanduser().resolve(),
        Path(args.out).expanduser().resolve(),
        delivery_size,
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
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


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
        if args.command == "machine":
            return machine_command(args)
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
    except ImagegenError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"error: unexpected failure: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
