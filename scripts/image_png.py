"""Minimal RGB/RGBA PNG codec and pixel helpers."""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any
import zlib


Pixel = tuple[int, int, int, int]
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_PNG_PIXELS = 25_000_000
MAX_PNG_FILE_BYTES = 256 * 1024 * 1024
MAX_PNG_IDAT_CHUNKS = 4096


class PixelBuffer(Sequence[Pixel]):
    """Compact immutable RGBA pixels with tuple-style indexed access."""

    def __init__(self, data: bytes | bytearray) -> None:
        if len(data) % 4:
            raise ValueError("RGBA byte length must be divisible by four")
        self._data = bytes(data)

    def __len__(self) -> int:
        return len(self._data) // 4

    def __getitem__(self, index: int | slice) -> Pixel | list[Pixel]:
        if isinstance(index, slice):
            return [self[item] for item in range(*index.indices(len(self)))]
        if index < 0:
            index += len(self)
        if index < 0 or index >= len(self):
            raise IndexError(index)
        offset = index * 4
        red, green, blue, alpha = self._data[offset : offset + 4]
        return red, green, blue, alpha

    def __iter__(self) -> Iterator[Pixel]:
        for offset in range(0, len(self._data), 4):
            red, green, blue, alpha = self._data[offset : offset + 4]
            yield red, green, blue, alpha

    def packed(self) -> bytes:
        return self._data


def read_png_rgba(path: Path) -> dict[str, Any]:
    if path.stat().st_size > MAX_PNG_FILE_BYTES:
        raise ValueError("PNG file is too large for local processing")
    return read_png_rgba_bytes(path.read_bytes())


def read_png_rgba_bytes(data: bytes) -> dict[str, Any]:
    if len(data) > MAX_PNG_FILE_BYTES:
        raise ValueError("PNG file is too large for local processing")
    if len(data) < len(PNG_SIGNATURE) or not data.startswith(PNG_SIGNATURE):
        raise ValueError("only PNG post-processing is currently supported")

    offset = len(PNG_SIGNATURE)
    width = height = None
    bit_depth = color_type = None
    idat_chunks: list[bytes] = []
    saw_ihdr = False
    saw_idat = False
    saw_iend = False
    saw_trns = False
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError("invalid PNG chunk header")
        length = int.from_bytes(data[offset : offset + 4], "big")
        kind = data[offset + 4 : offset + 8]
        chunk_end = offset + 12 + length
        if chunk_end > len(data):
            raise ValueError("invalid PNG chunk length")
        chunk_data = data[offset + 8 : offset + 8 + length]
        expected_crc = int.from_bytes(data[offset + 8 + length : chunk_end], "big")
        actual_crc = zlib.crc32(kind + chunk_data) & 0xFFFFFFFF
        if actual_crc != expected_crc:
            raise ValueError(f"invalid PNG CRC for {kind.decode('ascii', errors='replace')}")
        offset = chunk_end
        if not saw_ihdr and kind != b"IHDR":
            raise ValueError("invalid PNG IHDR placement")
        if kind == b"IHDR":
            if saw_ihdr or length != 13:
                raise ValueError("invalid PNG IHDR")
            width = int.from_bytes(chunk_data[0:4], "big")
            height = int.from_bytes(chunk_data[4:8], "big")
            bit_depth = chunk_data[8]
            color_type = chunk_data[9]
            compression = chunk_data[10]
            filter_method = chunk_data[11]
            interlace = chunk_data[12]
            if width < 1 or height < 1 or width * height > MAX_PNG_PIXELS:
                raise ValueError("PNG dimensions are not supported")
            if compression != 0 or filter_method != 0 or interlace != 0:
                raise ValueError("only non-interlaced PNG files are supported")
            saw_ihdr = True
        elif kind == b"IDAT":
            if not saw_ihdr or saw_iend:
                raise ValueError("invalid PNG IDAT placement")
            if len(idat_chunks) >= MAX_PNG_IDAT_CHUNKS:
                raise ValueError("PNG contains too many IDAT chunks")
            idat_chunks.append(chunk_data)
            saw_idat = True
        elif kind == b"tRNS":
            if not saw_ihdr or saw_idat or saw_iend:
                raise ValueError("invalid PNG tRNS placement")
            saw_trns = True
        elif kind == b"IEND":
            if length != 0 or not saw_ihdr or not saw_idat:
                raise ValueError("invalid PNG IEND")
            saw_iend = True
            break

    if (
        not saw_ihdr
        or not saw_idat
        or not saw_iend
        or offset != len(data)
        or width is None
        or height is None
        or bit_depth is None
        or color_type is None
    ):
        raise ValueError("invalid PNG: missing or trailing required data")
    if bit_depth not in {8, 16} or color_type not in {2, 6}:
        raise ValueError("only 8-bit or 16-bit RGB/RGBA PNG post-processing is currently supported")
    if color_type == 2 and saw_trns:
        raise ValueError("RGB PNG with tRNS transparency is not supported")

    channels = 4 if color_type == 6 else 3
    bytes_per_sample = bit_depth // 8
    bytes_per_pixel = channels * bytes_per_sample
    stride = width * bytes_per_pixel
    expected_length = height * (stride + 1)
    try:
        decompressor = zlib.decompressobj()
        raw = decompressor.decompress(b"".join(idat_chunks), expected_length + 1)
    except zlib.error as exc:
        raise ValueError("invalid PNG image data") from exc
    if (
        len(raw) != expected_length
        or not decompressor.eof
        or decompressor.unconsumed_tail
        or decompressor.unused_data
    ):
        raise ValueError("invalid PNG image data length")
    packed = bytearray()
    previous = bytes(stride)
    pos = 0
    for _ in range(height):
        filter_type = raw[pos]
        pos += 1
        scanline = raw[pos : pos + stride]
        pos += stride
        row = _unfilter_scanline(filter_type, scanline, previous, bytes_per_pixel)
        if bit_depth == 16:
            for offset in range(0, len(row), bytes_per_pixel):
                alpha = row[offset + 6] if channels == 4 else 255
                packed.extend((row[offset], row[offset + 2], row[offset + 4], alpha))
        elif channels == 4:
            packed.extend(row)
        else:
            for offset in range(0, len(row), 3):
                packed.extend((row[offset], row[offset + 1], row[offset + 2], 255))
        previous = row
    return {"width": width, "height": height, "pixels": PixelBuffer(packed)}


def write_png_rgba(path: Path, width: int, height: int, pixels: Sequence[Pixel]) -> None:
    if width < 1 or height < 1 or width * height > MAX_PNG_PIXELS:
        raise ValueError("PNG dimensions are not supported")
    if len(pixels) != width * height:
        raise ValueError("pixel count does not match image dimensions")
    raw = bytearray()
    packed = pixels.packed() if isinstance(pixels, PixelBuffer) else None
    for y in range(height):
        raw.append(0)
        if packed is not None:
            row_start = y * width * 4
            raw.extend(packed[row_start : row_start + width * 4])
        else:
            for x in range(width):
                raw.extend(pixels[y * width + x])
    chunks = [
        _png_chunk(b"IHDR", width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00"),
        _png_chunk(b"IDAT", zlib.compress(bytes(raw))),
        _png_chunk(b"IEND", b""),
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(PNG_SIGNATURE + b"".join(chunks))


def alpha_bbox(pixels: Sequence[Pixel], width: int, height: int) -> tuple[int, int, int, int] | None:
    min_x = width
    min_y = height
    max_x = -1
    max_y = -1
    for y in range(height):
        for x in range(width):
            if pixels[y * width + x][3] > 0:
                min_x = min(min_x, x)
                min_y = min(min_y, y)
                max_x = max(max_x, x)
                max_y = max(max_y, y)
    if max_x < 0:
        return None
    return min_x, min_y, max_x, max_y


def crop_pixels(
    pixels: Sequence[Pixel],
    source_w: int,
    source_h: int,
    left: int,
    top: int,
    width: int,
    height: int,
) -> list[Pixel]:
    if left < 0 or top < 0 or width < 1 or height < 1 or left + width > source_w or top + height > source_h:
        raise ValueError("crop is outside image bounds")
    return [pixels[(top + y) * source_w + left + x] for y in range(height) for x in range(width)]


def grid_edges(length: int, parts: int) -> list[int]:
    if parts < 1 or length < parts:
        raise ValueError("grid parts must fit inside the image dimensions")
    return [round(index * length / parts) for index in range(parts + 1)]


def _unfilter_scanline(filter_type: int, scanline: bytes, previous: bytes, bpp: int) -> bytes:
    row = bytearray(scanline)
    for index in range(len(row)):
        left = row[index - bpp] if index >= bpp else 0
        up = previous[index] if previous else 0
        up_left = previous[index - bpp] if previous and index >= bpp else 0
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
            raise ValueError(f"unsupported PNG filter type: {filter_type}")
    return bytes(row)


def _paeth_predictor(left: int, up: int, up_left: int) -> int:
    p = left + up - up_left
    distances = (abs(p - left), abs(p - up), abs(p - up_left))
    if distances[0] <= distances[1] and distances[0] <= distances[2]:
        return left
    if distances[1] <= distances[2]:
        return up
    return up_left


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(kind + data) & 0xFFFFFFFF
    return len(data).to_bytes(4, "big") + kind + data + crc.to_bytes(4, "big")
