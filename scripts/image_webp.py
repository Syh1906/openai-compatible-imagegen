"""Bounded structural validation for WebP lossless image streams."""

from __future__ import annotations

from dataclasses import dataclass


MAX_WEBP_VALIDATION_PIXELS = 25_000_000
MAX_WEBP_METADATA_PIXELS = 4_000_000
MAX_WEBP_PREFIX_GROUPS = 4096


class WebPDecodeError(ValueError):
    pass


class WebPResourceLimitError(WebPDecodeError):
    pass


def validate_vp8l_payload(payload: bytes) -> tuple[int, int]:
    """Validate a complete VP8L payload without retaining the main pixel image."""
    if len(payload) < 6 or payload[0] != 0x2F:
        raise WebPDecodeError("invalid WebP lossless header")
    header = int.from_bytes(payload[1:5], "little")
    if (header >> 29) & 0x07:
        raise WebPDecodeError("unsupported WebP lossless version")
    width = (header & 0x3FFF) + 1
    height = ((header >> 14) & 0x3FFF) + 1
    reader = _BitReader(payload[5:])
    coded_width = width
    seen_transforms: set[int] = set()
    while reader.read_bits(1):
        transform_type = reader.read_bits(2)
        if transform_type in seen_transforms:
            raise WebPDecodeError("duplicate WebP lossless transform")
        seen_transforms.add(transform_type)
        if transform_type in {0, 1}:
            size_bits = reader.read_bits(3) + 2
            transform_width = _round_up_div(coded_width, 1 << size_bits)
            transform_height = _round_up_div(height, 1 << size_bits)
            _decode_image(reader, transform_width, transform_height, allow_meta=False, store=False)
        elif transform_type == 2:
            continue
        else:
            color_table_size = reader.read_bits(8) + 1
            _decode_image(reader, color_table_size, 1, allow_meta=False, store=False)
            width_bits = 3 if color_table_size <= 2 else 2 if color_table_size <= 4 else 1 if color_table_size <= 16 else 0
            coded_width = _round_up_div(coded_width, 1 << width_bits)

    _decode_image(reader, coded_width, height, allow_meta=True, store=False)
    if reader.remaining_bits >= 8 or reader.has_nonzero_remaining_bits():
        raise WebPDecodeError("WebP lossless stream has trailing data")
    return width, height


def _decode_image(
    reader: "_BitReader",
    width: int,
    height: int,
    *,
    allow_meta: bool,
    store: bool,
) -> list[int] | None:
    total = width * height
    limit = MAX_WEBP_METADATA_PIXELS if store else MAX_WEBP_VALIDATION_PIXELS
    if total < 1 or total > limit:
        raise WebPResourceLimitError(
            f"WebP lossless validation requires {total} pixels, above the {limit}-pixel resource limit"
        )

    color_cache_bits = 0
    if reader.read_bits(1):
        color_cache_bits = reader.read_bits(4)
        if not 1 <= color_cache_bits <= 11:
            raise WebPDecodeError("invalid WebP lossless color cache size")
    color_cache_size = 1 << color_cache_bits if color_cache_bits else 0

    prefix_bits: int | None = None
    prefix_width = 0
    prefix_pixels: list[int] | None = None
    prefix_group_count = 1
    if allow_meta and reader.read_bits(1):
        prefix_bits = reader.read_bits(3) + 2
        prefix_width = _round_up_div(width, 1 << prefix_bits)
        prefix_height = _round_up_div(height, 1 << prefix_bits)
        prefix_pixels = _decode_image(
            reader,
            prefix_width,
            prefix_height,
            allow_meta=False,
            store=True,
        )
        assert prefix_pixels is not None
        prefix_group_count = max(((pixel >> 8) & 0xFFFF) for pixel in prefix_pixels) + 1
        if prefix_group_count > MAX_WEBP_PREFIX_GROUPS:
            raise WebPResourceLimitError(
                f"WebP lossless stream requires {prefix_group_count} prefix groups, above the "
                f"{MAX_WEBP_PREFIX_GROUPS}-group resource limit"
            )

    groups = [
        (
            _read_prefix_code(reader, 256 + 24 + color_cache_size),
            _read_prefix_code(reader, 256),
            _read_prefix_code(reader, 256),
            _read_prefix_code(reader, 256),
            _read_prefix_code(reader, 40),
        )
        for _ in range(prefix_group_count)
    ]

    pixels: list[int] | None = [] if store else None
    cache = [0] * color_cache_size if store and color_cache_size else None
    produced = 0

    def append_color(color: int) -> None:
        nonlocal produced
        if pixels is not None:
            pixels.append(color)
            if cache is not None:
                index = ((0x1E35A7BD * color) & 0xFFFFFFFF) >> (32 - color_cache_bits)
                cache[index] = color
        produced += 1

    while produced < total:
        group_index = 0
        if prefix_bits is not None and prefix_pixels is not None:
            x = produced % width
            y = produced // width
            prefix_position = (y >> prefix_bits) * prefix_width + (x >> prefix_bits)
            group_index = (prefix_pixels[prefix_position] >> 8) & 0xFFFF
            if group_index >= len(groups):
                raise WebPDecodeError("invalid WebP lossless prefix group index")
        green_code, red_code, blue_code, alpha_code, distance_code = groups[group_index]
        symbol = green_code.decode(reader)
        if symbol < 256:
            red = red_code.decode(reader)
            blue = blue_code.decode(reader)
            alpha = alpha_code.decode(reader)
            append_color((alpha << 24) | (red << 16) | (symbol << 8) | blue)
            continue
        if symbol < 280:
            length = _read_lz77_value(reader, symbol - 256)
            distance_symbol = distance_code.decode(reader)
            distance_value = _read_lz77_value(reader, distance_symbol)
            distance = _map_distance(distance_value, width)
            if distance < 1 or distance > produced:
                raise WebPDecodeError("invalid WebP lossless backward-reference distance")
            if length > total - produced:
                raise WebPDecodeError("WebP lossless backward reference exceeds image bounds")
            if pixels is None:
                produced += length
            else:
                for _ in range(length):
                    append_color(pixels[len(pixels) - distance])
            continue
        cache_index = symbol - 280
        if cache_index >= color_cache_size:
            raise WebPDecodeError("invalid WebP lossless color cache index")
        append_color(cache[cache_index] if cache is not None else 0)
    return pixels


def _read_prefix_code(reader: "_BitReader", alphabet_size: int) -> "_PrefixCode":
    lengths = [0] * alphabet_size
    if reader.read_bits(1):
        symbol_count = reader.read_bits(1) + 1
        first_is_8_bits = reader.read_bits(1)
        first_symbol = reader.read_bits(1 + 7 * first_is_8_bits)
        if first_symbol >= alphabet_size:
            raise WebPDecodeError("WebP lossless prefix symbol exceeds its alphabet")
        lengths[first_symbol] = 1
        if symbol_count == 2:
            second_symbol = reader.read_bits(8)
            if second_symbol >= alphabet_size:
                raise WebPDecodeError("WebP lossless prefix symbol exceeds its alphabet")
            lengths[second_symbol] = 1
        return _PrefixCode.from_lengths(lengths)

    order = (17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15)
    code_length_lengths = [0] * 19
    for index in range(reader.read_bits(4) + 4):
        code_length_lengths[order[index]] = reader.read_bits(3)
    code_length_code = _PrefixCode.from_lengths(code_length_lengths)
    if reader.read_bits(1):
        length_nbits = 2 + 2 * reader.read_bits(3)
        remaining_codes = 2 + reader.read_bits(length_nbits)
        if remaining_codes > alphabet_size:
            raise WebPDecodeError("WebP lossless prefix length count exceeds its alphabet")
    else:
        remaining_codes = alphabet_size

    index = 0
    previous_nonzero = 8
    while index < alphabet_size and remaining_codes:
        remaining_codes -= 1
        code = code_length_code.decode(reader)
        if code <= 15:
            lengths[index] = code
            if code:
                previous_nonzero = code
            index += 1
            continue
        if code == 16:
            repeat = 3 + reader.read_bits(2)
            value = previous_nonzero
        elif code == 17:
            repeat = 3 + reader.read_bits(3)
            value = 0
        elif code == 18:
            repeat = 11 + reader.read_bits(7)
            value = 0
        else:
            raise WebPDecodeError("invalid WebP lossless code-length symbol")
        if index + repeat > alphabet_size:
            raise WebPDecodeError("WebP lossless code-length repeat exceeds its alphabet")
        for target in range(index, index + repeat):
            lengths[target] = value
        index += repeat
    return _PrefixCode.from_lengths(lengths)


@dataclass(frozen=True)
class _PrefixCode:
    table: dict[tuple[int, int], int]
    max_bits: int
    single_symbol: int | None = None

    @classmethod
    def from_lengths(cls, lengths: list[int]) -> "_PrefixCode":
        symbols = [(symbol, length) for symbol, length in enumerate(lengths) if length]
        if not symbols:
            raise WebPDecodeError("empty WebP lossless prefix code")
        if any(length < 1 or length > 15 for _, length in symbols):
            raise WebPDecodeError("invalid WebP lossless prefix code length")
        if len(symbols) == 1:
            symbol, length = symbols[0]
            if length != 1:
                raise WebPDecodeError("invalid single-symbol WebP lossless prefix code")
            return cls({}, 0, symbol)

        max_bits = max(length for _, length in symbols)
        counts = [0] * (max_bits + 1)
        for _, length in symbols:
            counts[length] += 1
        remaining = 1
        for bit_count in range(1, max_bits + 1):
            remaining = (remaining << 1) - counts[bit_count]
            if remaining < 0:
                raise WebPDecodeError("oversubscribed WebP lossless prefix code")
        if remaining:
            raise WebPDecodeError("incomplete WebP lossless prefix code")

        next_code = [0] * (max_bits + 1)
        code = 0
        for bit_count in range(1, max_bits + 1):
            code = (code + counts[bit_count - 1]) << 1
            next_code[bit_count] = code
        table: dict[tuple[int, int], int] = {}
        for symbol, bit_count in symbols:
            canonical = next_code[bit_count]
            next_code[bit_count] += 1
            table[(bit_count, _reverse_bits(canonical, bit_count))] = symbol
        return cls(table, max_bits)

    def decode(self, reader: "_BitReader") -> int:
        if self.single_symbol is not None:
            return self.single_symbol
        value = 0
        for bit_count in range(1, self.max_bits + 1):
            value |= reader.read_bits(1) << (bit_count - 1)
            symbol = self.table.get((bit_count, value))
            if symbol is not None:
                return symbol
        raise WebPDecodeError("invalid WebP lossless prefix code")


class _BitReader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.bit_position = 0

    @property
    def remaining_bits(self) -> int:
        return len(self.data) * 8 - self.bit_position

    def read_bits(self, count: int) -> int:
        if count < 0 or count > 24 or self.remaining_bits < count:
            raise WebPDecodeError("incomplete WebP lossless bitstream")
        value = 0
        for index in range(count):
            byte = self.data[self.bit_position // 8]
            value |= ((byte >> (self.bit_position % 8)) & 1) << index
            self.bit_position += 1
        return value

    def has_nonzero_remaining_bits(self) -> bool:
        for bit_position in range(self.bit_position, len(self.data) * 8):
            if (self.data[bit_position // 8] >> (bit_position % 8)) & 1:
                return True
        return False


def _read_lz77_value(reader: _BitReader, prefix_code: int) -> int:
    if prefix_code < 0 or prefix_code > 39:
        raise WebPDecodeError("invalid WebP lossless LZ77 prefix")
    if prefix_code < 4:
        return prefix_code + 1
    extra_bits = (prefix_code - 2) >> 1
    offset = (2 + (prefix_code & 1)) << extra_bits
    return offset + reader.read_bits(extra_bits) + 1


_DISTANCE_MAP = (
    (0, 1), (1, 0), (1, 1), (-1, 1), (0, 2), (2, 0), (1, 2), (-1, 2),
    (2, 1), (-2, 1), (2, 2), (-2, 2), (0, 3), (3, 0), (1, 3), (-1, 3),
    (3, 1), (-3, 1), (2, 3), (-2, 3), (3, 2), (-3, 2), (0, 4), (4, 0),
    (1, 4), (-1, 4), (4, 1), (-4, 1), (3, 3), (-3, 3), (2, 4), (-2, 4),
    (4, 2), (-4, 2), (0, 5), (3, 4), (-3, 4), (4, 3), (-4, 3), (5, 0),
    (1, 5), (-1, 5), (5, 1), (-5, 1), (2, 5), (-2, 5), (5, 2), (-5, 2),
    (4, 4), (-4, 4), (3, 5), (-3, 5), (5, 3), (-5, 3), (0, 6), (6, 0),
    (1, 6), (-1, 6), (6, 1), (-6, 1), (2, 6), (-2, 6), (6, 2), (-6, 2),
    (4, 5), (-4, 5), (5, 4), (-5, 4), (3, 6), (-3, 6), (6, 3), (-6, 3),
    (0, 7), (7, 0), (1, 7), (-1, 7), (5, 5), (-5, 5), (7, 1), (-7, 1),
    (4, 6), (-4, 6), (6, 4), (-6, 4), (2, 7), (-2, 7), (7, 2), (-7, 2),
    (3, 7), (-3, 7), (7, 3), (-7, 3), (5, 6), (-5, 6), (6, 5), (-6, 5),
    (8, 0), (4, 7), (-4, 7), (7, 4), (-7, 4), (8, 1), (8, 2), (6, 6),
    (-6, 6), (8, 3), (5, 7), (-5, 7), (7, 5), (-7, 5), (8, 4), (6, 7),
    (-6, 7), (7, 6), (-7, 6), (8, 5), (7, 7), (-7, 7), (8, 6), (8, 7),
)


def _map_distance(distance_code: int, width: int) -> int:
    if distance_code > 120:
        return distance_code - 120
    if distance_code < 1:
        raise WebPDecodeError("invalid WebP lossless distance code")
    x_offset, y_offset = _DISTANCE_MAP[distance_code - 1]
    return max(1, x_offset + y_offset * width)


def _round_up_div(value: int, divisor: int) -> int:
    return (value + divisor - 1) // divisor


def _reverse_bits(value: int, count: int) -> int:
    reversed_value = 0
    for _ in range(count):
        reversed_value = (reversed_value << 1) | (value & 1)
        value >>= 1
    return reversed_value
