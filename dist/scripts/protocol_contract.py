"""Request shape shared by independently registered image protocols."""

from dataclasses import dataclass
from typing import Any, Callable


class ProtocolError(ValueError):
    def __init__(self, message: str, code: str = "image_protocol_error"):
        super().__init__(message)
        self.code = code
        self.error_kind = code


def final_inline_image(data: Any, mime: Any) -> dict[str, Any]:
    if mime is not None and mime not in {"image/png", "image/jpeg", "image/webp"}:
        raise ProtocolError("provider returned an unsupported image MIME type", "image_response_invalid_mime")
    return {"b64_json": data}


@dataclass(frozen=True)
class ImageRequest:
    path: str
    payload: dict[str, Any]
    auth_header: str = "Authorization"
    transport: str = "json"


@dataclass(frozen=True)
class ImageProtocol:
    build: Callable
    normalize: Callable
    option_fields: frozenset[str]
    single_image: bool = False
    edit: bool = True
    mask: bool = False


def image_response(response: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(response.get("data"), list) or not response["data"]:
        raise ProtocolError("provider response contains no images", "image_response_empty")
    return response
