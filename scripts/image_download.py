from __future__ import annotations

import http.client
import ssl
from typing import Any
import urllib.error
import urllib.parse
import urllib.request


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class ImageDownloadError(ValueError):
    pass


def download_image_url(
    url: str,
    user_agent: str,
    timeout: int,
    direct_url_download: bool = False,
) -> bytes:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ImageDownloadError("image URL must use http or https")

    request = urllib.request.Request(
        url,
        headers={"Accept": "image/*", "User-Agent": user_agent},
    )
    opener = None
    if direct_url_download:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for attempt in range(2):
        try:
            response = (
                opener.open(request, timeout=timeout)
                if opener is not None
                else urllib.request.urlopen(request, timeout=timeout)
            )
            with response:
                return read_downloaded_image(response)
        except urllib.error.HTTPError as exc:
            raise ImageDownloadError(f"image URL download failed: HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            if attempt == 0 and is_tls_eof_error(exc.reason):
                continue
            raise ImageDownloadError(f"image URL download failed: {network_error_reason(exc.reason)}") from exc
        except ssl.SSLError as exc:
            if attempt == 0 and is_tls_eof_error(exc):
                continue
            raise ImageDownloadError(f"image URL download failed: {network_error_reason(exc)}") from exc

    raise ImageDownloadError("image URL download failed")


def is_tls_eof_error(error: Any) -> bool:
    return isinstance(error, ssl.SSLEOFError) or (
        isinstance(error, ssl.SSLError) and "UNEXPECTED_EOF_WHILE_READING" in str(error)
    )


def network_error_reason(error: Any) -> str:
    if is_tls_eof_error(error):
        return "TLS connection closed unexpectedly"
    return "TLS error" if isinstance(error, ssl.SSLError) else "network error"


def read_downloaded_image(response: Any) -> bytes:
    try:
        data = response.read()
    except http.client.IncompleteRead as exc:
        raise ImageDownloadError("image URL download was incomplete") from exc

    headers = getattr(response, "headers", None)
    content_length = headers.get("Content-Length") if headers is not None else None
    if isinstance(content_length, str) and content_length.isdigit() and len(data) != int(content_length):
        raise ImageDownloadError("image URL download was incomplete")
    if not is_complete_image_data(data):
        raise ImageDownloadError("image URL download did not contain a complete PNG, JPEG, or WebP image")
    return data


def is_complete_image_data(data: bytes) -> bool:
    if data.startswith(PNG_SIGNATURE):
        return data.endswith(b"IEND\xaeB`\x82")
    if data.startswith(b"\xff\xd8"):
        return data.endswith(b"\xff\xd9")
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return int.from_bytes(data[4:8], "little") + 8 == len(data)
    return False
