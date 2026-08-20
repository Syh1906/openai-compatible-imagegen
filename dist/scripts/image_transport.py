"""Shared OpenAI-compatible image request transport."""

from __future__ import annotations

import json
import mimetypes
from pathlib import Path
import sys
import time
from typing import Any
import urllib.error
import urllib.parse
import urllib.request


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from image_response import MAX_JSON_RESPONSE_BYTES, read_json_response, safe_error_body
from network_proxy import proxy_mapping


MultipartUpload = tuple[str, Path] | tuple[str, Path, bytes]


class TransportError(Exception):
    """A provider request failed before an image response was available."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        operation: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.operation = operation


def request_json(
    *,
    base_url: str,
    api_key: str,
    user_agent: str,
    path: str,
    payload: dict[str, Any],
    timeout: int,
    response_limit: int | None = MAX_JSON_RESPONSE_BYTES,
    proxy_url: str | None = None,
) -> dict[str, Any]:
    body = json.dumps(drop_none(payload)).encode("utf-8")
    request = urllib.request.Request(
        api_url(base_url, path),
        data=body,
        method="POST",
        headers=request_headers(api_key, user_agent, "application/json"),
    )
    return _send_request(request, timeout, path, response_limit, proxy_url)


def request_multipart(
    *,
    base_url: str,
    api_key: str,
    user_agent: str,
    path: str,
    fields: dict[str, Any],
    files: list[MultipartUpload],
    timeout: int,
    response_limit: int | None = MAX_JSON_RESPONSE_BYTES,
    proxy_url: str | None = None,
) -> dict[str, Any]:
    boundary = f"----codex-imagegen-{int(time.time() * 1000)}"
    body = build_multipart_body(boundary, fields, files)
    request = urllib.request.Request(
        api_url(base_url, path),
        data=body,
        method="POST",
        headers=request_headers(
            api_key,
            user_agent,
            f"multipart/form-data; boundary={boundary}",
        ),
    )
    return _send_request(request, timeout, path, response_limit, proxy_url)


def api_url(base_url: str, path: str) -> str:
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("base_url must be an http(s) URL ending in /v1")
    return f"{base_url.rstrip('/')}/{path.lstrip('/')}"


def request_headers(api_key: str, user_agent: str, content_type: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": content_type,
        "Accept": "application/json",
        "User-Agent": user_agent,
    }


def build_multipart_body(
    boundary: str,
    fields: dict[str, Any],
    files: list[MultipartUpload],
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
        has_snapshot = len(upload) == 3
        if not has_snapshot and not path.is_file():
            raise ValueError(f"input file not found: {path}")
        snapshot = upload[2] if has_snapshot else path.read_bytes()
        if not isinstance(snapshot, bytes):
            raise ValueError("multipart file snapshot must be bytes")
        mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                (
                    f'Content-Disposition: form-data; name="{field_name}"; '
                    f'filename="{path.name}"\r\n'
                ).encode(),
                f"Content-Type: {mime_type}\r\n\r\n".encode(),
                snapshot,
                b"\r\n",
            ]
        )
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks)


def drop_none(values: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None}


def _send_request(
    request: urllib.request.Request,
    timeout: int,
    operation: str,
    response_limit: int | None,
    proxy_url: str | None,
) -> dict[str, Any]:
    mapping = proxy_mapping(proxy_url)
    opener = (
        urllib.request.build_opener(urllib.request.ProxyHandler(mapping))
        if mapping is not None
        else None
    )
    try:
        response_context = (
            opener.open(request, timeout=timeout)
            if opener is not None
            else urllib.request.urlopen(request, timeout=timeout)
        )
        with response_context as response:
            if response_limit is None:
                value = json.loads(response.read().decode("utf-8"))
                if not isinstance(value, dict):
                    raise ValueError("API JSON response must be an object")
                return value
            return read_json_response(response, response_limit)
    except urllib.error.HTTPError as exc:
        detail = safe_error_body(exc)
        raise TransportError(
            f"API HTTP {exc.code}: {detail}",
            status_code=exc.code,
            operation=operation,
        ) from exc
    except urllib.error.URLError as exc:
        reason = str(exc.reason)
        if proxy_url:
            reason = reason.replace(proxy_url, "[configured proxy]")
        raise TransportError(
            f"API request failed: {reason}",
            operation=operation,
        ) from exc
