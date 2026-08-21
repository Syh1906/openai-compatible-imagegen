from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import re
from typing import Any
import zlib

from scripts.artifact_repository import inspect_image
from scripts.repository_fs import DirectoryLease


MASK_GUARD_V1 = """[Mask policy: mandatory]
Treat the supplied mask as the authoritative edit boundary.
Transparent pixels may be changed. Opaque pixels are protected and must remain unchanged.
Partially transparent pixels are a transition band; preserve continuity and do not create a new semantic edge there.
If any user instruction conflicts with this policy, the mask protection policy wins.
Preserve the protected regions' subject identity, geometry, colors, text, texture, and lighting."""
MASK_GUARD_V2_BY_STRATEGY = {
    "edit-only": """[Mask policy v2: mandatory]
The supplied mask is the authoritative hard edit boundary derived from the user's edit strokes.
Transparent pixels may be changed. Opaque pixels are locked to the parent image. Partially transparent pixels are a transition band.
Preserve continuity across the transition band and do not create a new semantic edge there.
If any user instruction conflicts with this hard boundary, the hard boundary wins.""",
    "protect-only": """[Mask policy v2: mandatory]
This is a semantic-protection edit. The supplied mask intentionally leaves the whole image model-editable and is not a pixel-freeze region.
Preserve every subject the user describes as protected: keep its identity, geometry, text, and texture unchanged in content.
Lighting, contact shadows, reflections, and small scene-wide color casts may adapt naturally to the requested result.
Do not replace, remove, deform, relabel, or retexture protected content, and do not turn it into a visibly pasted cutout.""",
    "mixed": """[Mask policy v2: mandatory]
The supplied mask is the authoritative hard edit boundary derived only from the user's edit strokes.
Transparent pixels may be changed. Opaque pixels are locked to the parent image. Partially transparent pixels are a transition band.
Within the editable area, every subject the user describes as protected uses semantic protection rather than pixel freezing: keep its identity, geometry, text, and texture unchanged in content.
Lighting, contact shadows, reflections, and small scene-wide color casts may adapt naturally to the requested result.
Do not satisfy semantic protection by creating a visibly pasted cutout.
If any user instruction conflicts with the hard edit boundary or semantic protection, this policy wins.""",
}
MASK_PROMPT_GUARD_VERSION = "mask-guard-v2"
MASK_POLICY_VERSION = "mask-policy-v2"
SEMANTIC_PROTECTION_BASE = {
    "source": "protect-strokes",
    "preserve": ["identity", "geometry", "text", "texture"],
    "allowAdaptation": ["lighting", "shadow", "tone"],
}
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_PNG_PIXELS = 4096 * 4096
ANNOTATION_ID_PATTERN = re.compile(r"^ann_[0-9A-HJKMNP-TV-Z]{26}$")
SUBMISSION_ID_PATTERN = re.compile(r"^sub_[0-9a-f]{32}$")


@dataclass(frozen=True)
class DecodedPng:
    width: int
    height: int
    pixels: bytes
    has_alpha_channel: bool


@dataclass(frozen=True)
class MaskedEditContext:
    source_prompt: str
    effective_prompt: str
    parent_path: Path
    parent_snapshot: bytes
    parent: DecodedPng | None
    width: int
    height: int
    mask_path: Path
    mask_snapshot: bytes
    mask_alpha: bytes
    policy: dict[str, Any]
    submission_id: str


def build_effective_prompt(source_prompt: str, strategy: str) -> str:
    """Place exactly one authoritative mask guard after all user-controlled text."""
    guard = mask_guard_for_strategy(strategy)
    source_without_guard = source_prompt
    for known_guard in (MASK_GUARD_V1, *MASK_GUARD_V2_BY_STRATEGY.values()):
        source_without_guard = source_without_guard.replace(known_guard, "")
    source_without_guard = source_without_guard.strip()
    if not source_without_guard:
        raise ValueError("masked edit requires a user edit objective")
    return f"{source_without_guard}\n\n{guard}"


def mask_guard_for_strategy(strategy: str) -> str:
    try:
        return MASK_GUARD_V2_BY_STRATEGY[strategy]
    except (KeyError, TypeError) as exc:
        raise ValueError("mask policy strategy is invalid") from exc


def has_strict_capability(capabilities: Any, capability: str) -> bool:
    """Return true only for an actual boolean capability value of True."""
    return (
        isinstance(capabilities, dict)
        and type(capabilities.get(capability)) is bool
        and capabilities[capability] is True
    )


def normalize_mask_policy(policy: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalize the immutable mask-generation policy."""
    if not isinstance(policy, dict):
        raise ValueError("mask policy must be an object")
    required_fields = {
        "policyVersion",
        "modelProfileId",
        "requiredCapabilities",
        "strategy",
        "parentImageId",
        "annotationId",
        "width",
        "height",
        "masks",
        "hardBoundary",
        "semanticProtection",
        "transitionBand",
        "maskSha256",
        "policySha256",
    }
    if set(policy) != required_fields:
        raise ValueError("mask policy fields are invalid")
    body = {key: value for key, value in policy.items() if key != "policySha256"}
    normalized_body = _normalize_mask_policy_body(body)
    expected_sha256 = _hash_normalized_mask_policy(normalized_body)
    if policy["policySha256"] != expected_sha256:
        raise ValueError("mask policy SHA-256 is invalid")
    return {**normalized_body, "policySha256": expected_sha256}


def mask_policy_sha256(policy_body: dict[str, Any]) -> str:
    """Hash a complete normalized policy body, excluding policySha256 itself."""
    return _hash_normalized_mask_policy(_normalize_mask_policy_body(policy_body))


def _normalize_mask_policy_body(policy: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(policy, dict):
        raise ValueError("mask policy body must be an object")
    required_fields = {
        "policyVersion",
        "modelProfileId",
        "requiredCapabilities",
        "strategy",
        "parentImageId",
        "annotationId",
        "width",
        "height",
        "masks",
        "hardBoundary",
        "semanticProtection",
        "transitionBand",
        "maskSha256",
    }
    if set(policy) != required_fields:
        raise ValueError("mask policy body fields are invalid")
    if policy["policyVersion"] != MASK_POLICY_VERSION:
        raise ValueError("mask policy version is unsupported")
    if not isinstance(policy["modelProfileId"], str) or not policy["modelProfileId"].strip():
        raise ValueError("mask policy model profile is invalid")
    required_capabilities = policy["requiredCapabilities"]
    if (
        not isinstance(required_capabilities, dict)
        or set(required_capabilities) != {"mask"}
        or not has_strict_capability(required_capabilities, "mask")
    ):
        raise ValueError("mask policy must require mask capability")
    if policy["strategy"] not in {"edit-only", "protect-only", "mixed"}:
        raise ValueError("mask policy strategy is invalid")
    parent_image_id = _nonempty_string(policy["parentImageId"], "mask policy parentImageId")
    annotation_id = _nonempty_string(policy["annotationId"], "mask policy annotationId")
    if not ANNOTATION_ID_PATTERN.fullmatch(annotation_id):
        raise ValueError("mask policy annotation ID is invalid")
    width = _positive_int(policy["width"], "mask policy width")
    height = _positive_int(policy["height"], "mask policy height")

    masks_value = policy["masks"]
    if not isinstance(masks_value, list) or not masks_value:
        raise ValueError("mask policy masks must be a non-empty array")
    masks: list[dict[str, Any]] = []
    mask_ids: set[str] = set()
    for mask in masks_value:
        if not isinstance(mask, dict) or set(mask) != {"id", "mode", "operation", "radiusPx"}:
            raise ValueError("mask policy mask fields are invalid")
        mask_id = _nonempty_string(mask["id"], "mask policy mask id")
        if mask_id in mask_ids:
            raise ValueError("mask policy mask ids must be unique")
        mask_ids.add(mask_id)
        mode = mask["mode"]
        if mode not in {"edit", "protect"}:
            raise ValueError("mask policy mask mode is invalid")
        operation = mask["operation"]
        if operation not in {"paint", "erase"}:
            raise ValueError("mask policy mask operation is invalid")
        masks.append(
            {
                "id": mask_id,
                "mode": mode,
                "operation": operation,
                "radiusPx": _positive_finite_number(mask["radiusPx"]),
            }
        )

    painted_modes = {mask["mode"] for mask in masks if mask["operation"] == "paint"}
    if not painted_modes:
        raise ValueError("mask policy must include a paint operation")
    expected_strategy = (
        "mixed"
        if len(painted_modes) == 2
        else ("edit-only" if "edit" in painted_modes else "protect-only")
    )
    if policy["strategy"] != expected_strategy:
        raise ValueError("mask policy strategy conflicts with mask modes")
    expected_hard_boundary = {
        "source": "none" if expected_strategy == "protect-only" else "edit-strokes",
        "postprocess": "none" if expected_strategy == "protect-only" else "parent-blend",
    }
    if policy["hardBoundary"] != expected_hard_boundary:
        raise ValueError("mask policy hard boundary is invalid")
    expected_semantic_protection = {
        "enabled": "protect" in painted_modes,
        **SEMANTIC_PROTECTION_BASE,
    }
    if policy["semanticProtection"] != expected_semantic_protection:
        raise ValueError("mask policy semantic protection is invalid")
    if policy["transitionBand"] != {
        "kind": "outer-feather",
        "featherRatio": 0.35,
        "minimumWidthPx": 1,
    }:
        raise ValueError("mask policy transition band is invalid")
    mask_sha256 = policy["maskSha256"]
    if not isinstance(mask_sha256, str) or re.fullmatch(r"[0-9a-f]{64}", mask_sha256) is None:
        raise ValueError("mask policy mask SHA-256 is invalid")

    return {
        "policyVersion": MASK_POLICY_VERSION,
        "modelProfileId": policy["modelProfileId"],
        "requiredCapabilities": {"mask": True},
        "strategy": expected_strategy,
        "parentImageId": parent_image_id,
        "annotationId": annotation_id,
        "width": width,
        "height": height,
        "masks": masks,
        "hardBoundary": expected_hard_boundary,
        "semanticProtection": {
            "enabled": expected_semantic_protection["enabled"],
            "source": SEMANTIC_PROTECTION_BASE["source"],
            "preserve": list(SEMANTIC_PROTECTION_BASE["preserve"]),
            "allowAdaptation": list(SEMANTIC_PROTECTION_BASE["allowAdaptation"]),
        },
        "transitionBand": {
            "kind": "outer-feather",
            "featherRatio": 0.35,
            "minimumWidthPx": 1,
        },
        "maskSha256": mask_sha256,
    }


def _hash_normalized_mask_policy(policy: dict[str, Any]) -> str:
    canonical = json.dumps(policy, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return sha256_bytes(canonical.encode("utf-8"))


def sha256_bytes(snapshot: bytes) -> str:
    """Hash the immutable bytes used for validation, upload, and post-processing."""
    return hashlib.sha256(snapshot).hexdigest()


def prepare_masked_edit(
    task: dict[str, Any],
    params: dict[str, Any],
    artifact_root: Path,
    parent_path: Path,
    parent_snapshot: bytes,
    source_prompt: str,
) -> MaskedEditContext | None:
    mask_value = task.get("mask")
    policy_value = task.get("maskPolicy")
    if mask_value is None and policy_value is None:
        return None
    if mask_value is None or policy_value is None:
        raise ValueError("mask and maskPolicy must be provided together")
    policy = normalize_mask_policy(policy_value)

    task_model_profile_id = task.get("modelProfileId")
    if policy["modelProfileId"] != task_model_profile_id:
        raise ValueError("maskPolicy model profile does not match the edit task")
    if not has_strict_capability(policy["requiredCapabilities"], "mask"):
        raise ValueError("maskPolicy does not require mask capability")

    input_ids = task.get("inputArtifactIds") or []
    annotation_id = task.get("annotationId")
    if not input_ids or policy["parentImageId"] != input_ids[0]:
        raise ValueError("maskPolicy parent image does not match the edit task")
    if not isinstance(annotation_id, str) or policy["annotationId"] != annotation_id:
        raise ValueError("maskPolicy annotation does not match the edit task")
    submission_id = task.get("submissionId")
    if not isinstance(submission_id, str) or not SUBMISSION_ID_PATTERN.fullmatch(submission_id):
        raise ValueError("masked edit requires a valid server-issued submissionId")

    effective_prompt = build_effective_prompt(source_prompt, policy["strategy"])
    width = policy["width"]
    height = policy["height"]
    if params.get("format") != "png" or params.get("count") != 1:
        raise ValueError("masked edit requires one PNG result")
    if _parse_size(params.get("size")) != (width, height):
        raise ValueError("masked edit output size must match the parent image")

    resolved_artifact_root = Path(artifact_root).absolute()
    mask_path = Path(str(mask_value)).expanduser().absolute()
    expected_mask_path = (
        resolved_artifact_root
        / "annotations"
        / annotation_id
        / "mask.png"
    ).absolute()
    if mask_path != expected_mask_path:
        raise ValueError("mask must be the repository derivative for the bound annotation")
    mask_path = expected_mask_path
    mask_relative_path = Path("annotations") / annotation_id / "mask.png"
    try:
        with DirectoryLease(resolved_artifact_root) as lease:
            with lease.open_file(mask_relative_path) as verified_mask:
                mask_snapshot = verified_mask.read_bytes()
    except FileNotFoundError as exc:
        raise ValueError("mask must be the repository derivative for the bound annotation") from exc
    if sha256_bytes(mask_snapshot) != policy["maskSha256"]:
        raise ValueError("mask bytes do not match maskPolicy")
    resolved_parent_path = Path(parent_path).absolute()
    parent_snapshot = bytes(parent_snapshot)
    hard_boundary_enabled = policy["hardBoundary"]["postprocess"] == "parent-blend"
    if hard_boundary_enabled:
        if not parent_snapshot.startswith(PNG_SIGNATURE):
            raise ValueError("masked edit hard boundaries require a PNG parent image")
        parent = decode_png_rgba(parent_snapshot)
        parent_dimensions = (parent.width, parent.height)
    else:
        parent = None
        parent_mime_type = _detect_image_mime_type(parent_snapshot)
        parent_dimensions = inspect_image(parent_snapshot, parent_mime_type)
    mask = decode_png_rgba(mask_snapshot, require_alpha=True)
    if parent_dimensions != (width, height):
        raise ValueError("parent image dimensions do not match maskPolicy")
    if (mask.width, mask.height) != (width, height):
        raise ValueError("mask dimensions do not match maskPolicy")
    mask_alpha = bytes(mask.pixels[index] for index in range(3, len(mask.pixels), 4))
    if policy["strategy"] == "protect-only" and any(alpha != 0 for alpha in mask_alpha):
        raise ValueError("protect-only requires a fully transparent mask")

    return MaskedEditContext(
        source_prompt=source_prompt,
        effective_prompt=effective_prompt,
        parent_path=resolved_parent_path,
        parent_snapshot=parent_snapshot,
        parent=parent,
        width=width,
        height=height,
        mask_path=mask_path,
        mask_snapshot=mask_snapshot,
        mask_alpha=mask_alpha,
        policy=policy,
        submission_id=submission_id,
    )


def finalize_masked_images(context: MaskedEditContext, images: list[bytes]) -> list[bytes]:
    if len(images) != 1:
        raise ValueError("masked edit requires exactly one provider image")
    generated = decode_png_rgba(images[0])
    if (generated.width, generated.height) != (context.width, context.height):
        raise ValueError("masked edit result dimensions do not match the parent image")
    if context.policy["hardBoundary"]["postprocess"] == "none":
        final_pixels = generated.pixels
    else:
        if context.parent is None:
            raise ValueError("masked edit hard boundary parent pixels are unavailable")
        final_pixels = blend_rgba(context.parent.pixels, generated.pixels, context.mask_alpha)
    return [encode_png_rgba(context.width, context.height, final_pixels)]


def masked_edit_audit(context: MaskedEditContext) -> dict[str, Any]:
    return {
        "sourcePrompt": context.source_prompt,
        "effectivePrompt": context.effective_prompt,
        "effectivePromptSha256": sha256_bytes(context.effective_prompt.encode("utf-8")),
        "annotationId": context.policy["annotationId"],
        "maskSha256": context.policy["maskSha256"],
        "maskPolicySha256": context.policy["policySha256"],
        "maskPolicyVersion": context.policy["policyVersion"],
        "promptGuardVersion": MASK_PROMPT_GUARD_VERSION,
        "maskStrategy": context.policy["strategy"],
        "providerMaskUploaded": True,
        "hardBoundarySource": context.policy["hardBoundary"]["source"],
        "hardBoundaryPostprocess": context.policy["hardBoundary"]["postprocess"],
        "hardBoundaryBlendApplied": context.policy["hardBoundary"]["postprocess"] == "parent-blend",
        "semanticProtectionRequested": context.policy["semanticProtection"]["enabled"],
        "semanticProtectionSource": (
            context.policy["semanticProtection"]["source"]
            if context.policy["semanticProtection"]["enabled"]
            else "none"
        ),
        "finalFormat": "png",
        "finalWidth": context.width,
        "finalHeight": context.height,
        "submissionId": context.submission_id,
    }


def decode_png_rgba(snapshot: bytes, *, require_alpha: bool = False) -> DecodedPng:
    if not isinstance(snapshot, bytes) or not snapshot.startswith(PNG_SIGNATURE):
        raise ValueError("invalid PNG image")
    offset = len(PNG_SIGNATURE)
    width = height = bit_depth = color_type = None
    idat_chunks: list[bytes] = []
    saw_end = False
    while offset < len(snapshot):
        if offset + 12 > len(snapshot):
            raise ValueError("invalid PNG chunk header")
        length = int.from_bytes(snapshot[offset : offset + 4], "big")
        chunk_end = offset + 12 + length
        if chunk_end > len(snapshot):
            raise ValueError("invalid PNG chunk length")
        kind = snapshot[offset + 4 : offset + 8]
        data = snapshot[offset + 8 : offset + 8 + length]
        expected_crc = int.from_bytes(snapshot[offset + 8 + length : chunk_end], "big")
        if zlib.crc32(kind + data) & 0xFFFFFFFF != expected_crc:
            raise ValueError("invalid PNG chunk checksum")
        offset = chunk_end
        if kind == b"IHDR":
            if len(data) != 13 or width is not None:
                raise ValueError("invalid PNG IHDR")
            width = int.from_bytes(data[0:4], "big")
            height = int.from_bytes(data[4:8], "big")
            bit_depth = data[8]
            color_type = data[9]
            if data[10:] != b"\x00\x00\x00":
                raise ValueError("unsupported PNG compression, filtering, or interlace")
        elif kind == b"IDAT":
            idat_chunks.append(data)
        elif kind == b"IEND":
            if data:
                raise ValueError("invalid PNG IEND")
            saw_end = True
            break

    if not saw_end or width is None or height is None or not width or not height or not idat_chunks:
        raise ValueError("invalid PNG structure")
    if bit_depth != 8 or color_type not in {2, 6}:
        raise ValueError("only 8-bit RGB/RGBA PNG images are supported")
    if require_alpha and color_type != 6:
        raise ValueError("mask PNG must contain an alpha channel")

    channels = 4 if color_type == 6 else 3
    if width * height > MAX_PNG_PIXELS:
        raise ValueError("PNG pixel count exceeds the supported limit")
    stride = width * channels
    expected_length = height * (stride + 1)
    raw = _decompress_png_data(b"".join(idat_chunks), expected_length)

    rgba = bytearray(width * height * 4)
    previous = bytes(stride)
    position = 0
    output_offset = 0
    for _ in range(height):
        filter_type = raw[position]
        position += 1
        scanline = raw[position : position + stride]
        position += stride
        row = _unfilter_png_scanline(filter_type, scanline, previous, channels)
        previous = row
        for x in range(width):
            source_offset = x * channels
            rgba[output_offset : output_offset + 3] = row[source_offset : source_offset + 3]
            rgba[output_offset + 3] = row[source_offset + 3] if channels == 4 else 255
            output_offset += 4
    return DecodedPng(width, height, bytes(rgba), color_type == 6)


def encode_png_rgba(width: int, height: int, pixels: bytes) -> bytes:
    width = _positive_int(width, "PNG width")
    height = _positive_int(height, "PNG height")
    if not isinstance(pixels, bytes) or len(pixels) != width * height * 4:
        raise ValueError("PNG RGBA pixels do not match the requested dimensions")
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        start = y * width * 4
        raw.extend(pixels[start : start + width * 4])
    ihdr = width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00"
    return PNG_SIGNATURE + b"".join(
        [
            _png_chunk(b"IHDR", ihdr),
            _png_chunk(b"IDAT", zlib.compress(bytes(raw))),
            _png_chunk(b"IEND", b""),
        ]
    )


def blend_rgba(parent: bytes, generated: bytes, mask_alpha: bytes) -> bytes:
    """Blend packed RGBA pixels using mask alpha as the parent-image weight."""
    if len(parent) != len(generated) or len(parent) % 4 != 0:
        raise ValueError("parent and generated RGBA buffers must have equal pixel lengths")
    if len(mask_alpha) != len(parent) // 4:
        raise ValueError("mask alpha must contain exactly one byte per RGBA pixel")

    output = bytearray(len(parent))
    for pixel_index, mask_byte in enumerate(mask_alpha):
        offset = pixel_index * 4
        if mask_byte == 255:
            output[offset : offset + 4] = parent[offset : offset + 4]
            continue
        if mask_byte == 0:
            output[offset : offset + 4] = generated[offset : offset + 4]
            continue

        parent_weight = mask_byte / 255.0
        generated_weight = 1.0 - parent_weight
        parent_alpha = parent[offset + 3] / 255.0
        generated_alpha = generated[offset + 3] / 255.0
        output_alpha = parent_weight * parent_alpha + generated_weight * generated_alpha

        if output_alpha == 0.0:
            output[offset : offset + 4] = b"\x00\x00\x00\x00"
            continue

        for channel in range(3):
            parent_linear = _srgb_byte_to_linear(parent[offset + channel])
            generated_linear = _srgb_byte_to_linear(generated[offset + channel])
            premultiplied = (
                parent_weight * parent_linear * parent_alpha
                + generated_weight * generated_linear * generated_alpha
            )
            output[offset + channel] = _unit_to_byte(_linear_to_srgb(premultiplied / output_alpha))
        output[offset + 3] = _unit_to_byte(output_alpha)

    return bytes(output)


def _unfilter_png_scanline(filter_type: int, scanline: bytes, previous: bytes, bpp: int) -> bytes:
    row = bytearray(scanline)
    for index in range(len(row)):
        left = row[index - bpp] if index >= bpp else 0
        up = previous[index]
        up_left = previous[index - bpp] if index >= bpp else 0
        if filter_type == 0:
            continue
        if filter_type == 1:
            row[index] = (row[index] + left) & 0xFF
        elif filter_type == 2:
            row[index] = (row[index] + up) & 0xFF
        elif filter_type == 3:
            row[index] = (row[index] + ((left + up) // 2)) & 0xFF
        elif filter_type == 4:
            row[index] = (row[index] + _paeth_predictor(left, up, up_left)) & 0xFF
        else:
            raise ValueError("unsupported PNG filter type")
    return bytes(row)


def _paeth_predictor(left: int, up: int, up_left: int) -> int:
    prediction = left + up - up_left
    distances = (abs(prediction - left), abs(prediction - up), abs(prediction - up_left))
    if distances[0] <= distances[1] and distances[0] <= distances[2]:
        return left
    return up if distances[1] <= distances[2] else up_left


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    checksum = zlib.crc32(kind + data) & 0xFFFFFFFF
    return len(data).to_bytes(4, "big") + kind + data + checksum.to_bytes(4, "big")


def _positive_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _detect_image_mime_type(snapshot: bytes) -> str:
    if snapshot.startswith(PNG_SIGNATURE):
        return "image/png"
    if snapshot.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if len(snapshot) >= 12 and snapshot[:4] == b"RIFF" and snapshot[8:12] == b"WEBP":
        return "image/webp"
    raise ValueError("parent image format is unsupported")


def _decompress_png_data(compressed: bytes, expected_length: int) -> bytes:
    decompressor = zlib.decompressobj()
    try:
        raw = decompressor.decompress(compressed, expected_length + 1)
        if len(raw) > expected_length or decompressor.unconsumed_tail:
            raise ValueError("PNG pixel data length does not match its dimensions")
        raw += decompressor.flush(expected_length + 1 - len(raw))
    except zlib.error as exc:
        raise ValueError("invalid PNG compressed data") from exc
    if (
        len(raw) != expected_length
        or not decompressor.eof
        or decompressor.unused_data
        or decompressor.unconsumed_tail
    ):
        raise ValueError("PNG pixel data length does not match its dimensions")
    return raw


def _nonempty_string(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    return value


def _positive_finite_number(value: Any) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError("mask policy radiusPx must be a positive finite number")
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _parse_size(value: Any) -> tuple[int, int]:
    if not isinstance(value, str):
        raise ValueError("masked edit size must be a width x height string")
    parts = value.lower().replace("*", "x").split("x", 1)
    if len(parts) != 2:
        raise ValueError("masked edit size is invalid")
    try:
        return int(parts[0]), int(parts[1])
    except ValueError as exc:
        raise ValueError("masked edit size is invalid") from exc


def _srgb_byte_to_linear(value: int) -> float:
    srgb = value / 255.0
    if srgb <= 0.04045:
        return srgb / 12.92
    return ((srgb + 0.055) / 1.055) ** 2.4


def _linear_to_srgb(value: float) -> float:
    if value <= 0.0031308:
        return 12.92 * value
    return 1.055 * (value ** (1.0 / 2.4)) - 0.055


def _unit_to_byte(value: float) -> int:
    return min(255, max(0, int(value * 255.0 + 0.5)))
