"""Bounded response reads and structural image-response validation."""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
import json
import os
from pathlib import Path
from typing import Callable
from typing import Any
import zlib

from scripts.image_png import MAX_PNG_IDAT_CHUNKS, PNG_SIGNATURE
from scripts.image_transaction import OutputTransaction
from scripts.image_webp import WebPDecodeError, WebPResourceLimitError, validate_vp8l_payload


MAX_JSON_RESPONSE_BYTES = 96 * 1024 * 1024
MAX_IMAGE_RESPONSE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_IMAGE_RESPONSE_BYTES = 256 * 1024 * 1024
MAX_IMAGE_RESPONSE_ITEMS = 64
MAX_PNG_DEEP_VALIDATION_BYTES = 96 * 1024 * 1024
MAX_PNG_STREAM_VALIDATION_BYTES = 512 * 1024 * 1024
READ_CHUNK_BYTES = 64 * 1024


class ImageValidationResourceError(ValueError):
    pass


@dataclass(frozen=True)
class ImageInspection:
    image_format: str
    width: int
    height: int
    validation_warning: str | None


def publish_response_images(
    response: dict[str, Any],
    out_file: Path,
    requested_format: str,
    decode_item: Callable[[dict[str, Any]], bytes],
    expected_count: int | None = None,
    expected_size: tuple[int, int] | None = None,
    planned_extra_dir: Path | None = None,
) -> dict[str, Any]:
    """Publish every complete API image and report non-blocking spec deviations."""
    data = response.get("data")
    if not isinstance(data, list) or not data:
        raise ValueError("API response did not include data images")
    warnings: list[str] = []
    planned_count = expected_count if expected_count is not None else len(data)
    extra_dir: Path | None = None
    reports: list[dict[str, Any]] = []
    files: list[str] = []
    total_decoded_bytes = 0
    for response_index, item in enumerate(data, start=1):
        if response_index > MAX_IMAGE_RESPONSE_ITEMS:
            warnings.append(
                f"api_response_item_limit_exceeded: API returned {len(data)} image item(s), above "
                f"the {MAX_IMAGE_RESPONSE_ITEMS}-item processing limit; already published originals "
                "were preserved"
            )
            break
        if not isinstance(item, dict):
            warnings.append(
                f"api_response_item_unusable: API image item {response_index} is not an object; "
                "no image could be published for that item"
            )
            continue
        try:
            raw = decode_item(item)
        except Exception as exc:
            warnings.append(
                f"api_response_item_unusable: API image item {response_index} could not be decoded "
                f"({exc}); no image could be published for that item"
            )
            continue
        if total_decoded_bytes + len(raw) > MAX_TOTAL_IMAGE_RESPONSE_BYTES:
            warnings.append(
                f"api_response_total_bytes_exceeded: decoded API images would exceed the "
                f"{MAX_TOTAL_IMAGE_RESPONSE_BYTES}-byte cumulative processing limit at item "
                f"{response_index}; already published originals were preserved"
            )
            break
        total_decoded_bytes += len(raw)
        try:
            actual_format, validation_warning = _inspect_image_format(raw)
        except ImageValidationResourceError as exc:
            warnings.append(
                f"api_response_item_resource_limited: API image item {response_index} could not be "
                f"validated within resource limits ({exc}); no image could be published for that item"
            )
            continue
        if actual_format is None:
            warnings.append(
                f"api_response_item_unusable: API image item {response_index} did not contain a "
                "complete PNG, JPEG, or WebP image; no image could be published for that item"
            )
            continue
        item_warnings: list[str] = []
        try:
            actual_size: tuple[int, int] | None = None
            try:
                actual_size = image_dimensions(raw, actual_format)
            except ValueError as exc:
                item_warnings.append(
                    f"api_response_dimensions_unavailable: API image item {response_index} could not be "
                    f"measured ({exc}); original image was published"
                )

            if response_index <= planned_count:
                target = _response_target(
                    out_file,
                    response_index - 1,
                    planned_count,
                    actual_format,
                )
            else:
                if extra_dir is None:
                    extra_dir = (
                        _prepare_planned_extra_directory(planned_extra_dir)
                        if planned_extra_dir is not None
                        else _create_extra_directory(out_file)
                    )
                target = extra_dir / f"{out_file.stem}_{response_index}.{actual_format}"
            item: dict[str, Any] = {
                "response_index": response_index,
                "file": target.resolve().as_posix(),
                "requested_format": requested_format,
                "actual_format": actual_format,
            }
            if expected_size is not None:
                item["requested_size"] = list(expected_size)
            if actual_size is not None:
                item["actual_size"] = list(actual_size)
                if expected_size is not None and actual_size != expected_size:
                    item_warnings.append(
                        f"api_response_size_mismatch: API image item {response_index} is "
                        f"{actual_size[0]}x{actual_size[1]}; requested "
                        f"{expected_size[0]}x{expected_size[1]}; original image was published"
                    )
            if actual_format != requested_format:
                item_warnings.append(
                    f"api_response_format_mismatch: API image item {response_index} is {actual_format}; "
                    f"requested {requested_format}; original image was published as "
                    f"{target.resolve().as_posix()}"
                )
            if validation_warning is not None:
                item_warnings.append(
                    f"api_response_validation_budget_exceeded: API image item {response_index} "
                    f"{validation_warning}; original image was published"
                )

            with OutputTransaction() as transaction:
                staged = transaction.stage_path(target)
                staged.write_bytes(raw)
                transaction.commit()
        except (OSError, ValueError) as exc:
            warnings.append(
                f"api_response_item_publish_failed: API image item {response_index} could not be "
                f"published ({exc}); other complete API images were preserved"
            )
            continue
        published_item = dict(item)
        published_item["index"] = len(reports) + 1
        reports.append(published_item)
        files.append(target.resolve().as_posix())
        warnings.extend(item_warnings)

    if not files:
        if extra_dir is not None:
            try:
                extra_dir.rmdir()
            except OSError:
                pass
        detail = next(
            (
                warning
                for warning in warnings
                if warning.startswith(
                    (
                        "api_response_item_publish_failed:",
                        "api_response_total_bytes_exceeded:",
                        "api_response_item_limit_exceeded:",
                        "api_response_item_resource_limited:",
                    )
                )
            ),
            warnings[0] if warnings else "API response did not include a complete image",
        )
        raise ValueError(detail)

    if expected_count is not None and len(files) != expected_count:
        warnings.append(
            f"api_response_count_mismatch: published {len(files)} API image(s); "
            f"requested {expected_count}; available originals were published"
        )

    return {
        "files": files,
        "warnings": warnings,
        "api_delivery": {
            "status": "published_with_warnings" if warnings else "published",
            "requested_count": expected_count,
            "actual_count": len(files),
            "requested_format": requested_format,
            "requested_size": list(expected_size) if expected_size is not None else None,
            "items": reports,
        },
    }


def _response_target(out_file: Path, index: int, count: int, actual_format: str) -> Path:
    suffix = out_file.suffix.lower()
    normalized_suffix = "jpeg" if suffix == ".jpg" else suffix.lstrip(".")
    if normalized_suffix != actual_format:
        suffix = f".{actual_format}"
    if count == 1:
        return out_file.with_suffix(suffix)
    return out_file.with_name(f"{out_file.stem}_{index + 1}{suffix}")


def _create_extra_directory(out_file: Path) -> Path:
    out_file.parent.mkdir(parents=True, exist_ok=True)
    base = out_file.parent / f"{out_file.stem}-api-extra"
    for suffix in range(1, 10_000):
        candidate = base if suffix == 1 else base.with_name(f"{base.name}-{suffix}")
        try:
            os.mkdir(candidate)
            return candidate
        except FileExistsError:
            continue
    raise ValueError("could not allocate a unique directory for extra API images")


def _prepare_planned_extra_directory(path: Path) -> Path:
    path = path.expanduser().resolve()
    if path.is_symlink() or (path.exists() and not path.is_dir()):
        raise ValueError(f"planned API extra path must be a directory: {path}")
    path.mkdir(parents=True, exist_ok=True)
    return path


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
    finally:
        stream.close()


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
    return _inspect_image_format(data)[0]


def inspect_response_image(data: bytes) -> ImageInspection:
    """Deeply validate one provider image and return its actual format and size."""
    image_format, validation_warning = _inspect_image_format(data)
    if image_format is None:
        raise ValueError("image is not a complete PNG, JPEG, or WebP payload")
    width, height = image_dimensions(data, image_format)
    return ImageInspection(
        image_format=image_format,
        width=width,
        height=height,
        validation_warning=validation_warning,
    )


def _inspect_image_format(data: bytes) -> tuple[str | None, str | None]:
    try:
        if data.startswith(PNG_SIGNATURE):
            deep_validated, expected_bytes = _validate_png_response(data)
            warning = None
            if not deep_validated:
                warning = (
                    f"requires {expected_bytes} decompressed scanline bytes, above the "
                    f"{MAX_PNG_DEEP_VALIDATION_BYTES}-byte deep-validation budget"
                )
            return "png", warning
        if _is_valid_jpeg(data):
            return "jpeg", None
        if _is_valid_webp(data):
            return "webp", None
    except ImageValidationResourceError:
        raise
    except ValueError:
        return None, None
    return None, None


def _validate_png_response(data: bytes) -> tuple[bool, int]:
    """Validate a complete standard PNG without applying post-processing codec limits."""
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("invalid PNG signature")
    view = memoryview(data)
    offset = len(PNG_SIGNATURE)
    width = height = bit_depth = color_type = interlace = None
    idat_chunks: list[memoryview] = []
    palette_entries: int | None = None
    saw_ihdr = False
    saw_plte = False
    saw_trns = False
    saw_idat = False
    ended_idat = False
    saw_iend = False
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError("invalid PNG chunk header")
        length = int.from_bytes(view[offset : offset + 4], "big")
        kind = bytes(view[offset + 4 : offset + 8])
        chunk_end = offset + 12 + length
        if chunk_end > len(data):
            raise ValueError("invalid PNG chunk length")
        payload = view[offset + 8 : offset + 8 + length]
        expected_crc = int.from_bytes(view[offset + 8 + length : chunk_end], "big")
        checksum = zlib.crc32(payload, zlib.crc32(kind)) & 0xFFFFFFFF
        if checksum != expected_crc:
            raise ValueError("invalid PNG chunk CRC")
        offset = chunk_end

        if not saw_ihdr and kind != b"IHDR":
            raise ValueError("invalid PNG IHDR placement")
        if kind == b"IHDR":
            if saw_ihdr or length != 13:
                raise ValueError("invalid PNG IHDR")
            width = int.from_bytes(payload[0:4], "big")
            height = int.from_bytes(payload[4:8], "big")
            bit_depth = payload[8]
            color_type = payload[9]
            compression = payload[10]
            filter_method = payload[11]
            interlace = payload[12]
            if width < 1 or height < 1 or width > 0x7FFFFFFF or height > 0x7FFFFFFF:
                raise ValueError("invalid PNG dimensions")
            valid_depths = {
                0: {1, 2, 4, 8, 16},
                2: {8, 16},
                3: {1, 2, 4, 8},
                4: {8, 16},
                6: {8, 16},
            }
            if color_type not in valid_depths or bit_depth not in valid_depths[color_type]:
                raise ValueError("invalid PNG color type or bit depth")
            if compression != 0 or filter_method != 0 or interlace not in {0, 1}:
                raise ValueError("unsupported PNG encoding method")
            saw_ihdr = True
            continue
        if kind == b"PLTE":
            if saw_plte or saw_idat or color_type in {0, 4} or length < 3 or length > 768 or length % 3:
                raise ValueError("invalid PNG PLTE")
            palette_entries = length // 3
            if color_type == 3 and palette_entries > 1 << int(bit_depth):
                raise ValueError("invalid indexed PNG palette")
            saw_plte = True
            continue
        if kind == b"tRNS":
            if saw_trns or saw_idat or color_type in {4, 6}:
                raise ValueError("invalid PNG tRNS")
            if color_type == 0 and length != 2:
                raise ValueError("invalid grayscale PNG tRNS")
            if color_type == 2 and length != 6:
                raise ValueError("invalid truecolor PNG tRNS")
            if color_type == 3 and (palette_entries is None or length > palette_entries):
                raise ValueError("invalid indexed PNG tRNS")
            saw_trns = True
            continue
        if kind == b"IDAT":
            if ended_idat:
                raise ValueError("non-consecutive PNG IDAT chunks")
            if color_type == 3 and not saw_plte:
                raise ValueError("indexed PNG is missing PLTE")
            if len(idat_chunks) >= MAX_PNG_IDAT_CHUNKS:
                raise ValueError("PNG contains too many IDAT chunks")
            idat_chunks.append(payload)
            saw_idat = True
            continue
        if saw_idat:
            ended_idat = True
        if kind == b"IEND":
            if length != 0 or not saw_idat:
                raise ValueError("invalid PNG IEND")
            saw_iend = True
            break
        if kind and 65 <= kind[0] <= 90:
            raise ValueError("unknown critical PNG chunk")

    if (
        not saw_ihdr
        or not saw_idat
        or not saw_iend
        or offset != len(data)
        or width is None
        or height is None
        or bit_depth is None
        or color_type is None
        or interlace is None
    ):
        raise ValueError("invalid PNG: missing or trailing required data")
    expected_bytes = _png_expected_scanline_bytes(
        width, height, bit_depth, color_type, interlace
    )
    if expected_bytes > MAX_PNG_STREAM_VALIDATION_BYTES:
        raise ImageValidationResourceError(
            f"PNG scanline validation requires {expected_bytes} bytes, above the "
            f"{MAX_PNG_STREAM_VALIDATION_BYTES}-byte resource limit"
        )
    if expected_bytes > MAX_PNG_DEEP_VALIDATION_BYTES:
        _validate_png_stream_length(idat_chunks, expected_bytes)
        return False, expected_bytes
    _validate_png_scanlines(idat_chunks, width, height, bit_depth, color_type, interlace)
    return True, expected_bytes


def _validate_png_stream_length(
    idat_chunks: list[memoryview],
    expected_bytes: int,
) -> None:
    """Validate zlib completeness and output length without retaining scanlines."""
    decompressor = zlib.decompressobj()
    decompressed = 0
    try:
        for chunk_index, chunk in enumerate(idat_chunks):
            pending = chunk
            if decompressor.eof and pending:
                raise ValueError("PNG image data has trailing compressed bytes")
            while pending:
                output = decompressor.decompress(pending, READ_CHUNK_BYTES)
                decompressed += len(output)
                if decompressed > expected_bytes:
                    raise ValueError("PNG image data exceeds expected scanlines")
                pending = decompressor.unconsumed_tail
                if decompressor.eof:
                    if pending or decompressor.unused_data or any(idat_chunks[chunk_index + 1 :]):
                        raise ValueError("PNG image data has trailing compressed bytes")
                    break
    except zlib.error as exc:
        raise ValueError("invalid PNG compressed image data") from exc
    if not decompressor.eof or decompressor.unused_data or decompressor.unconsumed_tail:
        raise ValueError("incomplete PNG compressed image data")
    if decompressed != expected_bytes:
        raise ValueError("incomplete PNG scanline data")


def _validate_png_scanlines(
    idat_chunks: list[memoryview],
    width: int,
    height: int,
    bit_depth: int,
    color_type: int,
    interlace: int,
) -> None:
    row_lengths = iter(_png_row_lengths(width, height, bit_depth, color_type, interlace))
    current_length = next(row_lengths, None)
    row_position = 0

    def consume(output: bytes) -> None:
        nonlocal current_length, row_position
        position = 0
        while position < len(output):
            if current_length is None:
                raise ValueError("PNG image data exceeds expected scanlines")
            if row_position == 0:
                if output[position] > 4:
                    raise ValueError("invalid PNG scanline filter")
                position += 1
                row_position = 1
                continue
            remaining = current_length + 1 - row_position
            consumed = min(remaining, len(output) - position)
            position += consumed
            row_position += consumed
            if row_position == current_length + 1:
                current_length = next(row_lengths, None)
                row_position = 0

    decompressor = zlib.decompressobj()
    try:
        for chunk_index, chunk in enumerate(idat_chunks):
            pending = chunk
            if decompressor.eof and pending:
                raise ValueError("PNG image data has trailing compressed bytes")
            while pending:
                output = decompressor.decompress(pending, READ_CHUNK_BYTES)
                consume(output)
                pending = decompressor.unconsumed_tail
                if decompressor.eof:
                    if pending or decompressor.unused_data or any(idat_chunks[chunk_index + 1 :]):
                        raise ValueError("PNG image data has trailing compressed bytes")
                    break
            if not chunk:
                consume(decompressor.decompress(b"", READ_CHUNK_BYTES))
        consume(decompressor.flush(READ_CHUNK_BYTES))
    except zlib.error as exc:
        raise ValueError("invalid PNG compressed image data") from exc
    if not decompressor.eof or decompressor.unused_data or decompressor.unconsumed_tail:
        raise ValueError("incomplete PNG compressed image data")
    if current_length is not None or row_position:
        raise ValueError("incomplete PNG scanline data")


def _png_expected_scanline_bytes(
    width: int,
    height: int,
    bit_depth: int,
    color_type: int,
    interlace: int,
) -> int:
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    if interlace == 0:
        row_bytes = (width * channels * bit_depth + 7) // 8
        return height * (row_bytes + 1)
    total = 0
    for x_start, y_start, x_step, y_step in _PNG_ADAM7_PASSES:
        pass_width = 0 if width <= x_start else (width - x_start + x_step - 1) // x_step
        pass_height = 0 if height <= y_start else (height - y_start + y_step - 1) // y_step
        if pass_width:
            row_bytes = (pass_width * channels * bit_depth + 7) // 8
            total += pass_height * (row_bytes + 1)
    return total


_PNG_ADAM7_PASSES = (
    (0, 0, 8, 8),
    (4, 0, 8, 8),
    (0, 4, 4, 8),
    (2, 0, 4, 4),
    (0, 2, 2, 4),
    (1, 0, 2, 2),
    (0, 1, 1, 2),
)


def _png_row_lengths(
    width: int,
    height: int,
    bit_depth: int,
    color_type: int,
    interlace: int,
):
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    if interlace == 0:
        row_bytes = (width * channels * bit_depth + 7) // 8
        for _ in range(height):
            yield row_bytes
        return
    for x_start, y_start, x_step, y_step in _PNG_ADAM7_PASSES:
        pass_width = 0 if width <= x_start else (width - x_start + x_step - 1) // x_step
        pass_height = 0 if height <= y_start else (height - y_start + y_step - 1) // y_step
        if pass_width:
            row_bytes = (pass_width * channels * bit_depth + 7) // 8
            for _ in range(pass_height):
                yield row_bytes


def image_dimensions(data: bytes, image_format: str) -> tuple[int, int]:
    """Return the pixel dimensions of an already structurally validated image."""
    if image_format == "png":
        if len(data) < 24 or not data.startswith(PNG_SIGNATURE) or data[12:16] != b"IHDR":
            raise ValueError("PNG dimensions are unavailable")
        width = int.from_bytes(data[16:20], "big")
        height = int.from_bytes(data[20:24], "big")
        if width < 1 or height < 1:
            raise ValueError("PNG dimensions are unavailable")
        return width, height
    if image_format == "jpeg":
        return _jpeg_dimensions(data)
    if image_format == "webp":
        return _webp_dimensions(data)
    raise ValueError(f"unsupported image format for dimensions: {image_format}")


def _jpeg_dimensions(data: bytes) -> tuple[int, int]:
    sof_markers = {
        0xC0,
        0xC1,
        0xC2,
        0xC3,
        0xC5,
        0xC6,
        0xC7,
        0xC9,
        0xCA,
        0xCB,
        0xCD,
        0xCE,
        0xCF,
    }
    position = 2
    while position < len(data):
        if data[position] != 0xFF:
            raise ValueError("JPEG dimensions are unavailable")
        while position < len(data) and data[position] == 0xFF:
            position += 1
        if position >= len(data):
            break
        marker = data[position]
        position += 1
        if marker in {0xD8, 0xD9}:
            continue
        if marker == 0xDA:
            break
        if marker == 0x00 or 0xD0 <= marker <= 0xD7:
            continue
        if position + 2 > len(data):
            break
        segment_length = int.from_bytes(data[position : position + 2], "big")
        if segment_length < 2 or position + segment_length > len(data):
            break
        segment = data[position + 2 : position + segment_length]
        if marker in sof_markers and len(segment) >= 5:
            height = int.from_bytes(segment[1:3], "big")
            width = int.from_bytes(segment[3:5], "big")
            if width > 0 and height > 0:
                return width, height
        position += segment_length
    raise ValueError("JPEG dimensions are unavailable")


def _webp_dimensions(data: bytes) -> tuple[int, int]:
    position = 12
    while position + 8 <= len(data):
        kind = data[position : position + 4]
        length = int.from_bytes(data[position + 4 : position + 8], "little")
        chunk_end = position + 8 + length
        if chunk_end > len(data):
            break
        payload = data[position + 8 : chunk_end]
        if kind == b"VP8X" and len(payload) >= 10:
            width = int.from_bytes(payload[4:7] + b"\x00", "little") + 1
            height = int.from_bytes(payload[7:10] + b"\x00", "little") + 1
            return width, height
        if kind == b"VP8 " and len(payload) >= 10:
            width = int.from_bytes(payload[6:8], "little") & 0x3FFF
            height = int.from_bytes(payload[8:10], "little") & 0x3FFF
            if width > 0 and height > 0:
                return width, height
        if kind == b"VP8L" and len(payload) >= 5 and payload[0] == 0x2F:
            header = int.from_bytes(payload[1:5], "little")
            width = (header & 0x3FFF) + 1
            height = ((header >> 14) & 0x3FFF) + 1
            return width, height
        if kind == b"ANMF" and len(payload) >= 12:
            width = int.from_bytes(payload[6:9] + b"\x00", "little") + 1
            height = int.from_bytes(payload[9:12] + b"\x00", "little") + 1
            return width, height
        position = chunk_end + (length % 2)
    raise ValueError("WebP dimensions are unavailable")


def _is_valid_jpeg(data: bytes) -> bool:
    if len(data) < 8 or not data.startswith(b"\xff\xd8") or not data.endswith(b"\xff\xd9"):
        return False
    position = 2
    saw_sof = False
    saw_sos = False
    saw_scan_data = False
    frame_components = 0
    frame_marker: int | None = None
    frame_component_ids: set[int] = set()
    scanned_component_ids: set[int] = set()
    referenced_quantization_tables: set[int] = set()
    defined_quantization_tables: set[int] = set()
    defined_dc_huffman_tables: set[int] = set()
    defined_ac_huffman_tables: set[int] = set()
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
                and frame_component_ids.issubset(scanned_component_ids)
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
        if marker == 0xC4:
            if not _parse_jpeg_huffman_tables(
                segment,
                defined_dc_huffman_tables,
                defined_ac_huffman_tables,
            ):
                return False
        if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
            if saw_sof:
                return False
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
            frame_marker = marker
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
            if frame_marker is None or not _jpeg_scan_tables_are_defined(
                segment,
                frame_marker,
                defined_dc_huffman_tables,
                defined_ac_huffman_tables,
            ):
                return False
            scanned_component_ids.update(scan_component_ids)
            saw_sos = True
            next_marker, has_scan_data = _consume_jpeg_scan(data, segment_end)
            if next_marker is None or not has_scan_data:
                return False
            saw_scan_data = True
            position = next_marker
            continue
        position = segment_end
    return False


def _jpeg_scan_tables_are_defined(
    segment: bytes,
    frame_marker: int,
    defined_dc: set[int],
    defined_ac: set[int],
) -> bool:
    scan_components = segment[0]
    spectral_start = segment[-3]
    spectral_end = segment[-2]
    approximation = segment[-1]
    successive_high = approximation >> 4
    successive_low = approximation & 0x0F
    huffman_lossless = frame_marker in {0xC3, 0xC7}
    huffman_progressive = frame_marker in {0xC2, 0xC6}
    huffman_sequential = frame_marker in {0xC0, 0xC1, 0xC5}
    arithmetic = frame_marker in {0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    if arithmetic:
        return True
    if huffman_lossless:
        if spectral_start < 1 or spectral_start > 7 or spectral_end != 0 or successive_high != 0:
            return False
        need_dc = True
        need_ac = False
    elif huffman_progressive:
        if spectral_start > spectral_end or spectral_end > 63 or successive_high > 13 or successive_low > 13:
            return False
        if spectral_start == 0:
            if spectral_end != 0:
                return False
            need_dc = True
            need_ac = False
        else:
            if scan_components != 1:
                return False
            need_dc = False
            need_ac = True
    elif huffman_sequential:
        if spectral_start != 0 or spectral_end != 63 or approximation != 0:
            return False
        need_dc = True
        need_ac = True
    else:
        return False
    for offset in range(2, 1 + 2 * scan_components, 2):
        table_selectors = segment[offset]
        dc_table = table_selectors >> 4
        ac_table = table_selectors & 0x0F
        if dc_table > 3 or ac_table > 3:
            return False
        if need_dc and dc_table not in defined_dc:
            return False
        if need_ac and ac_table not in defined_ac:
            return False
    return True


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


def _parse_jpeg_huffman_tables(
    segment: bytes,
    defined_dc: set[int],
    defined_ac: set[int],
) -> bool:
    if not segment:
        return False
    offset = 0
    while offset < len(segment):
        if offset + 17 > len(segment):
            return False
        table_info = segment[offset]
        table_class = table_info >> 4
        table_id = table_info & 0x0F
        if table_class not in {0, 1} or table_id > 3:
            return False
        counts = segment[offset + 1 : offset + 17]
        symbol_count = sum(counts)
        if symbol_count < 1 or symbol_count > 256 or offset + 17 + symbol_count > len(segment):
            return False
        available_codes = 1
        for count in counts:
            available_codes = available_codes * 2 - count
            if available_codes < 0:
                return False
        (defined_dc if table_class == 0 else defined_ac).add(table_id)
        offset += 17 + symbol_count
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
    try:
        validate_vp8l_payload(payload)
    except WebPResourceLimitError as exc:
        raise ImageValidationResourceError(str(exc)) from exc
    except WebPDecodeError:
        return False
    return True


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
