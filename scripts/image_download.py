from __future__ import annotations

import http.client
import ssl
from typing import Any
import urllib.error
import urllib.parse
import urllib.request

from scripts.image_response import MAX_IMAGE_RESPONSE_BYTES, detect_image_format, read_limited_bytes
from scripts.network_proxy import proxy_mapping


DEFAULT_DIRECT_DOWNLOAD_GUIDANCE = (
    "ask the user to approve setting the provider's url_download.proxy_mode=direct"
)


class ImageDownloadError(ValueError):
    pass


def download_image_url(
    url: str,
    user_agent: str,
    timeout: int,
    direct_url_download: bool = False,
    direct_download_guidance: str = DEFAULT_DIRECT_DOWNLOAD_GUIDANCE,
    response_limit: int | None = None,
    proxy_url: str | None = None,
) -> bytes:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ImageDownloadError("image URL must use http or https")

    request = urllib.request.Request(
        url,
        headers={"Accept": "image/*", "User-Agent": user_agent},
    )
    mapping = proxy_mapping(proxy_url, direct=direct_url_download)
    opener = (
        urllib.request.build_opener(urllib.request.ProxyHandler(mapping))
        if mapping is not None
        else None
    )
    for attempt in range(2):
        try:
            response = (
                opener.open(request, timeout=timeout)
                if opener is not None
                else urllib.request.urlopen(request, timeout=timeout)
            )
            with response:
                return read_downloaded_image(response, response_limit)
        except urllib.error.HTTPError as exc:
            exc.close()
            raise ImageDownloadError(f"image URL download failed: HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            if attempt == 0 and is_tls_eof_error(exc.reason):
                continue
            reason = network_error_reason(
                exc.reason,
                direct_url_download,
                direct_download_guidance,
            )
            raise ImageDownloadError(f"image URL download failed: {reason}") from exc
        except ssl.SSLError as exc:
            if attempt == 0 and is_tls_eof_error(exc):
                continue
            reason = network_error_reason(
                exc,
                direct_url_download,
                direct_download_guidance,
            )
            raise ImageDownloadError(f"image URL download failed: {reason}") from exc

    raise ImageDownloadError("image URL download failed")


def is_tls_eof_error(error: Any) -> bool:
    return isinstance(error, ssl.SSLEOFError) or (
        isinstance(error, ssl.SSLError) and "UNEXPECTED_EOF_WHILE_READING" in str(error)
    )


def network_error_reason(
    error: Any,
    direct_url_download: bool,
    direct_download_guidance: str = DEFAULT_DIRECT_DOWNLOAD_GUIDANCE,
) -> str:
    if is_tls_eof_error(error):
        if direct_url_download:
            return "TLS connection closed unexpectedly"
        return f"TLS connection closed unexpectedly; {direct_download_guidance}"
    return "TLS error" if isinstance(error, ssl.SSLError) else "network error"


def read_downloaded_image(response: Any, response_limit: int | None = None) -> bytes:
    limit = MAX_IMAGE_RESPONSE_BYTES if response_limit is None else response_limit
    try:
        data = read_limited_bytes(response, limit, "image response")
    except http.client.IncompleteRead as exc:
        raise ImageDownloadError("image URL download was incomplete") from exc
    except ValueError as exc:
        if "incomplete" in str(exc):
            raise ImageDownloadError("image URL download was incomplete") from exc
        raise ImageDownloadError(str(exc)) from exc

    headers = getattr(response, "headers", None)
    content_length = headers.get("Content-Length") if headers is not None else None
    if isinstance(content_length, str) and content_length.isdigit() and len(data) != int(content_length):
        raise ImageDownloadError("image URL download was incomplete")
    if not is_complete_image_data(data):
        raise ImageDownloadError("image URL download did not contain a complete PNG, JPEG, or WebP image")
    return data


def is_complete_image_data(data: bytes) -> bool:
    return detect_image_format(data) is not None
