"""Bounded validation of animated GIF and static, self-contained SVG originals."""

import math
import re
import xml.etree.ElementTree as ET


def gif_dimensions(data):
    if data[:6] not in (b'GIF87a', b'GIF89a') or len(data) < 14:
        raise ValueError('invalid GIF header')
    width, height = int.from_bytes(data[6:8], 'little'), int.from_bytes(data[8:10], 'little')
    if not width or not height or width * height > 100_000_000:
        raise ValueError('invalid GIF dimensions')
    position = 13
    if data[10] & 128:
        position += 3 * (2 ** ((data[10] & 7) + 1))
    frames = pixels = 0

    def blocks(offset):
        chunks = []
        while offset < len(data):
            size = data[offset]
            offset += 1
            if not size:
                return b''.join(chunks), offset
            if offset + size > len(data):
                break
            chunks.append(data[offset:offset + size])
            offset += size
        raise ValueError('truncated GIF block')

    while position < len(data):
        marker = data[position]
        position += 1
        if marker == 0x3b:
            if not frames or position != len(data):
                raise ValueError('invalid GIF trailer')
            return width, height
        if marker == 0x21:
            if position >= len(data):
                raise ValueError('truncated GIF extension')
            label = data[position]
            position += 1
            if label not in (0xf9, 0xfe, 0xff):
                raise ValueError('unsupported GIF extension')
            extension, position = blocks(position)
            if label == 0xf9 and len(extension) != 4:
                raise ValueError('invalid GIF control extension')
            continue
        if marker != 0x2c or position + 10 > len(data):
            raise ValueError('invalid GIF frame')
        left, top, fw, fh = [int.from_bytes(data[position + n:position + n + 2], 'little') for n in (0, 2, 4, 6)]
        flags = data[position + 8]
        position += 9
        if not fw or not fh or left + fw > width or top + fh > height:
            raise ValueError('GIF frame exceeds canvas')
        frames += 1
        pixels += fw * fh
        if frames > 64 or pixels > 512_000_000:
            raise ValueError('GIF pixel budget exceeded')
        if flags & 128:
            position += 3 * (2 ** ((flags & 7) + 1))
        if position >= len(data):
            raise ValueError('truncated GIF color table')
        minimum = data[position]
        compressed, position = blocks(position + 1)
        _validate_lzw(compressed, minimum, fw * fh)
    raise ValueError('missing GIF trailer')


def _validate_lzw(data, minimum, expected):
    if not 2 <= minimum <= 8:
        raise ValueError('invalid GIF LZW size')
    clear, end = 1 << minimum, (1 << minimum) + 1
    lengths = {i: 1 for i in range(clear)}
    size, next_code, previous, count, bit = minimum + 1, end + 1, None, 0, 0
    while bit + size <= len(data) * 8:
        start = bit // 8
        code = (int.from_bytes(data[start:start + 3], 'little') >> (bit % 8)) & ((1 << size) - 1)
        bit += size
        if code == clear:
            lengths = {i: 1 for i in range(clear)}
            size, next_code, previous = minimum + 1, end + 1, None
            continue
        if code == end:
            if count != expected:
                raise ValueError('GIF decoded pixel count mismatch')
            return
        length = lengths.get(code)
        if length is None:
            if code != next_code or previous is None:
                raise ValueError('invalid GIF LZW code')
            length = previous + 1
        count += length
        if count > expected:
            raise ValueError('GIF decoded pixel budget exceeded')
        if previous is not None and next_code < 4096:
            lengths[next_code] = previous + 1
            next_code += 1
            if next_code == 1 << size and size < 12:
                size += 1
        previous = length
    raise ValueError('missing GIF LZW end code')


SVG_TAGS = frozenset('svg g defs title desc style path rect circle ellipse line polyline polygon text tspan textPath linearGradient radialGradient stop clipPath mask pattern marker symbol use'.split())


def _validate_svg_value(value):
    if '\\' in value or '@' in value or '/*' in value:
        raise ValueError('escaped or imported SVG resources are unsupported')
    cleaned = re.sub(r'url\(\s*[\x22\x27]?(#[\w.:-]+)[\x22\x27]?\s*\)', '', value, flags=re.I)
    if re.search(r'url\s*\(|://|data:|javascript:', cleaned, re.I):
        raise ValueError('external SVG resources are unsupported')


class _BoundedSVGTreeBuilder(ET.TreeBuilder):
    def __init__(self):
        super().__init__()
        self.element_count = 0

    def start(self, tag, attrs):
        self.element_count += 1
        if self.element_count > 100_000:
            raise ValueError('SVG element budget exceeded')
        return super().start(tag, attrs)


def svg_dimensions(data):
    if len(data) > 16 * 1024 * 1024:
        raise ValueError('SVG byte budget exceeded')
    text = data.decode('utf-8-sig')
    if re.search(r'<!DOCTYPE|<!ENTITY|<\?(?!xml\s)', text, re.I):
        raise ValueError('SVG declarations are unsupported')
    try:
        root = ET.fromstring(text, parser=ET.XMLParser(target=_BoundedSVGTreeBuilder()))
    except ET.ParseError as error:
        raise ValueError('invalid SVG XML') from error
    if root.tag != '{http://www.w3.org/2000/svg}svg':
        raise ValueError('SVG namespace is required')
    for node in root.iter():
        if node.tag.removeprefix('{http://www.w3.org/2000/svg}') not in SVG_TAGS:
            raise ValueError('unsupported SVG element')
        if node.tag == '{http://www.w3.org/2000/svg}style':
            _validate_svg_value(''.join(node.itertext()))
        for name, value in node.attrib.items():
            local = name.rsplit('}', 1)[-1].lower()
            if local.startswith('on') or local == 'base':
                raise ValueError('active SVG attributes are unsupported')
            if local == 'href' and not re.fullmatch(r'#[A-Za-z_][\w.:-]*', value):
                raise ValueError('SVG references must be local')
            _validate_svg_value(value)
    def dimension(value):
        match = re.fullmatch(r'\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*', value or '')
        return float(match[1]) if match else None
    width, height = dimension(root.get('width')), dimension(root.get('height'))
    if width is None or height is None:
        viewbox = [float(part) for part in re.split(r'[\s,]+', root.get('viewBox', '').strip()) if part]
        if len(viewbox) != 4:
            raise ValueError('SVG requires dimensions or viewBox')
        width, height = viewbox[2:]
    if not all(math.isfinite(v) and 0 < v <= 100_000 for v in (width, height)) or width * height > 100_000_000:
        raise ValueError('invalid SVG dimensions')
    return math.ceil(width), math.ceil(height)
