#!/usr/bin/env python3
"""OpenAI-compatible image generation helper for Codex skills."""

from __future__ import annotations

import argparse
import concurrent.futures
import http.client
import json
import mimetypes
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from image_preview import preview_board_image as build_preview_board
from image_cli import build_parser as build_cli_parser
from image_batch import fail_record, prepare_batch_targets as plan_batch_targets, read_jsonl, validate_output_path
from image_png import (
    PNG_SIGNATURE,
    alpha_bbox,
    crop_pixels as crop_png_pixels,
    grid_edges as png_grid_edges,
    read_png_rgba as read_png,
    write_png_rgba as write_png,
)
from image_qa import analyze_pixels, evaluate_delivery as evaluate_delivery_report, sha256_file
from image_resize import fit_to_canvas as fit_pixels_to_canvas, resize_pixels
from image_transaction import OutputTransaction, remap_transaction_paths
from image_response import (
    MAX_IMAGE_RESPONSE_BYTES,
    MAX_JSON_RESPONSE_BYTES,
    decode_base64_image,
    detect_image_format,
    read_json_response,
    read_limited_bytes,
    safe_error_body,
)


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
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
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
DEFAULT_POSTPROCESS = {
    "enabled": False,
}
DEFAULT_URL_DOWNLOAD = {"proxy_mode": "environment"}
PLACEHOLDER_API_KEYS = {
    "",
    "replace-with-temporary-local-key",
    "replace-with-your-api-key",
    "your-api-key",
    "changeme",
}


class ImagegenError(Exception):
    """User-facing script error."""


@dataclass(frozen=True)
class Config:
    base_url: str
    api_key: str
    api_key_source: str
    model: str
    defaults: dict[str, Any]
    capabilities: dict[str, Any]
    postprocess: dict[str, Any]
    user_agent: str = DEFAULT_USER_AGENT
    url_download: dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_URL_DOWNLOAD))


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

    base_url = str(raw.get("base_url") or "").strip().rstrip("/")
    file_api_key = str(raw.get("api_key") or "").strip()
    api_key_env = str(raw.get("api_key_env") or "").strip()
    api_key, api_key_source = resolve_api_key(file_api_key, api_key_env)
    model = str(raw.get("model") or DEFAULT_MODEL).strip()
    user_agent = resolve_user_agent(raw.get("user_agent"))
    defaults = raw.get("defaults") if isinstance(raw.get("defaults"), dict) else {}
    capabilities = raw.get("capabilities") if isinstance(raw.get("capabilities"), dict) else {}
    postprocess = resolve_postprocess_config(raw.get("postprocess"))
    url_download = resolve_url_download_config(raw.get("url_download"))

    if not base_url:
        raise ImagegenError("auth.json missing base_url")
    if require_api_key and not api_key:
        raise ImagegenError(auth_setup_message(file_api_key, api_key_env))
    if not model:
        raise ImagegenError("auth.json missing model")
    return Config(
        base_url=base_url,
        api_key=api_key,
        api_key_source=api_key_source,
        model=model,
        defaults=defaults,
        capabilities=capabilities,
        postprocess=postprocess,
        user_agent=user_agent,
        url_download=url_download,
    )


def resolve_postprocess_config(value: Any) -> dict[str, Any]:
    cfg = dict(DEFAULT_POSTPROCESS)
    if isinstance(value, dict):
        for key in DEFAULT_POSTPROCESS:
            if key in value:
                cfg[key] = bool(value[key])
    return cfg


def resolve_url_download_config(value: Any) -> dict[str, Any]:
    cfg = dict(DEFAULT_URL_DOWNLOAD)
    if value is None:
        return cfg
    if not isinstance(value, dict):
        raise ImagegenError("auth.json url_download must be an object")
    proxy_mode = value.get("proxy_mode", "environment")
    if proxy_mode not in {"environment", "direct"}:
        raise ImagegenError("auth.json url_download.proxy_mode must be environment or direct")
    cfg["proxy_mode"] = proxy_mode
    return cfg


def resolve_user_agent(value: Any) -> str:
    user_agent = str(value or DEFAULT_USER_AGENT).strip()
    if any(ord(char) < 32 or ord(char) == 127 for char in user_agent):
        raise ImagegenError("auth.json user_agent must not contain control characters")
    return user_agent


def resolve_api_key(file_api_key: str, api_key_env: str) -> tuple[str, str]:
    if file_api_key and not is_placeholder_api_key(file_api_key):
        return file_api_key, "auth.json api_key"
    if api_key_env:
        env_value = os.environ.get(api_key_env, "").strip()
        if env_value:
            return env_value, f"env:{api_key_env}"
    return "", "missing"


def is_placeholder_api_key(value: str) -> bool:
    return value.strip().lower() in PLACEHOLDER_API_KEYS


def auth_setup_message(file_api_key: str, api_key_env: str) -> str:
    if file_api_key and is_placeholder_api_key(file_api_key):
        if api_key_env:
            return (
                f"auth.json api_key is still a placeholder and {api_key_env} is not set.\n"
                "Edit auth.json api_key directly, or set that environment variable."
            )
        return "auth.json api_key is still a placeholder. Edit auth.json api_key or add api_key_env."
    if api_key_env:
        return f"auth.json missing api_key and environment variable {api_key_env} is not set."
    return "auth.json missing api_key. Edit auth.json api_key or add api_key_env."


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
    background = get_value("background", args, task, None)
    transparent = transparent_intent(args, task)
    fmt = normalize_format(get_value("format", args, task, None), cfg)
    if asset:
        fmt = "png"
    if transparent:
        fmt = "png"

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
    transparent = transparent_intent(args, task)
    asset = bool(get_value("asset", args, task, False))
    directives: list[str] = []
    if asset:
        directives.append("single visual deliverable, preserve the requested composition, no extra text unless explicitly requested")
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


def transparent_intent(args: argparse.Namespace, task: dict[str, Any]) -> bool:
    return bool(get_value("transparent", args, task, False)) or get_value("background", args, task, None) == "transparent"


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
            return read_json_response(resp, MAX_JSON_RESPONSE_BYTES)
    except urllib.error.HTTPError as exc:
        detail = safe_error_body(exc)
        raise ImagegenError(f"API HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ImagegenError(f"API request failed: {exc.reason}") from exc
    except ValueError as exc:
        raise ImagegenError(str(exc)) from exc


def request_multipart(
    cfg: Config,
    path: str,
    fields: dict[str, Any],
    files: list[tuple[str, Path]],
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
            return read_json_response(resp, MAX_JSON_RESPONSE_BYTES)
    except urllib.error.HTTPError as exc:
        detail = safe_error_body(exc)
        raise ImagegenError(f"API HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ImagegenError(f"API request failed: {exc.reason}") from exc
    except ValueError as exc:
        raise ImagegenError(str(exc)) from exc


def request_headers(cfg: Config, content_type: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {cfg.api_key}",
        "Content-Type": content_type,
        "Accept": "application/json",
        "User-Agent": cfg.user_agent,
    }


def build_multipart_body(boundary: str, fields: dict[str, Any], files: list[tuple[str, Path]]) -> bytes:
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
    for field_name, path in files:
        if not path.is_file():
            raise ImagegenError(f"input file not found: {path}")
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                (
                    f'Content-Disposition: form-data; name="{field_name}"; '
                    f'filename="{path.name}"\r\n'
                ).encode(),
                f"Content-Type: {mime}\r\n\r\n".encode(),
                path.read_bytes(),
                b"\r\n",
            ]
        )
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks)


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
        expected_count=params["n"],
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
        expected_count=params["n"],
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
    expected_count: int | None = None,
) -> list[str]:
    data = response.get("data")
    if not isinstance(data, list) or not data:
        raise ImagegenError("API response did not include data images")
    if any(not isinstance(item, dict) for item in data):
        bad_index = next(index for index, item in enumerate(data) if not isinstance(item, dict))
        raise ImagegenError(f"API response data[{bad_index}] is not an object")
    if expected_count is not None and len(data) != expected_count:
        raise ImagegenError(f"API returned {len(data)} image(s), requested {expected_count}")

    # Decode every item before writing so a later malformed item cannot leave a partial delivery.
    decoded = [decode_image_item(item, user_agent, direct_url_download) for item in data]
    for raw in decoded:
        actual_format = detect_image_format(raw)
        if actual_format is None:
            raise ImagegenError("image response did not contain a complete PNG, JPEG, or WebP image")
        if actual_format != fmt:
            raise ImagegenError(f"image response actual format {actual_format} does not match requested {fmt}")

    out_file.parent.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    for index, raw in enumerate(decoded):
        target = numbered_path(out_file, index, len(data), fmt)
        target.write_bytes(raw)
        written.append(str(target))
    if not written:
        raise ImagegenError("API response did not include b64_json or url images")
    return written


def decode_image_item(
    item: dict[str, Any],
    user_agent: str = DEFAULT_USER_AGENT,
    direct_url_download: bool = False,
) -> bytes:
    b64_value = item.get("b64_json")
    if isinstance(b64_value, str) and b64_value.strip():
        try:
            return decode_base64_image(strip_data_url_prefix(b64_value), MAX_IMAGE_RESPONSE_BYTES)
        except ValueError as exc:
            raise ImagegenError(str(exc)) from exc
    url = item.get("url")
    if isinstance(url, str) and url.strip():
        return download_image_url(url, user_agent, direct_url_download)
    raise ImagegenError("image item has neither b64_json nor url")


def download_image_url(
    url: str,
    user_agent: str = DEFAULT_USER_AGENT,
    direct_url_download: bool = False,
) -> bytes:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ImagegenError("image URL must use http or https")

    request = urllib.request.Request(
        url,
        headers={"Accept": "image/*", "User-Agent": user_agent},
    )
    direct_opener = None
    if direct_url_download:
        direct_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for attempt in range(2):
        try:
            if direct_opener is not None:
                response = direct_opener.open(request, timeout=DEFAULT_TIMEOUT_SECONDS)
            else:
                response = urllib.request.urlopen(request, timeout=DEFAULT_TIMEOUT_SECONDS)
            with response:
                return read_downloaded_image(response)
        except urllib.error.HTTPError as exc:
            raise ImagegenError(f"image URL download failed: HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            if attempt == 0 and is_tls_eof_error(exc.reason):
                continue
            reason = url_download_error_reason(exc.reason, direct_url_download)
            raise ImagegenError(f"image URL download failed: {reason}") from exc
        except ssl.SSLError as exc:
            if attempt == 0 and is_tls_eof_error(exc):
                continue
            reason = url_download_error_reason(exc, direct_url_download)
            raise ImagegenError(f"image URL download failed: {reason}") from exc

    raise ImagegenError("image URL download failed")


def is_tls_eof_error(error: Any) -> bool:
    return isinstance(error, ssl.SSLEOFError) or (
        isinstance(error, ssl.SSLError) and "UNEXPECTED_EOF_WHILE_READING" in str(error)
    )


def url_download_error_reason(error: Any, direct_url_download: bool) -> str:
    if not is_tls_eof_error(error):
        return "TLS error" if isinstance(error, ssl.SSLError) else "network error"
    if direct_url_download:
        return "TLS connection closed unexpectedly"
    return (
        "TLS connection closed unexpectedly; direct fallback is disabled. "
        "Ask the user before retrying with --allow-direct-url-download or enabling "
        "auth.json url_download.proxy_mode=direct"
    )


def read_downloaded_image(response: Any) -> bytes:
    try:
        data = read_limited_bytes(response, MAX_IMAGE_RESPONSE_BYTES, "image response")
    except http.client.IncompleteRead as exc:
        raise ImagegenError("image URL download was incomplete") from exc
    except ValueError as exc:
        if "incomplete" in str(exc):
            raise ImagegenError("image URL download was incomplete") from exc
        raise ImagegenError(str(exc)) from exc
    actual_format = detect_image_format(data)
    if actual_format is None:
        raise ImagegenError("image URL download did not contain a complete PNG, JPEG, or WebP image")
    return data


def is_complete_image_data(data: bytes) -> bool:
    return detect_image_format(data) is not None


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


def apply_postprocess(
    record: dict[str, Any],
    args: argparse.Namespace,
    cfg: Config,
    task: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not record.get("ok"):
        return record
    task = task or {}
    qa_requested = bool(get_value("qa", args, task, False))
    explicit = any(
        [
            bool(getattr(args, "postprocess", False)),
            bool(get_value("delivery_size", args, task, None)),
            bool(get_value("grid", args, task, None)),
            qa_requested,
        ]
    )
    if not explicit and not cfg.postprocess.get("enabled"):
        return record

    delivery_value = get_value("delivery_size", args, task, None)
    grid_value = get_value("grid", args, task, None)
    expected_count = get_value("expected_count", args, task, None)
    out_dir_value = get_value("postprocess_out_dir", args, task, None)
    resample = str(get_value("resample", args, task, "bilinear") or "bilinear")
    fit_mode = str(get_value("fit", args, task, "stretch") or "stretch")
    safe_margin = float(get_value("safe_margin", args, task, 0.0) or 0.0)
    components = bool(get_value("components", args, task, False))
    transparent = transparent_intent(args, task)
    original_files = list(record.get("files", []))
    if grid_value and not delivery_value:
        raise ImagegenError("grid requires delivery_size")
    if not delivery_value:
        if not qa_requested:
            return record
        updated = dict(record)
        updated["qa"] = evaluate_delivery(
            [Path(file_text) for file_text in original_files],
            expectations={"expected_count": expected_count, "components": components}
            if expected_count is not None or components
            else None,
            conditions=[{"kind": "transparent", "requested": True}] if transparent else None,
        )
        return updated

    delivery_size = parse_size(str(delivery_value))

    output_files: list[str] = []
    postprocess_results: list[dict[str, Any]] = []
    with OutputTransaction() as transaction:
        for file_text in original_files:
            source = Path(file_text).expanduser().resolve()
            if out_dir_value:
                out_dir = Path(out_dir_value).expanduser().resolve()
            else:
                out_dir = source.parent / f"{source.stem}-postprocess"
            if grid_value:
                rows, cols = parse_grid(str(grid_value))
                stage_dir = transaction.directory(out_dir)
                result = split_grid_image(
                    source,
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
            else:
                final = out_dir / f"{source.stem}-{delivery_size[0]}x{delivery_size[1]}.png"
                staged = transaction.stage_path(final)
                result = normalize_image_file(
                    source,
                    staged,
                    delivery_size,
                    resample=resample,
                    fit_mode=fit_mode,
                    safe_margin=safe_margin,
                )
                output_files.append(display_path(final))
                postprocess_results.append(result)
        path_mapping = transaction.commit()

    postprocess_results = remap_transaction_paths(postprocess_results, path_mapping)

    updated = dict(record)
    updated["original_files"] = original_files
    updated["files"] = output_files
    updated["postprocess"] = postprocess_results
    if qa_requested:
        qa_expected_count = len(output_files) if grid_value else expected_count
        updated["qa"] = evaluate_delivery(
            [Path(file_text) for file_text in output_files],
            expectations={
                "expected_size": list(delivery_size),
                "expected_count": qa_expected_count if qa_expected_count is not None else len(output_files),
                "components": components,
            },
            conditions=[{"kind": "transparent", "requested": True}] if transparent else None,
            source_paths=[Path(file_text) for file_text in original_files] if transparent else None,
        )
    return updated


def run_one_task(cfg: Config, base_args: argparse.Namespace, task: dict[str, Any]) -> dict[str, Any]:
    mode = str(task.get("mode") or "").strip().lower()
    if not mode:
        mode = "edit" if task.get("images") else "generate"
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
    tasks = read_jsonl(input_path)
    out_dir = Path(args.out).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        plan_batch_targets(
            tasks,
            {
                name: getattr(args, name, None)
                for name in ("file", "format", "n", "delivery_size", "grid", "postprocess_out_dir")
            },
            out_dir,
            now_stamp(),
            slugify,
            lambda task: str(resolve_common_params(args, cfg, task)["output_format"]),
        )
    except (TypeError, ValueError) as exc:
        raise ImagegenError(str(exc)) from exc

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
