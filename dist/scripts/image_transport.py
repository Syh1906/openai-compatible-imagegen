"""Shared OpenAI-compatible image request transport."""

from __future__ import annotations

import json
import mimetypes
from pathlib import Path
import socket
import ssl
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
ATLAS_SUBMIT_PATH = "api/v1/model/generateImage"
ATLAS_RESULT_PATH = "api/v1/model/result/{request_id}"
ATLAS_PENDING_STATUSES = {"created", "processing"}
ATLAS_INPUT_KEYS = {"model", "prompt", "size", "quality", "output_format", "moderation"}


class TransportError(Exception):
    """A provider request failed before an image response was available."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        operation: str | None = None,
        transient: bool = False,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.operation = operation
        self.transient = transient


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


def request_atlas_image(
    *,
    base_url: str,
    api_key: str,
    user_agent: str,
    payload: dict[str, Any],
    timeout: int,
    poll_interval: float = 2.0,
    max_poll_attempts: int = 300,
    max_poll_seconds: float = 600.0,
    response_limit: int | None = MAX_JSON_RESPONSE_BYTES,
    proxy_url: str | None = None,
) -> dict[str, Any]:
    if max_poll_attempts < 1:
        raise ValueError("max_poll_attempts must be at least 1")
    if max_poll_seconds <= 0:
        raise ValueError("max_poll_seconds must be positive")
    _validate_atlas_payload(payload)
    submit_request = urllib.request.Request(
        api_url(base_url, ATLAS_SUBMIT_PATH),
        data=json.dumps(drop_none(payload)).encode("utf-8"),
        method="POST",
        headers=request_headers(api_key, user_agent, "application/json"),
    )
    submitted = _send_request(
        submit_request,
        timeout,
        "atlas generation submit",
        response_limit,
        proxy_url,
    )
    request_id = str(submitted.get("id") or submitted.get("request_id") or "").strip()
    if not request_id:
        raise TransportError(
            "Atlas generation response missing id",
            operation="atlas generation submit",
        )

    result_path = ATLAS_RESULT_PATH.format(request_id=urllib.parse.quote(request_id, safe=""))
    # Bound polling by wall clock as well as attempt count: a slow provider can
    # otherwise keep the caller waiting max_poll_attempts * poll_interval.
    deadline = time.monotonic() + max_poll_seconds
    for attempt in range(max_poll_attempts):
        if time.monotonic() >= deadline:
            raise TransportError(
                f"Atlas generation exceeded the {max_poll_seconds:.0f}s polling deadline",
                operation="atlas generation result",
            )
        result_request = urllib.request.Request(
            api_url(base_url, result_path),
            method="GET",
            headers=request_headers(api_key, user_agent, "application/json"),
        )
        try:
            result = _send_request(
                result_request,
                timeout,
                "atlas generation result",
                response_limit,
                proxy_url,
            )
        except TransportError as exc:
            if not _is_retryable_atlas_result_error(exc) or attempt + 1 >= max_poll_attempts:
                raise
            time.sleep(poll_interval)
            continue
        status = str(result.get("status") or "").strip().lower()
        if status == "completed":
            outputs = result.get("outputs")
            if not isinstance(outputs, list) or not outputs:
                raise TransportError(
                    "Atlas generation completed without outputs",
                    operation="atlas generation result",
                )
            urls = [value for value in outputs if isinstance(value, str) and value.strip()]
            if len(urls) != len(outputs):
                raise TransportError(
                    "Atlas generation returned an invalid output URL",
                    operation="atlas generation result",
                )
            return {"data": [{"url": value} for value in urls]}
        if status not in ATLAS_PENDING_STATUSES:
            detail = str(result.get("error") or result.get("message") or status or "unknown status")
            raise TransportError(
                f"Atlas generation failed: {detail}",
                operation="atlas generation result",
            )
        if attempt + 1 < max_poll_attempts:
            time.sleep(poll_interval)

    raise TransportError(
        "Atlas generation timed out while polling the result",
        operation="atlas generation result",
    )


def _is_transient_url_error(exc: urllib.error.URLError) -> bool:
    """Whether a URLError is worth retrying.

    urlopen reports certificate, DNS, proxy and connection-refused failures as
    URLError as well, and those will not fix themselves: retrying them burns the
    whole polling budget before surfacing the real cause.
    """
    reason = getattr(exc, "reason", None)
    if isinstance(reason, ssl.SSLError):
        return False
    if isinstance(reason, socket.gaierror):
        return False
    if isinstance(reason, (ConnectionRefusedError, PermissionError)):
        return False
    return isinstance(reason, (TimeoutError, ConnectionResetError, ConnectionAbortedError))


def _is_retryable_atlas_result_error(exc: TransportError) -> bool:
    """Retry only failures that are explicitly transient.

    A missing status code used to stand in for "retryable", but every transport
    failure arrives without one, so permanent errors were retried for the full
    polling budget.
    """
    if exc.status_code is None:
        return exc.transient
    return exc.status_code in {408, 425, 429} or exc.status_code >= 500


def _validate_atlas_payload(payload: dict[str, Any]) -> None:
    unknown = sorted(set(payload) - ATLAS_INPUT_KEYS)
    if unknown:
        raise ValueError(f"Atlas generation does not support input: {unknown[0]}")
    for key in ("model", "prompt"):
        if not isinstance(payload.get(key), str) or not payload[key].strip():
            raise ValueError(f"Atlas generation requires {key}")
    quality = payload.get("quality")
    if quality is not None and quality not in {"low", "medium", "high"}:
        raise ValueError("Atlas generation quality must be low, medium, or high")
    output_format = payload.get("output_format")
    if output_format is not None and output_format not in {"jpeg", "png"}:
        raise ValueError("Atlas generation output_format must be jpeg or png")


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
            transient=_is_transient_url_error(exc),
        ) from exc
    except TimeoutError as exc:
        raise TransportError(
            f"API request timed out after {timeout}s",
            operation=operation,
            transient=True,
        ) from exc
