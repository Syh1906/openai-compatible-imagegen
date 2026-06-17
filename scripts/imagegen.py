#!/usr/bin/env python3
"""OpenAI-compatible image generation helper for Codex skills."""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


SKILL_DIR = Path(__file__).resolve().parents[1]
AUTH_PATH = SKILL_DIR / "auth.json"
EXAMPLE_AUTH_PATH = SKILL_DIR / "examples" / "auth.example.json"
DEFAULT_CONCURRENCY = 3
DEFAULT_TIMEOUT_SECONDS = 600
DEFAULT_MODEL = "gpt-image-2"
DEFAULT_SIZE = "1024x1024"
DEFAULT_QUALITY = "medium"
DEFAULT_FORMAT = "png"
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


def load_config(require_api_key: bool = True) -> Config:
    if not AUTH_PATH.is_file():
        raise ImagegenError(
            f"missing auth.json: {display_path(AUTH_PATH)}\n"
            f"Run: python {display_path(Path(__file__).resolve())} init\n"
            "Then edit auth.json or set the configured api_key_env environment variable."
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
    defaults = raw.get("defaults") if isinstance(raw.get("defaults"), dict) else {}
    capabilities = raw.get("capabilities") if isinstance(raw.get("capabilities"), dict) else {}

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
    )


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

    size = get_value("size", args, task, None) or cfg.defaults.get("size") or DEFAULT_SIZE
    quality = get_value("quality", args, task, None) or cfg.defaults.get("quality") or DEFAULT_QUALITY
    model = get_value("model", args, task, None) or cfg.model
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
        "quality": str(quality),
        "n": n,
        "output_format": fmt,
        "background": background,
        "moderation": get_value("moderation", args, task, None),
        "output_compression": output_compression,
        "timeout": timeout,
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
        headers={
            "Authorization": f"Bearer {cfg.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
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
    files: list[tuple[str, Path]],
    timeout: int,
) -> dict[str, Any]:
    boundary = f"----codex-imagegen-{int(time.time() * 1000)}"
    body = build_multipart_body(boundary, fields, files)
    req = urllib.request.Request(
        api_url(cfg, path),
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {cfg.api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = safe_error_body(exc)
        raise ImagegenError(f"API HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ImagegenError(f"API request failed: {exc.reason}") from exc


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
    written = write_response_images(response, out_file, params["output_format"])
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
    written = write_response_images(response, out_file, params["output_format"])
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


def write_response_images(response: dict[str, Any], out_file: Path, fmt: str) -> list[str]:
    data = response.get("data")
    if not isinstance(data, list) or not data:
        raise ImagegenError("API response did not include data images")
    out_file.parent.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    for index, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        raw = decode_image_item(item)
        target = numbered_path(out_file, index, len(data), fmt)
        target.write_bytes(raw)
        written.append(str(target))
    if not written:
        raise ImagegenError("API response did not include b64_json or url images")
    return written


def decode_image_item(item: dict[str, Any]) -> bytes:
    b64_value = item.get("b64_json")
    if isinstance(b64_value, str) and b64_value.strip():
        return base64.b64decode(strip_data_url_prefix(b64_value))
    url = item.get("url")
    if isinstance(url, str) and url.strip():
        with urllib.request.urlopen(url, timeout=DEFAULT_TIMEOUT_SECONDS) as resp:
            return resp.read()
    raise ImagegenError("image item has neither b64_json nor url")


def strip_data_url_prefix(value: str) -> str:
    if value.startswith("data:") and "," in value:
        return value.split(",", 1)[1]
    return value


def numbered_path(out_file: Path, index: int, count: int, fmt: str) -> Path:
    suffix = out_file.suffix or f".{fmt}"
    if count == 1:
        return out_file.with_suffix(suffix)
    return out_file.with_name(f"{out_file.stem}_{index + 1}{suffix}")


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
            return generate(cfg, base_args, task)
        if mode in {"edit", "multi-reference", "multi_reference"}:
            return edit(cfg, base_args, task)
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
        "capabilities": cfg.capabilities,
        "defaults": cfg.defaults,
        "auth_json": display_path(AUTH_PATH),
        "api_key_source": cfg.api_key_source,
        "api_key": "***REDACTED***",
    }
    print(json.dumps(defaults, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="imagegen")
    sub = parser.add_subparsers(dest="command", required=True)

    init_parser = sub.add_parser("init")
    init_parser.add_argument("--force", action="store_true", help="Recreate auth.json from the example template")
    init_parser.add_argument("--base-url", default=None, help="OpenAI-compatible API base URL, usually ending in /v1")
    init_parser.add_argument("--model", default=None, help="Default image model")
    init_parser.add_argument("--api-key-env", default=None, help="Environment variable name to read the API key from")
    init_parser.add_argument(
        "--transparent-background",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Whether the API supports background=transparent",
    )

    add_generate_args(sub.add_parser("generate"))
    add_generate_args(sub.add_parser("edit"), edit=True)

    batch_parser = sub.add_parser("batch")
    add_common_args(batch_parser)
    batch_parser.add_argument("--input", required=True, help="JSONL task file")
    batch_parser.add_argument("--out", required=True, help="Output directory")
    batch_parser.add_argument("--concurrency", type=int, default=None, help="Limited batch concurrency")

    sub.add_parser("info")
    return parser


def add_generate_args(parser: argparse.ArgumentParser, edit: bool = False) -> None:
    add_common_args(parser)
    parser.add_argument("-p", "--prompt", required=True)
    parser.add_argument("-f", "--file", default=None)
    parser.add_argument("--out", default=None)
    if edit:
        parser.add_argument("-i", "--image", action="append", default=None)
        parser.add_argument("-m", "--mask", default=None)


def add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--model", default=None)
    parser.add_argument("--size", default=None)
    parser.add_argument("--quality", default=None, choices=["auto", "low", "medium", "high"])
    parser.add_argument("--n", type=int, default=None)
    parser.add_argument("--format", default=None, choices=["png", "jpeg", "jpg", "webp"])
    parser.add_argument("--background", default=None, choices=["auto", "opaque", "transparent"])
    parser.add_argument("--transparent", action="store_true")
    parser.add_argument("--asset", action="store_true")
    parser.add_argument("--moderation", default=None, choices=["auto", "low"])
    parser.add_argument("--compression", type=int, default=None)
    parser.add_argument("--timeout", type=int, default=None)


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "init":
            return init_auth(args)
        cfg = load_config(require_api_key=args.command != "info")
        if args.command == "info":
            return info(cfg)
        if args.command == "generate":
            result = generate(cfg, args)
            print_summary([result])
            return 0
        if args.command == "edit":
            result = edit(cfg, args)
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
