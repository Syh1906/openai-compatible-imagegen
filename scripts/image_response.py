"""Bounded response reads and structural image-response validation."""

from __future__ import annotations

import base64
import binascii
import json
from typing import Any

from image_png import PNG_SIGNATURE, read_png_rgba_bytes


MAX_JSON_RESPONSE_BYTES = 96 * 1024 * 1024
MAX_IMAGE_RESPONSE_BYTES = 64 * 1024 * 1024
READ_CHUNK_BYTES = 64 * 1024


def read_limited_bytes(stream: Any, limit: int, label: str) -> bytes:
    headers = getattr(stream, "headers", None)
    content_length = headers.get("Content-Length") if headers is not None else None
    if isinstance(content_length, str) and content_length.isdigit() and int(content_length) > limit:
        raise ValueError(f"{label} exceeds {limit} byte limit")

    chunks: list[bytes] = []
    total = 0
    while True:
        remaining = limit - total
        chunk = stream.read(min(READ_CHUNK_BYTES, remaining + 1))
        if not chunk:
            if isinstance(content_length, str) and content_length.isdigit() and total != int(content_length):
                raise ValueError(f"{label} was incomplete")
            return b"".join(chunks)
        if not isinstance(chunk, bytes):
            raise ValueError(f"{label} stream did not return bytes")
        total += len(chunk)
        if total > limit:
            raise ValueError(f"{label} exceeds {limit} byte limit")
        chunks.append(chunk)


def read_json_response(stream: Any, limit: int = MAX_JSON_RESPONSE_BYTES) -> dict[str, Any]:
    try:
        payload = read_limited_bytes(stream, limit, "JSON response")
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError(str(exc)) from exc
    if not isinstance(value, dict):
        raise ValueError("API JSON response must be an object")
    return value


def safe_error_body(stream: Any) -> str:
    try:
        return stream.read(2001).decode("utf-8", errors="replace")[:2000]
    except Exception:
        return str(getattr(stream, "reason", "request failed"))


def decode_base64_image(value: str, limit: int = MAX_IMAGE_RESPONSE_BYTES) -> bytes:
    max_encoded = ((limit + 2) // 3) * 4
    if len(value) > max_encoded:
        raise ValueError(f"image response exceeds {limit} byte limit")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("image item b64_json is not valid base64") from exc
    if len(decoded) > limit:
        raise ValueError(f"image response exceeds {limit} byte limit")
    return decoded


def detect_image_format(data: bytes) -> str | None:
    try:
        if data.startswith(PNG_SIGNATURE):
            read_png_rgba_bytes(data)
            return "png"
        if _is_valid_jpeg(data):
            return "jpeg"
        if _is_valid_webp(data):
            return "webp"
    except ValueError:
        return None
    return None


def _is_valid_jpeg(data: bytes) -> bool:
    if len(data) < 8 or not data.startswith(b"\xff\xd8") or not data.endswith(b"\xff\xd9"):
        return False
    position = 2
    saw_sof = False
    saw_sos = False
    saw_scan_data = False
    frame_components = 0
    frame_component_ids: set[int] = set()
    referenced_quantization_tables: set[int] = set()
    defined_quantization_tables: set[int] = set()
    while position < len(data):
        if data[position] != 0xFF:
            return False
        while position < len(data) and data[position] == 0xFF:
            position += 1
        if position >= len(data):
            return False
        marker = data[position]
        position += 1
        if marker == 0xD9:
            return (
                saw_sof
                and saw_sos
                and saw_scan_data
                and referenced_quantization_tables.issubset(defined_quantization_tables)
                and position == len(data)
            )
        if marker == 0x01:
            continue
        if marker == 0x00 or marker == 0xD8 or 0xD0 <= marker <= 0xD7:
            return False
        if position + 2 > len(data):
            return False
        segment_length = int.from_bytes(data[position : position + 2], "big")
        if segment_length < 2 or position + segment_length > len(data):
            return False
        segment_end = position + segment_length
        segment = data[position + 2 : segment_end]
        if marker == 0xDB:
            if not _parse_jpeg_quantization_tables(segment, defined_quantization_tables):
                return False
        if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
            if segment_length < 11 or len(segment) < 6:
                return False
            if segment[0] not in {8, 12}:
                return False
            frame_components = segment[5]
            if (
                frame_components < 1
                or frame_components > 4
                or segment_length != 8 + 3 * frame_components
                or int.from_bytes(segment[1:3], "big") < 1
                or int.from_bytes(segment[3:5], "big") < 1
            ):
                return False
            frame_component_ids = set()
            for offset in range(6, len(segment), 3):
                component_id = segment[offset]
                if component_id in frame_component_ids or segment[offset + 1] == 0:
                    return False
                frame_component_ids.add(component_id)
                if marker not in {0xC3, 0xC7, 0xCB, 0xCF}:
                    quantization_table = segment[offset + 2]
                    if quantization_table > 3:
                        return False
                    referenced_quantization_tables.add(quantization_table)
            saw_sof = True
        if marker == 0xDA:
            scan_components = segment[0] if segment else 0
            if (
                not saw_sof
                or scan_components < 1
                or scan_components > frame_components
                or segment_length != 6 + 2 * scan_components
                or segment_end >= len(data) - 2
            ):
                return False
            scan_component_ids = {segment[offset] for offset in range(1, 1 + 2 * scan_components, 2)}
            if len(scan_component_ids) != scan_components or not scan_component_ids.issubset(frame_component_ids):
                return False
            saw_sos = True
            next_marker, has_scan_data = _consume_jpeg_scan(data, segment_end)
            if next_marker is None or not has_scan_data:
                return False
            saw_scan_data = True
            position = next_marker
            continue
        position = segment_end
    return False


def _parse_jpeg_quantization_tables(segment: bytes, defined: set[int]) -> bool:
    if not segment:
        return False
    offset = 0
    while offset < len(segment):
        table_info = segment[offset]
        precision = table_info >> 4
        table_id = table_info & 0x0F
        if precision not in {0, 1} or table_id > 3:
            return False
        table_size = 64 * (2 if precision else 1)
        offset += 1 + table_size
        if offset > len(segment):
            return False
        defined.add(table_id)
    return offset == len(segment)


def _consume_jpeg_scan(data: bytes, position: int) -> tuple[int | None, bool]:
    saw_scan_data = False
    while position < len(data):
        if data[position] != 0xFF:
            saw_scan_data = True
            position += 1
            continue
        marker_start = position
        position += 1
        while position < len(data) and data[position] == 0xFF:
            position += 1
        if position >= len(data):
            return None, saw_scan_data
        marker = data[position]
        if marker == 0x00:
            saw_scan_data = True
            position += 1
            continue
        if 0xD0 <= marker <= 0xD7:
            if not saw_scan_data:
                return None, False
            position += 1
            continue
        return marker_start, saw_scan_data
    return None, saw_scan_data


def _is_valid_webp(data: bytes) -> bool:
    if len(data) < 20 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return False
    if int.from_bytes(data[4:8], "little") + 8 != len(data):
        return False
    position = 12
    saw_image = False
    while position < len(data):
        if position + 8 > len(data):
            return False
        kind = data[position : position + 4]
        length = int.from_bytes(data[position + 4 : position + 8], "little")
        chunk_end = position + 8 + length
        if chunk_end > len(data):
            return False
        payload = data[position + 8 : chunk_end]
        if kind == b"VP8 " and not _is_valid_vp8(payload):
            return False
        if kind == b"VP8L" and not _is_valid_vp8l(payload):
            return False
        if kind == b"VP8X" and length != 10:
            return False
        if kind == b"ANMF" and not _has_valid_webp_frame(payload):
            return False
        if kind in {b"VP8 ", b"VP8L", b"ANMF"}:
            saw_image = True
        position = chunk_end + (length % 2)
    return position == len(data) and saw_image


def _is_valid_vp8(payload: bytes) -> bool:
    if len(payload) < 10 or payload[0] & 1 != 0 or payload[3:6] != b"\x9d\x01\x2a":
        return False
    first_partition_length = (int.from_bytes(payload[:3], "little") >> 5) & 0x7FFFF
    return (
        first_partition_length > 0
        and len(payload) >= 10 + first_partition_length
        and int.from_bytes(payload[6:8], "little") & 0x3FFF > 0
        and int.from_bytes(payload[8:10], "little") & 0x3FFF > 0
    )


def _is_valid_vp8l(payload: bytes) -> bool:
    if len(payload) < 6 or payload[0] != 0x2F:
        return False
    header = int.from_bytes(payload[1:5], "little")
    return ((header >> 29) & 0x07) == 0


def _has_valid_webp_frame(payload: bytes) -> bool:
    if len(payload) < 24:
        return False
    position = 16
    saw_image = False
    while position < len(payload):
        if position + 8 > len(payload):
            return False
        kind = payload[position : position + 4]
        length = int.from_bytes(payload[position + 4 : position + 8], "little")
        chunk_end = position + 8 + length
        if chunk_end > len(payload):
            return False
        chunk = payload[position + 8 : chunk_end]
        if kind == b"VP8 ":
            saw_image = _is_valid_vp8(chunk)
        elif kind == b"VP8L":
            saw_image = _is_valid_vp8l(chunk)
        elif kind != b"ALPH":
            return False
        if kind in {b"VP8 ", b"VP8L"} and not saw_image:
            return False
        position = chunk_end + (length % 2)
    return position == len(payload) and saw_image
