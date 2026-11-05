"""Validate transparent annotation uploads without changing the original image."""

import zlib

from scripts.image_png import _unfilter_scanline
from scripts.image_response import inspect_response_image


def validate_markup(markup: bytes, parent: bytes) -> None:
    if len(markup) > 50 * 1024 * 1024:
        raise ValueError("markup exceeds the 50 MB limit")
    original = inspect_response_image(parent)
    overlay = inspect_response_image(markup)
    if original.image_format not in {"png", "jpeg", "webp"} or overlay.image_format != "png":
        raise ValueError("markup requires a PNG layer and a PNG, JPEG or WebP parent")
    if original.width * original.height > 16_777_216:
        raise ValueError("markup parent exceeds the pixel limit")
    if (original.width, original.height) != (overlay.width, overlay.height):
        raise ValueError("markup dimensions must match the first input image")
    if not _has_transparent_pixel(markup, overlay.width, overlay.height):
        raise ValueError("markup must contain transparent pixels")


def _has_transparent_pixel(data: bytes, width: int, height: int) -> bool:
    """Inspect alpha in an already validated PNG, without converting its bytes."""
    depth, color, interlace = data[24], data[25], data[28]
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    transparency = b""
    compressed = []
    offset = 8
    while offset < len(data):
        size = int.from_bytes(data[offset:offset + 4], "big")
        kind = data[offset + 4:offset + 8]
        chunk = data[offset + 8:offset + 8 + size]
        if kind == b"IDAT":
            compressed.append(chunk)
        elif kind == b"tRNS":
            transparency = chunk
        offset += size + 12
    if color not in {4, 6} and not transparency:
        return False
    passes = [(0, 0, 1, 1)] if not interlace else [
        (0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4),
        (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2),
    ]
    dimensions = [(max(0, (width - sx + dx - 1) // dx), max(0, (height - sy + dy - 1) // dy))
                  for sx, sy, dx, dy in passes]
    # The validated 16,777,216-pixel cap bounds all PNG encodings to roughly 128 MiB.
    expected = sum(((pw * channels * depth + 7) // 8 + 1) * ph for pw, ph in dimensions if pw)
    decoder = zlib.decompressobj()
    raw = decoder.decompress(b"".join(compressed), expected + 1)
    if len(raw) != expected or not decoder.eof or decoder.unused_data:
        raise ValueError("invalid markup PNG scanlines")
    position = 0
    bpp = max(1, (channels * depth + 7) // 8)
    for pw, ph in dimensions:
        if not pw:
            continue
        row_size = (pw * channels * depth + 7) // 8
        previous = bytes(row_size)
        for _ in range(ph):
            row = _unfilter_scanline(raw[position], raw[position + 1:position + 1 + row_size], previous, bpp)
            position += row_size + 1
            if _row_has_transparency(row, pw, depth, color, channels, transparency):
                return True
            previous = row
    return False


def _row_has_transparency(row, width, depth, color, channels, transparency):
    if color in {4, 6}:
        sample_bytes = depth // 8
        stride = channels * sample_bytes
        alpha = (channels - 1) * sample_bytes
        return any(value != 255 for byte in range(sample_bytes) for value in row[alpha + byte::stride])

    def samples():
        for index in range(width * channels):
            if depth < 8:
                bit = index * depth
                yield (row[bit // 8] >> (8 - depth - bit % 8)) & ((1 << depth) - 1)
            elif depth == 8:
                yield row[index]
            else:
                yield int.from_bytes(row[index * 2:index * 2 + 2], "big")

    values = samples()
    if color == 3:
        return any(index < len(transparency) and transparency[index] < 255 for index in values)
    key = tuple(int.from_bytes(transparency[i:i + 2], "big") for i in range(0, len(transparency), 2))
    return any(tuple(next(values) for _ in range(channels)) == key for _ in range(width))


def validate_markup_uploads(files) -> None:
    parents = [upload for upload in files if upload[0] in {"image", "image[]"}]
    overlays = [upload for upload in files if upload[0] == "markup"]
    if not parents or len(overlays) != 1:
        raise ValueError("markup requires one annotation layer and a first input image")
    def snapshot(upload):
        return upload[2] if len(upload) == 3 else upload[1].read_bytes()
    validate_markup(snapshot(overlays[0]), snapshot(parents[0]))
