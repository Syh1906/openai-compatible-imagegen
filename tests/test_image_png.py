from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest
import zlib


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from image_png import PNG_SIGNATURE, read_png_rgba  # noqa: E402


def png_chunk(kind: bytes, data: bytes) -> bytes:
    checksum = zlib.crc32(kind + data) & 0xFFFFFFFF
    return len(data).to_bytes(4, "big") + kind + data + checksum.to_bytes(4, "big")


def write_16_bit_png(path: Path, *, width: int, color_type: int, scanline: bytes) -> None:
    ihdr = (
        width.to_bytes(4, "big")
        + (1).to_bytes(4, "big")
        + bytes((16, color_type, 0, 0, 0))
    )
    path.write_bytes(
        PNG_SIGNATURE
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", zlib.compress(scanline))
        + png_chunk(b"IEND", b"")
    )


class ImagePngTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_reader_decodes_16_bit_rgb_for_local_processing(self) -> None:
        path = self.root / "rgb16.png"
        write_16_bit_png(
            path,
            width=2,
            color_type=2,
            scanline=b"\x00\xff\xff\x80\x80\x00\x00\x12\x34\xab\xcd\xff\xff",
        )

        image = read_png_rgba(path)

        self.assertEqual(image["width"], 2)
        self.assertEqual(image["height"], 1)
        self.assertEqual(image["pixels"][0], (255, 128, 0, 255))
        self.assertEqual(image["pixels"][1], (18, 171, 255, 255))

    def test_reader_decodes_16_bit_rgba_alpha_for_local_processing(self) -> None:
        path = self.root / "rgba16.png"
        write_16_bit_png(
            path,
            width=1,
            color_type=6,
            scanline=b"\x00\x12\x34\xab\xcd\xff\xff\x80\x00",
        )

        image = read_png_rgba(path)

        self.assertEqual(image["pixels"][0], (18, 171, 255, 128))

    def test_reader_rejects_excessive_idat_chunk_count(self) -> None:
        path = self.root / "excessive-idat.png"
        ihdr = (
            (1).to_bytes(4, "big")
            + (1).to_bytes(4, "big")
            + b"\x08\x06\x00\x00\x00"
        )
        path.write_bytes(
            PNG_SIGNATURE
            + png_chunk(b"IHDR", ihdr)
            + png_chunk(b"IDAT", b"") * 4097
            + png_chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00\xff"))
            + png_chunk(b"IEND", b"")
        )

        with self.assertRaisesRegex(ValueError, "too many IDAT chunks"):
            read_png_rgba(path)


if __name__ == "__main__":
    unittest.main()
