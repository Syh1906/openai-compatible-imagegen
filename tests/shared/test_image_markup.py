import struct
import unittest
import zlib

from scripts.image_markup import validate_markup
from tests.support.python_fixtures import make_png


def annotation_png(color, depth, *, transparent, interlace):
    width = height = 8
    maximum = (1 << depth) - 1
    passes = [(0, 0, 1, 1)] if not interlace else [
        (0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4),
        (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2),
    ]
    raw = bytearray()
    for sx, sy, dx, dy in passes:
        for y in range(sy, height, dy):
            samples = []
            for x in range(sx, width, dx):
                clear = transparent and x == 7 and y == 7
                alpha = maximum - 1 if clear else maximum
                samples.extend({
                    0: (0 if clear else maximum,),
                    2: (0 if clear else maximum, 0, 0),
                    3: (1 if clear else 0,),
                    4: (maximum, alpha),
                    6: (maximum, 0, 0, alpha),
                }[color])
            if not samples:
                continue
            raw.append(0)
            if depth == 16:
                raw.extend(b''.join(struct.pack('>H', value) for value in samples))
            elif depth == 8:
                raw.extend(samples)
            else:
                for start in range(0, len(samples), 8 // depth):
                    raw.append(sum(value << (8 - depth * (i + 1)) for i, value in enumerate(samples[start:start + 8 // depth])))

    def chunk(kind, value):
        return struct.pack('>I', len(value)) + kind + value + struct.pack('>I', zlib.crc32(kind + value))
    extra = {
        0: chunk(b'tRNS', b'\0\0'),
        2: chunk(b'tRNS', b'\0' * 6),
        3: chunk(b'PLTE', b'\xff\0\0\0\0\xff') + chunk(b'tRNS', b'\xff\0'),
        4: b'', 6: b'',
    }[color]
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, depth, color, 0, 0, interlace))
            + extra + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


class MarkupPngTests(unittest.TestCase):
    def test_standard_png_encodings_require_an_actual_transparent_pixel(self):
        parent = make_png(8, 8)
        for color, depths in ((0, (1, 2, 4, 8, 16)), (2, (8, 16)), (3, (1, 2, 4, 8)), (4, (8, 16)), (6, (8, 16))):
            for depth in depths:
                for interlace in (0, 1):
                    with self.subTest(color=color, depth=depth, interlace=interlace):
                        validate_markup(annotation_png(color, depth, transparent=True, interlace=interlace), parent)
                        with self.assertRaisesRegex(ValueError, 'transparent pixels'):
                            validate_markup(annotation_png(color, depth, transparent=False, interlace=interlace), parent)
