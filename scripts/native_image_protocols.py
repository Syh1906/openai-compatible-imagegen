"""Registry for native API Key image protocols shared by both distributions."""

from __future__ import annotations

import base64
from dataclasses import replace
from typing import Any

from image_parameters import extend_payload
from image_response import inspect_response_image
from protocol_contract import ImageRequest as NativeRequest
from protocol_contract import ProtocolError
from protocol_xai_images import ADAPTER as XAI_IMAGES
from protocol_gemini_interactions import ADAPTER as GEMINI_INTERACTIONS
from protocol_gemini_content import ADAPTER as GEMINI_CONTENT
from protocol_openai_images import ADAPTER as OPENAI_IMAGES
from protocol_atlas_images import ADAPTER as ATLAS_IMAGES


ADAPTERS = {
    "openai-compatible": OPENAI_IMAGES,
    "atlas": ATLAS_IMAGES,
    "xai-images": XAI_IMAGES,
    "gemini-interactions": GEMINI_INTERACTIONS,
    "gemini-generate-content": GEMINI_CONTENT,
}
NATIVE_PROTOCOLS = frozenset({"xai-images", "gemini-interactions", "gemini-generate-content"})


def validate_options(protocol: str, model: str, options: dict[str, Any]) -> None:
    adapter = ADAPTERS[protocol]
    for key, value in options.items():
        if value is None:
            continue
        if key not in adapter.option_fields:
            raise ProtocolError(f"{protocol} has no documented {key} field; use an explicit protocol parameter or local delivery")
        if not isinstance(value, str) or not value.strip():
            raise ProtocolError(f"{key} must be a non-empty string")


def build_request(protocol: str, model: str, prompt: str, options: dict[str, Any], *, images=(), count: int = 1, parameters=None) -> NativeRequest:
    validate_options(protocol, model, options)
    if type(count) is not int or count < 1:
        raise ProtocolError("candidate count must be a positive integer")
    inputs = [("image/" + inspect_response_image(blob).image_format, base64.b64encode(blob).decode("ascii")) for blob in images]
    request = ADAPTERS[protocol].build(model, prompt, options, inputs, count)
    return replace(request, payload=extend_payload(request.payload, parameters))


def normalize_response(protocol: str, response: dict[str, Any]) -> dict[str, Any]:
    return ADAPTERS[protocol].normalize(response)
