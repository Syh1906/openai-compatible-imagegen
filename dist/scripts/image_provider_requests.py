"""Dispatch image requests by configured protocol, never by model identity."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import image_transport
from image_parameters import extend_payload
from native_image_protocols import ADAPTERS, NATIVE_PROTOCOLS, build_request, normalize_response
from protocol_contract import ProtocolError


def request_image(cfg: Any, operation: str, payload: dict[str, Any], timeout: int, *, files: list | None = None) -> dict[str, Any]:
    endpoint = cfg.endpoints.get(operation)
    if endpoint:
        endpoint = endpoint.replace("{model}", quote(cfg.model, safe=""))
    common = dict(base_url=cfg.base_url, api_key=cfg.api_key, user_agent=cfg.user_agent, timeout=timeout, proxy_url=cfg.proxy.get("url"))
    if endpoint:
        common["endpoint"] = endpoint
    if cfg.protocol in NATIVE_PROTOCOLS:
        images = []
        for upload in files or []:
            if upload[0] == "mask":
                raise ValueError("selected protocol has no mask field")
            images.append(upload[2] if len(upload) == 3 else upload[1].read_bytes())
        options = {target: payload.get(source) for source, target in (("size", "size"), ("quality", "quality"), ("output_format", "format"), ("aspectRatio", "aspectRatio"), ("resolution", "resolution"), ("background", "background"), ("output_compression", "compression"), ("moderation", "moderation"))}
        # Gemini image protocols have no multi-image count field. Preserve count
        # intent as independent requests; never manufacture an undocumented field.
        count = payload.get("n", 1)
        repeats = count if ADAPTERS[cfg.protocol].single_image else 1
        data = []
        for _ in range(repeats):
            request = build_request(cfg.protocol, cfg.model, payload["prompt"], options, images=images, count=1 if ADAPTERS[cfg.protocol].single_image else count, parameters=cfg.parameters)
            response = image_transport.request_json(**common, path=request.path, payload=request.payload, auth_header=request.auth_header)
            data.extend(normalize_response(cfg.protocol, response)["data"])
        return {"data": data}
    options = {target: payload.get(source) for source, target in (("size", "size"), ("quality", "quality"), ("output_format", "format"), ("background", "background"), ("output_compression", "compression"), ("moderation", "moderation"))}
    request = ADAPTERS[cfg.protocol].build(cfg.model, payload["prompt"], options, files or [], payload.get("n", 1))
    if request.transport == "atlas":
        return image_transport.request_atlas_image(**common, payload={**request.payload, **payload}, parameters=cfg.parameters)
    # Preserve adapter-specific fields already prepared by transparency/mask logic.
    payload = extend_payload({**request.payload, **payload}, cfg.parameters)
    if request.transport == "multipart":
        return image_transport.request_multipart(**common, path=request.path, fields=payload, files=files or [])
    return image_transport.request_json(**common, path=request.path, payload=payload)
