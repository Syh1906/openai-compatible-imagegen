from __future__ import annotations

import base64
import io
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from image_batch import prepare_batch_targets, write_manifest  # noqa: E402
from image_png import PNG_SIGNATURE, write_png_rgba  # noqa: E402
from image_transaction import OutputTransaction  # noqa: E402


SCRIPT = SCRIPTS / "imagegen.py"


def load_imagegen():
    spec = importlib.util.spec_from_file_location("imagegen_delivery_transactions_under_test", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load imagegen.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def make_chroma_png(path: Path) -> None:
    green = (0, 255, 0, 255)
    red = (220, 30, 40, 255)
    pixels = [green] * 49
    for y in range(2, 5):
        for x in range(2, 5):
            pixels[y * 7 + x] = red
    write_png_rgba(path, 7, 7, pixels)


def png_chunk(kind: bytes, data: bytes) -> bytes:
    import zlib

    checksum = zlib.crc32(kind + data) & 0xFFFFFFFF
    return len(data).to_bytes(4, "big") + kind + data + checksum.to_bytes(4, "big")


def compact_solid_png_bytes(width: int, height: int, color: tuple[int, int, int, int]) -> bytes:
    import zlib

    compressor = zlib.compressobj()
    compressed = bytearray()
    row = b"\x00" + bytes(color) * width
    for _ in range(height):
        compressed.extend(compressor.compress(row))
    compressed.extend(compressor.flush())
    ihdr = width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00"
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", bytes(compressed))
        + png_chunk(b"IEND", b"")
    )


def png_bytes(
    width: int,
    height: int,
    *,
    bit_depth: int,
    color_type: int,
    raw_scanlines: bytes,
    interlace: int = 0,
    palette: bytes | None = None,
    transparency: bytes | None = None,
) -> bytes:
    import zlib

    ihdr = (
        width.to_bytes(4, "big")
        + height.to_bytes(4, "big")
        + bytes((bit_depth, color_type, 0, 0, interlace))
    )
    chunks = [png_chunk(b"IHDR", ihdr)]
    if palette is not None:
        chunks.append(png_chunk(b"PLTE", palette))
    if transparency is not None:
        chunks.append(png_chunk(b"tRNS", transparency))
    chunks.extend(
        (
            png_chunk(b"IDAT", zlib.compress(raw_scanlines)),
            png_chunk(b"IEND", b""),
        )
    )
    return PNG_SIGNATURE + b"".join(chunks)


def adam7_gray8_scanlines(width: int, height: int) -> bytes:
    starts_and_steps = (
        (0, 0, 8, 8),
        (4, 0, 8, 8),
        (0, 4, 4, 8),
        (2, 0, 4, 4),
        (0, 2, 2, 4),
        (1, 0, 2, 2),
        (0, 1, 1, 2),
    )
    raw = bytearray()
    for x_start, y_start, x_step, y_step in starts_and_steps:
        pass_width = 0 if width <= x_start else (width - x_start + x_step - 1) // x_step
        pass_height = 0 if height <= y_start else (height - y_start + y_step - 1) // y_step
        for _ in range(pass_height):
            raw.extend(b"\x00" + bytes(pass_width))
    return bytes(raw)


def make_args(**overrides: object) -> SimpleNamespace:
    values: dict[str, object] = {
        "postprocess": True,
        "qa": False,
        "components": False,
        "delivery_size": None,
        "grid": None,
        "expected_count": None,
        "postprocess_out_dir": None,
        "resample": "nearest",
        "fit": "contain",
        "safe_margin": 0.0,
        "transparent": True,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class DeliveryTransactionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.imagegen = load_imagegen()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def config(self, **overrides: object):
        values = {
            "base_url": "https://example.test/v1",
            "api_key": "secret",
            "api_key_source": "test",
            "model": "gpt-image-2",
            "defaults": {},
            "postprocess": {"enabled": True},
        }
        values.update(overrides)
        return self.imagegen.Config(**values)

    def test_transaction_rejects_directory_target_without_moving_it(self) -> None:
        target = self.root / "delivery.png"
        target.mkdir()
        sentinel = target / "keep.txt"
        sentinel.write_text("preserve", encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "regular file"):
            with OutputTransaction() as transaction:
                staged = transaction.stage_path(target)
                staged.write_bytes(b"replacement")
                transaction.commit()

        self.assertTrue(target.is_dir())
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserve")

    def test_response_image_write_keeps_other_targets_on_directory_collision(self) -> None:
        source = self.root / "source.png"
        write_png_rgba(source, 1, 1, [(255, 0, 0, 255)])
        encoded = base64.b64encode(source.read_bytes()).decode("ascii")
        mismatched = self.root / "mismatched.png"
        write_png_rgba(mismatched, 2, 1, [(0, 0, 255, 255)] * 2)
        mismatched_encoded = base64.b64encode(mismatched.read_bytes()).decode("ascii")
        output = self.root / "result.png"
        first = self.root / "result_1.png"
        second = self.root / "result_2.png"
        second.mkdir()
        sentinel = second / "keep.txt"
        sentinel.write_text("preserve", encoding="utf-8")

        delivery = self.imagegen.write_response_images(
            {"data": [{"b64_json": encoded}, {"b64_json": mismatched_encoded}]},
            output,
            "png",
            expected_count=2,
            expected_size=(1, 1),
        )

        self.assertEqual(delivery["files"], [first.resolve().as_posix()])
        self.assertEqual(delivery["api_delivery"]["actual_count"], 1)
        self.assertEqual(
            [item["response_index"] for item in delivery["api_delivery"]["items"]],
            [1],
        )
        self.assertTrue(
            any(
                warning.startswith("api_response_item_publish_failed: API image item 2")
                for warning in delivery["warnings"]
            )
        )
        self.assertTrue(
            any(
                warning.startswith("api_response_count_mismatch:")
                for warning in delivery["warnings"]
            )
        )
        self.assertFalse(
            any(
                warning.startswith("api_response_size_mismatch: API image item 2")
                for warning in delivery["warnings"]
            )
        )
        self.assertTrue(first.is_file())
        self.assertTrue(second.is_dir())
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserve")

    def test_response_requires_at_least_one_complete_image(self) -> None:
        target = self.root / "result.png"
        response = {"data": [{"b64_json": base64.b64encode(PNG_SIGNATURE).decode("ascii")}]}

        with self.assertRaisesRegex(self.imagegen.ImagegenError, "complete PNG, JPEG, or WebP"):
            self.imagegen.write_response_images(response, target, "png")

        self.assertFalse(target.exists())

    def test_response_publishes_valid_item_and_warns_about_invalid_peer(self) -> None:
        source = self.root / "valid.png"
        write_png_rgba(source, 1, 1, [(255, 0, 0, 255)])
        response = {"data": [{"b64_json": base64.b64encode(source.read_bytes()).decode("ascii")}, None]}

        delivery = self.imagegen.write_response_images(
            response, self.root / "result.png", "png", expected_count=2
        )

        self.assertEqual(delivery["api_delivery"]["actual_count"], 1)
        self.assertTrue(Path(delivery["files"][0]).is_file())
        self.assertTrue(any(value.startswith("api_response_item_unusable:") for value in delivery["warnings"]))

    def test_response_publishes_each_item_before_decoding_the_next(self) -> None:
        source = self.root / "source.png"
        write_png_rgba(source, 1, 1, [(255, 0, 0, 255)])
        raw = source.read_bytes()
        output = self.root / "streamed.png"
        first_target = self.root / "streamed_1.png"
        decode_calls = 0

        def decode_item(_item: dict[str, object]) -> bytes:
            nonlocal decode_calls
            decode_calls += 1
            if decode_calls == 2:
                self.assertTrue(first_target.is_file())
            return raw

        delivery = self.imagegen.publish_response_images(
            {"data": [{}, {}]},
            output,
            "png",
            decode_item,
            expected_count=2,
        )

        self.assertEqual(delivery["api_delivery"]["actual_count"], 2)

    def test_response_total_byte_limit_preserves_already_published_items(self) -> None:
        source = self.root / "source.png"
        write_png_rgba(source, 1, 1, [(255, 0, 0, 255)])
        encoded = base64.b64encode(source.read_bytes()).decode("ascii")
        output = self.root / "bounded.png"

        with mock.patch(
            "image_response.MAX_TOTAL_IMAGE_RESPONSE_BYTES",
            len(source.read_bytes()),
        ):
            delivery = self.imagegen.write_response_images(
                {"data": [{"b64_json": encoded}, {"b64_json": encoded}]},
                output,
                "png",
                expected_count=2,
            )

        self.assertEqual(delivery["api_delivery"]["actual_count"], 1)
        self.assertTrue(Path(delivery["files"][0]).is_file())
        self.assertTrue(
            any(
                warning.startswith("api_response_total_bytes_exceeded:")
                for warning in delivery["warnings"]
            )
        )

    def test_response_item_limit_preserves_items_within_the_limit(self) -> None:
        source = self.root / "source.png"
        write_png_rgba(source, 1, 1, [(255, 0, 0, 255)])
        encoded = base64.b64encode(source.read_bytes()).decode("ascii")

        with mock.patch("image_response.MAX_IMAGE_RESPONSE_ITEMS", 2):
            delivery = self.imagegen.write_response_images(
                {
                    "data": [
                        {"b64_json": encoded},
                        {"b64_json": encoded},
                        {"b64_json": encoded},
                    ]
                },
                self.root / "bounded-count.png",
                "png",
                expected_count=1,
            )

        self.assertEqual(delivery["api_delivery"]["actual_count"], 2)
        self.assertTrue(all(Path(path).is_file() for path in delivery["files"]))
        self.assertTrue(
            any(
                warning.startswith("api_response_item_limit_exceeded:")
                for warning in delivery["warnings"]
            )
        )

    def test_response_publishes_standard_png_encodings_not_supported_by_postprocessing(self) -> None:
        variants = {
            "gray8": png_bytes(
                2,
                2,
                bit_depth=8,
                color_type=0,
                raw_scanlines=b"\x00\x00\xff\x00\x80\x40",
            ),
            "indexed2": png_bytes(
                3,
                1,
                bit_depth=2,
                color_type=3,
                raw_scanlines=b"\x00\x18",
                palette=b"\x00\x00\x00\xff\x00\x00\x00\xff\x00\x00\x00\xff",
                transparency=b"\x00\xff\xff\xff",
            ),
            "gray16": png_bytes(
                2,
                1,
                bit_depth=16,
                color_type=0,
                raw_scanlines=b"\x00\x00\x00\xff\xff",
            ),
            "adam7": png_bytes(
                5,
                5,
                bit_depth=8,
                color_type=0,
                raw_scanlines=adam7_gray8_scanlines(5, 5),
                interlace=1,
            ),
        }

        for name, source_bytes in variants.items():
            with self.subTest(name=name):
                target = self.root / f"{name}.png"
                response = {
                    "data": [{"b64_json": base64.b64encode(source_bytes).decode("ascii")}]
                }

                delivery = self.imagegen.write_response_images(
                    response,
                    target,
                    "png",
                    expected_count=1,
                )

                self.assertEqual(delivery["files"], [target.resolve().as_posix()])
                self.assertEqual(target.read_bytes(), source_bytes)
                self.assertEqual(delivery["api_delivery"]["items"][0]["actual_size"], [5, 5] if name == "adam7" else ([2, 2] if name == "gray8" else ([3, 1] if name == "indexed2" else [2, 1])))

    def test_response_publishes_png_when_deep_validation_exceeds_budget(self) -> None:
        source_bytes = png_bytes(
            2,
            2,
            bit_depth=8,
            color_type=6,
            raw_scanlines=b"\x00" + bytes((255, 0, 0, 255)) * 2
            + b"\x00" + bytes((0, 0, 255, 255)) * 2,
        )
        target = self.root / "bounded-validation.png"
        response = {
            "data": [{"b64_json": base64.b64encode(source_bytes).decode("ascii")}]
        }

        with mock.patch(
            "image_response.MAX_PNG_DEEP_VALIDATION_BYTES",
            8,
            create=True,
        ):
            delivery = self.imagegen.write_response_images(
                response,
                target,
                "png",
                expected_count=1,
            )

        self.assertEqual(delivery["files"], [target.resolve().as_posix()])
        self.assertEqual(target.read_bytes(), source_bytes)
        self.assertTrue(
            any(
                warning.startswith("api_response_validation_budget_exceeded:")
                for warning in delivery["warnings"]
            )
        )

    def test_response_rejects_broken_png_stream_above_deep_validation_budget(self) -> None:
        ihdr = (
            (2).to_bytes(4, "big")
            + (2).to_bytes(4, "big")
            + b"\x08\x06\x00\x00\x00"
        )
        source_bytes = (
            PNG_SIGNATURE
            + png_chunk(b"IHDR", ihdr)
            + png_chunk(b"IDAT", b"\x78\x9c\x03")
            + png_chunk(b"IEND", b"")
        )
        target = self.root / "broken-bounded-validation.png"
        response = {
            "data": [{"b64_json": base64.b64encode(source_bytes).decode("ascii")}]
        }

        with mock.patch(
            "image_response.MAX_PNG_DEEP_VALIDATION_BYTES",
            8,
            create=True,
        ):
            with self.assertRaisesRegex(self.imagegen.ImagegenError, "complete PNG"):
                self.imagegen.write_response_images(
                    response,
                    target,
                    "png",
                    expected_count=1,
                )

        self.assertFalse(target.exists())

    def test_response_reports_png_scanline_resource_limit(self) -> None:
        source_bytes = png_bytes(
            2,
            2,
            bit_depth=8,
            color_type=6,
            raw_scanlines=(b"\x00" + bytes((255, 0, 0, 255)) * 2) * 2,
        )
        target = self.root / "resource-limited.png"
        response = {
            "data": [{"b64_json": base64.b64encode(source_bytes).decode("ascii")}]
        }

        with mock.patch("image_response.MAX_PNG_STREAM_VALIDATION_BYTES", 8):
            with self.assertRaisesRegex(
                self.imagegen.ImagegenError,
                "PNG scanline validation requires 18 bytes.*8-byte resource limit",
            ):
                self.imagegen.write_response_images(
                    response,
                    target,
                    "png",
                    expected_count=1,
                )

        self.assertFalse(target.exists())

    def test_response_rejects_excessive_idat_chunk_count(self) -> None:
        import zlib

        ihdr = (
            (1).to_bytes(4, "big")
            + (1).to_bytes(4, "big")
            + b"\x08\x06\x00\x00\x00"
        )
        source_bytes = (
            PNG_SIGNATURE
            + png_chunk(b"IHDR", ihdr)
            + png_chunk(b"IDAT", b"") * 4097
            + png_chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00\xff"))
            + png_chunk(b"IEND", b"")
        )
        target = self.root / "excessive-idat.png"
        response = {
            "data": [{"b64_json": base64.b64encode(source_bytes).decode("ascii")}]
        }

        with self.assertRaisesRegex(self.imagegen.ImagegenError, "complete PNG"):
            self.imagegen.write_response_images(
                response,
                target,
                "png",
                expected_count=1,
            )

        self.assertFalse(target.exists())

    def test_response_rejects_jpeg_scan_with_missing_huffman_tables(self) -> None:
        quantization_table = b"\x00" + bytes((1,)) * 64
        frame = b"\x08\x00\x01\x00\x01\x01\x01\x11\x00"
        scan = b"\x01\x01\x00\x00\x3f\x00"
        jpeg = (
            b"\xff\xd8"
            + b"\xff\xdb\x00\x43"
            + quantization_table
            + b"\xff\xc0\x00\x0b"
            + frame
            + b"\xff\xda\x00\x08"
            + scan
            + b"\x00\xff\xd9"
        )

        self.assertFalse(self.imagegen.is_complete_image_data(jpeg))

    def test_response_accepts_complete_progressive_jpeg(self) -> None:
        jpeg = base64.b64decode(
            "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUEBAUEAwUFBAUGBgUGCA4JCAcHCBEMDQoOFBEVFBMRExMWGB8bFhceFxMTGyUcHiAhIyMjFRomKSYiKR8iIyL/"
            "2wBDAQYGBggHCBAJCRAiFhMWIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiL/wgARCAADAAIDASIAAhEBAxEB/"
            "8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUAQEAAAAAAAAAAAAAAAAAAAAD/9oADAMBAAIQAxAAAAGThD//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAn//"
            "xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/An//"
            "xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEAv/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/"
            "9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q=="
        )

        self.assertEqual(self.imagegen.detect_image_format(jpeg), "jpeg")
        self.assertEqual(self.imagegen.image_dimensions(jpeg, "jpeg"), (2, 3))

    def test_response_rejects_webp_lossless_header_without_image_bitstream(self) -> None:
        payload = b"\x2f\x00\x00\x00\x00\x00"
        webp = (
            b"RIFF"
            + (4 + 8 + len(payload)).to_bytes(4, "little")
            + b"WEBPVP8L"
            + len(payload).to_bytes(4, "little")
            + payload
        )

        self.assertFalse(self.imagegen.is_complete_image_data(webp))

    def test_response_rejects_truncated_webp_lossless_bitstream(self) -> None:
        payload = b"\x2f\x00\x00\x00\x00\x00\x01"
        webp = (
            b"RIFF"
            + (4 + 8 + len(payload) + (len(payload) % 2)).to_bytes(4, "little")
            + b"WEBPVP8L"
            + len(payload).to_bytes(4, "little")
            + payload
            + (b"\x00" if len(payload) % 2 else b"")
        )

        self.assertFalse(self.imagegen.is_complete_image_data(webp))

    def test_response_accepts_complete_webp_lossless_bitstream(self) -> None:
        webp = base64.b64decode(
            "UklGRi4AAABXRUJQVlA4TCEAAAAvAUAAEB8w/wKCIv9HCwFB0XXLBXwU1LRtwOI36YjofxwA"
        )

        self.assertTrue(self.imagegen.is_complete_image_data(webp))
        self.assertEqual(self.imagegen.image_dimensions(webp, "webp"), (2, 2))

    def test_response_spec_deviations_publish_original_with_warnings(self) -> None:
        source = self.root / "actual.png"
        write_png_rgba(source, 2, 3, [(255, 0, 0, 255)] * 6)
        response = {"data": [{"b64_json": base64.b64encode(source.read_bytes()).decode("ascii")}]}

        delivery = self.imagegen.write_response_images(
            response, self.root / "requested.jpeg", "jpeg", expected_count=2, expected_size=(4, 4)
        )

        self.assertEqual(Path(delivery["files"][0]).suffix, ".png")
        self.assertTrue(Path(delivery["files"][0]).is_file())
        self.assertEqual(delivery["api_delivery"]["requested_count"], 2)
        self.assertEqual(delivery["api_delivery"]["actual_count"], 1)
        self.assertEqual(delivery["api_delivery"]["items"][0]["actual_size"], [2, 3])
        for prefix in (
            "api_response_count_mismatch:",
            "api_response_size_mismatch:",
            "api_response_format_mismatch:",
        ):
            self.assertTrue(any(value.startswith(prefix) for value in delivery["warnings"]))

    def test_plain_generate_marks_published_original_as_delivery_ready(self) -> None:
        target = self.root / "plain.png"
        encoded = base64.b64encode(
            compact_solid_png_bytes(2, 2, (20, 40, 60, 255))
        ).decode("ascii")
        args = self.imagegen.build_parser().parse_args(
            [
                "generate",
                "-p",
                "studio product photo",
                "--size",
                "2x2",
                "-f",
                str(target),
            ]
        )

        with mock.patch.object(
            self.imagegen,
            "request_json",
            return_value={"data": [{"b64_json": encoded}]},
        ):
            result = self.imagegen.apply_postprocess(
                self.imagegen.generate(self.config(), args),
                args,
                self.config(),
            )

        self.assertTrue(result["ok"])
        self.assertTrue(result["delivery_ready"])
        self.assertEqual(result["files"], [target.resolve().as_posix()])
        self.assertEqual(result["original_files"], result["files"])

    def test_response_count_shortfall_uses_preflight_numbered_slot(self) -> None:
        source = self.root / "valid.png"
        write_png_rgba(source, 1, 1, [(255, 0, 0, 255)])
        encoded = base64.b64encode(source.read_bytes()).decode("ascii")

        delivery = self.imagegen.write_response_images(
            {"data": [{"b64_json": encoded}]},
            self.root / "result.png",
            "png",
            expected_count=2,
        )

        self.assertEqual(delivery["files"], [(self.root / "result_1.png").resolve().as_posix()])

    def test_response_count_overflow_uses_unique_extra_directory(self) -> None:
        source = self.root / "valid.png"
        write_png_rgba(source, 1, 1, [(255, 0, 0, 255)])
        encoded = base64.b64encode(source.read_bytes()).decode("ascii")

        delivery = self.imagegen.write_response_images(
            {"data": [{"b64_json": encoded}, {"b64_json": encoded}]},
            self.root / "result.png",
            "png",
            expected_count=1,
        )

        self.assertEqual(delivery["files"][0], (self.root / "result.png").resolve().as_posix())
        extra = Path(delivery["files"][1])
        self.assertEqual(extra.parent.name, "result-api-extra")
        self.assertTrue(extra.is_file())

    def test_response_count_overflow_uses_preflight_extra_directory(self) -> None:
        source = self.root / "valid.png"
        write_png_rgba(source, 1, 1, [(255, 0, 0, 255)])
        encoded = base64.b64encode(source.read_bytes()).decode("ascii")
        planned = self.root / "reserved-extra"

        delivery = self.imagegen.write_response_images(
            {"data": [{"b64_json": encoded}, {"b64_json": encoded}]},
            self.root / "result.png",
            "png",
            expected_count=1,
            planned_extra_dir=planned,
        )

        self.assertEqual(Path(delivery["files"][1]).parent, planned.resolve())
        self.assertTrue(Path(delivery["files"][1]).is_file())

    def test_2k_generate_returns_original_and_successful_transparency_derivative(self) -> None:
        target = self.root / "two-k.png"
        encoded = base64.b64encode(
            compact_solid_png_bytes(2048, 2048, (0, 255, 0, 255))
        ).decode("ascii")
        args = self.imagegen.build_parser().parse_args(
            [
                "generate",
                "-p",
                "isolated enamel badge",
                "--size",
                "2048x2048",
                "--transparent",
                "--postprocess",
                "-f",
                str(target),
            ]
        )

        def process_success(_source: Path, staged: Path, _plan: object) -> dict[str, object]:
            write_png_rgba(staged, 2, 2, [(220, 30, 40, 0), (220, 30, 40, 255)] * 2)
            return {"status": "pass", "changed": True, "file": staged.resolve().as_posix()}

        with (
            mock.patch.object(
                self.imagegen,
                "request_json",
                return_value={"data": [{"b64_json": encoded}]},
            ),
            mock.patch("image_postprocess.process_transparency_file", side_effect=process_success),
        ):
            record = self.imagegen.generate(self.config(), args)
            result = self.imagegen.apply_postprocess(record, args, self.config())

        self.assertTrue(target.is_file())
        self.assertTrue(result["delivery_ready"])
        self.assertEqual(result["original_files"], [target.resolve().as_posix()])
        self.assertEqual(result["files"][0], target.resolve().as_posix())
        self.assertEqual(len(result["files"]), 2)
        self.assertEqual(result["derived_files"], result["files"][1:])
        self.assertTrue(Path(result["derived_files"][0]).is_file())

    def test_2k_generate_returns_original_when_transparency_processing_fails(self) -> None:
        target = self.root / "two-k-failed.png"
        encoded = base64.b64encode(
            compact_solid_png_bytes(2048, 2048, (20, 40, 60, 255))
        ).decode("ascii")
        args = self.imagegen.build_parser().parse_args(
            [
                "generate",
                "-p",
                "isolated industrial part",
                "--size",
                "2048x2048",
                "--transparent",
                "--postprocess",
                "-f",
                str(target),
            ]
        )

        with (
            mock.patch.object(
                self.imagegen,
                "request_json",
                return_value={"data": [{"b64_json": encoded}]},
            ),
            mock.patch(
                "image_postprocess.process_transparency_file",
                side_effect=ValueError("background separation failed"),
            ),
        ):
            record = self.imagegen.generate(self.config(), args)
            result = self.imagegen.apply_postprocess(record, args, self.config())

        self.assertTrue(target.is_file())
        self.assertTrue(result["ok"])
        self.assertFalse(result["delivery_ready"])
        self.assertEqual(result["files"], [target.resolve().as_posix()])
        self.assertEqual(result["original_files"], [target.resolve().as_posix()])
        self.assertNotIn("derived_files", result)

    def test_4k_generate_publishes_backend_size_mismatch_and_keeps_api_original(self) -> None:
        target = self.root / "four-k.png"
        encoded = base64.b64encode(
            compact_solid_png_bytes(2880, 2880, (20, 40, 60, 255))
        ).decode("ascii")
        args = self.imagegen.build_parser().parse_args(
            [
                "generate",
                "-p",
                "isolated industrial turbine",
                "--size",
                "4096x4096",
                "--transparent",
                "--postprocess",
                "-f",
                str(target),
            ]
        )

        with (
            mock.patch.object(
                self.imagegen,
                "request_json",
                return_value={"data": [{"b64_json": encoded}]},
            ),
            mock.patch(
                "image_postprocess.process_transparency_file",
                side_effect=ValueError("background separation failed"),
            ),
        ):
            record = self.imagegen.generate(self.config(), args)
            result = self.imagegen.apply_postprocess(record, args, self.config())

        self.assertTrue(result["ok"])
        self.assertTrue(target.is_file())
        self.assertFalse(result["delivery_ready"])
        self.assertEqual(result["files"], [target.resolve().as_posix()])
        self.assertTrue(
            any(warning.startswith("api_response_size_mismatch:") for warning in result["warnings"])
        )
        self.assertEqual(result["api_delivery"]["items"][0]["actual_size"], [2880, 2880])

    def test_batch_manifest_keeps_actual_api_image_and_size_warning(self) -> None:
        input_path = self.root / "tasks.jsonl"
        output_root = self.root / "batch"
        input_path.write_text(
            json.dumps({"id": "product", "prompt": "isolated product bottle", "size": "4x4"}) + "\n",
            encoding="utf-8",
        )
        encoded = base64.b64encode(
            compact_solid_png_bytes(2, 3, (20, 40, 60, 255))
        ).decode("ascii")
        args = self.imagegen.build_parser().parse_args(
            [
                "batch",
                "--input",
                str(input_path),
                "--out",
                str(output_root),
                "--concurrency",
                "1",
            ]
        )

        with mock.patch.object(
            self.imagegen,
            "request_json",
            return_value={"data": [{"b64_json": encoded}]},
        ):
            exit_code = self.imagegen.batch(self.config(postprocess={"enabled": False}), args)

        manifest = json.loads((output_root / "manifest.json").read_text(encoding="utf-8"))
        result = manifest["results"][0]
        self.assertEqual(exit_code, 0)
        self.assertTrue(result["ok"])
        self.assertTrue(Path(result["files"][0]).is_file())
        self.assertEqual(result["original_files"], result["files"])
        self.assertEqual(result["api_delivery"]["items"][0]["actual_size"], [2, 3])
        self.assertTrue(
            any(warning.startswith("api_response_size_mismatch:") for warning in result["warnings"])
        )

    def test_qa_exception_rolls_back_derived_output_and_preserves_existing_file(self) -> None:
        source = self.root / "source.png"
        make_chroma_png(source)
        out_dir = self.root / "delivery"
        out_dir.mkdir()
        existing = out_dir / "source-4x4.png"
        write_png_rgba(existing, 1, 1, [(1, 2, 3, 255)])
        original_existing = existing.read_bytes()
        args = make_args(
            qa=True,
            delivery_size="4x4",
            postprocess_out_dir=str(out_dir),
        )
        record = {
            "ok": True,
            "files": [str(source)],
            "transparency": {
                "requested": True,
                "mode": "chroma-matting",
                "key": "#00FF00",
                "status": "pending",
            },
        }

        with mock.patch.object(self.imagegen, "evaluate_delivery", side_effect=RuntimeError("qa probe failed")):
            result = self.imagegen.apply_postprocess(record, args, self.config())

        self.assertTrue(result["ok"])
        self.assertEqual(result["files"], [source.resolve().as_posix()])
        self.assertNotIn("derived_files", result)
        self.assertFalse(result["delivery_ready"])
        self.assertEqual(existing.read_bytes(), original_existing)
        self.assertEqual(list(out_dir.glob(".imagegen-stage-*")), [])

    def test_derived_publish_collision_keeps_successful_peer(self) -> None:
        first = self.root / "first.png"
        second = self.root / "second.png"
        make_chroma_png(first)
        make_chroma_png(second)
        out_dir = self.root / "isolated-publish"
        blocked_target = out_dir / "second-transparent.png"
        blocked_target.mkdir(parents=True)
        sentinel = blocked_target / "keep.txt"
        sentinel.write_text("preserve", encoding="utf-8")

        result = self.imagegen.apply_postprocess(
            {
                "ok": True,
                "files": [str(first), str(second)],
                "transparency": {
                    "requested": True,
                    "mode": "chroma-matting",
                    "key": "#00FF00",
                    "status": "pending",
                },
            },
            make_args(postprocess_out_dir=str(out_dir)),
            self.config(),
        )

        successful = out_dir / "first-transparent.png"
        self.assertTrue(successful.is_file())
        self.assertEqual(result["derived_files"], [successful.resolve().as_posix()])
        self.assertEqual(
            result["files"],
            [
                first.resolve().as_posix(),
                successful.resolve().as_posix(),
                second.resolve().as_posix(),
            ],
        )
        self.assertFalse(result["delivery_ready"])
        self.assertTrue(
            any(
                warning.startswith("postprocess_item_publish_failed:")
                for warning in result["warnings"]
            )
        )
        self.assertTrue(blocked_target.is_dir())
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserve")

    def test_qa_non_pass_status_rolls_back_derived_output(self) -> None:
        for qa_status in ("fail", "partial", "not_evaluated"):
            with self.subTest(qa_status=qa_status):
                source = self.root / f"source-{qa_status}.png"
                make_chroma_png(source)
                out_dir = self.root / f"delivery-{qa_status}"
                out_dir.mkdir()
                existing = out_dir / f"{source.stem}-4x4.png"
                write_png_rgba(existing, 1, 1, [(1, 2, 3, 255)])
                original_existing = existing.read_bytes()
                args = make_args(
                    qa=True,
                    transparent=False,
                    delivery_size="4x4",
                    postprocess_out_dir=str(out_dir),
                )

                def evaluate(paths: list[Path], **_kwargs: object) -> dict[str, object]:
                    staged = Path(paths[0]).resolve().as_posix()
                    return {
                        "schema_version": "qa.v1",
                        "status": qa_status,
                        "artifacts": [
                            {
                                "file": staged,
                                "role": "delivery",
                                "inspection": {"path": staged, "width": 4, "height": 4},
                                "checks": [{"name": "synthetic_contract", "status": qa_status}],
                            }
                        ],
                        "conditions": [],
                        "warnings": [],
                        "errors": [],
                    }

                with mock.patch.object(self.imagegen, "evaluate_delivery", side_effect=evaluate):
                    result = self.imagegen.apply_postprocess(
                        {"ok": True, "files": [str(source)]},
                        args,
                        self.config(),
                    )

                self.assertTrue(result["ok"])
                self.assertFalse(result["delivery_ready"])
                self.assertEqual(result["files"], [source.resolve().as_posix()])
                self.assertNotIn("derived_files", result)
                self.assertNotIn("postprocess", result)
                self.assertEqual(result["qa"]["status"], qa_status)
                artifact = result["qa"]["artifacts"][0]
                self.assertNotIn("file", artifact)
                self.assertNotIn("path", artifact["inspection"])
                self.assertTrue(
                    any(warning.startswith("delivery_qa_unmet:") for warning in result["warnings"])
                )
                self.assertEqual(existing.read_bytes(), original_existing)
                self.assertEqual(list(out_dir.glob(".imagegen-stage-*")), [])

    def test_qa_failure_keeps_native_api_alpha_as_transparency_pass(self) -> None:
        source = self.root / "native-alpha.png"
        pixels = [(0, 0, 0, 0)] * 16
        pixels[5] = (220, 30, 40, 255)
        pixels[6] = (220, 30, 40, 255)
        pixels[9] = (220, 30, 40, 255)
        pixels[10] = (220, 30, 40, 255)
        write_png_rgba(
            source,
            4,
            4,
            pixels,
        )
        out_dir = self.root / "native-alpha-delivery"
        args = make_args(
            qa=True,
            expected_count=2,
            delivery_size="4x4",
            postprocess_out_dir=str(out_dir),
        )
        record = {
            "ok": True,
            "files": [str(source)],
            "transparency": {
                "requested": True,
                "mode": "prompt-alpha",
                "key": None,
                "status": "pending",
            },
        }

        result = self.imagegen.apply_postprocess(record, args, self.config())

        self.assertTrue(result["ok"])
        self.assertFalse(result["delivery_ready"])
        self.assertEqual(result["files"], [source.resolve().as_posix()])
        self.assertNotIn("derived_files", result)
        self.assertEqual(result["qa"]["status"], "fail")
        self.assertEqual(result["transparency"]["status"], "pass")
        artifact = result["transparency"]["artifacts"][0]
        self.assertEqual(artifact["status"], "pass")
        self.assertEqual(artifact["file"], source.resolve().as_posix())
        self.assertNotIn("files", artifact)
        self.assertEqual(list(out_dir.glob("*.png")), [])
        warning = next(
            warning
            for warning in result["warnings"]
            if warning.startswith("delivery_qa_unmet:")
        )
        self.assertIn("derived images were discarded", warning)

    def test_qa_failure_rolls_back_transparency_derivative(self) -> None:
        source = self.root / "chroma-source.png"
        make_chroma_png(source)
        out_dir = self.root / "transparent-delivery"
        args = make_args(
            qa=True,
            expected_count=2,
            postprocess_out_dir=str(out_dir),
        )
        record = {
            "ok": True,
            "files": [str(source)],
            "transparency": {
                "requested": True,
                "mode": "chroma-matting",
                "key": "#00FF00",
                "status": "pending",
            },
        }

        result = self.imagegen.apply_postprocess(record, args, self.config())

        self.assertTrue(result["ok"])
        self.assertFalse(result["delivery_ready"])
        self.assertEqual(result["files"], [source.resolve().as_posix()])
        self.assertNotIn("derived_files", result)
        self.assertEqual(result["qa"]["status"], "fail")
        self.assertEqual(result["transparency"]["status"], "unmet")
        artifact = result["transparency"]["artifacts"][0]
        self.assertEqual(artifact["status"], "unmet")
        self.assertFalse(artifact["changed"])
        self.assertEqual(artifact["file"], source.resolve().as_posix())
        self.assertTrue(
            any(warning.startswith("delivery_qa_unmet:") for warning in result["warnings"])
        )
        self.assertEqual(list(out_dir.glob("*.png")), [])
        self.assertEqual(list(out_dir.glob(".imagegen-stage-*")), [])

    def test_qa_failure_keeps_other_image_transparency_derivative(self) -> None:
        passing = self.root / "passing.png"
        failing = self.root / "failing.png"
        make_chroma_png(passing)
        write_png_rgba(failing, 7, 7, [(30, 40, 50, 255)] * 49)
        out_dir = self.root / "mixed-qa-delivery"
        args = make_args(
            qa=True,
            postprocess_out_dir=str(out_dir),
        )
        record = {
            "ok": True,
            "files": [str(passing), str(failing)],
            "transparency": {
                "requested": True,
                "mode": "chroma-matting",
                "key": "#00FF00",
                "status": "pending",
            },
        }

        result = self.imagegen.apply_postprocess(record, args, self.config())

        self.assertTrue(result["ok"])
        self.assertFalse(result["delivery_ready"])
        self.assertEqual(result["qa"]["status"], "fail")
        self.assertEqual(result["transparency"]["status"], "unmet")
        self.assertEqual(
            [item["status"] for item in result["transparency"]["artifacts"]],
            ["pass", "unmet"],
        )
        self.assertEqual(len(result["derived_files"]), 1)
        self.assertEqual(
            result["files"],
            [
                passing.resolve().as_posix(),
                result["derived_files"][0],
                failing.resolve().as_posix(),
            ],
        )
        self.assertTrue(Path(result["derived_files"][0]).is_file())
        self.assertEqual(list(out_dir.glob(".imagegen-stage-*")), [])

    def test_postprocess_metadata_contains_only_existing_paths(self) -> None:
        source = self.root / "source.png"
        make_chroma_png(source)
        out_dir = self.root / "delivery"
        args = make_args(delivery_size="4x4", postprocess_out_dir=str(out_dir))
        result = self.imagegen.apply_postprocess(
            {
                "ok": True,
                "files": [str(source)],
                "transparency": {
                    "requested": True,
                    "mode": "chroma-matting",
                    "key": "#00FF00",
                    "status": "pending",
                },
            },
            args,
            self.config(),
        )

        self.assertTrue(result["delivery_ready"])
        path_keys = {"file", "files", "source", "path", "original_files", "derived_files"}

        def assert_paths(value: object, key: str | None = None) -> None:
            if isinstance(value, dict):
                for child_key, child_value in value.items():
                    assert_paths(child_value, child_key)
            elif isinstance(value, list):
                for child_value in value:
                    assert_paths(child_value, key)
            elif isinstance(value, str) and key in path_keys:
                self.assertTrue(Path(value).is_file(), f"stale path: {value}")

        assert_paths(result)

    def test_batch_does_not_reserve_unpublished_transparency_intermediate(self) -> None:
        output_root = self.root / "batch"
        intermediate = self.root / "derived" / "source-transparent.png"
        tasks = [
            {
                "id": "transparent",
                "prompt": "isolated subject",
                "file": str(self.root / "source.png"),
                "transparent": True,
                "delivery_size": "4x4",
                "postprocess_out_dir": str(intermediate.parent),
            },
            {
                "id": "consumer",
                "prompt": "ordinary image",
                "file": str(intermediate),
            },
        ]

        prepare_batch_targets(
            tasks,
            {},
            output_root,
            "20260812-120000",
            lambda value: value.replace(" ", "-"),
            lambda task: "png",
            lambda task: True,
        )

    def test_reprocessing_clears_stale_postprocess_and_qa_metadata(self) -> None:
        source = self.root / "opaque.png"
        write_png_rgba(source, 4, 4, [(20, 40, 60, 255)] * 16)
        stale = self.root / "old-derived.png"
        write_png_rgba(stale, 1, 1, [(1, 2, 3, 255)])
        result = self.imagegen.apply_postprocess(
            {
                "ok": True,
                "files": [str(source), str(stale)],
                "original_files": [str(source)],
                "derived_files": [str(stale)],
                "postprocess": [{"source": str(stale), "file": str(stale)}],
                "qa": {"status": "pass"},
                "transparency": {
                    "requested": True,
                    "mode": "chroma-matting",
                    "key": "#00FF00",
                    "status": "pass",
                },
            },
            make_args(),
            self.config(),
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["files"], [source.resolve().as_posix()])
        self.assertNotIn("derived_files", result)
        self.assertNotIn("postprocess", result)
        self.assertNotIn("qa", result)

    def test_invalid_grid_is_rejected_before_api_request(self) -> None:
        args = self.imagegen.build_parser().parse_args(
            [
                "generate",
                "-p",
                "isolated badge",
                "--transparent",
                "--grid",
                "2x2",
                "-f",
                str(self.root / "result.png"),
            ]
        )

        with mock.patch.object(self.imagegen, "request_json", return_value={"data": []}) as request:
            with self.assertRaisesRegex(self.imagegen.ImagegenError, "grid requires delivery_size"):
                self.imagegen.generate(self.config(), args)

        request.assert_not_called()

    def test_direct_transparency_failure_does_not_publish_duplicate_original(self) -> None:
        source = self.root / "opaque.png"
        target = self.root / "transparent.png"
        write_png_rgba(source, 4, 4, [(20, 40, 60, 255)] * 16)
        args = SimpleNamespace(
            file=str(source),
            out=str(target),
            route="chroma-matting",
            key="#00FF00",
            transparency_mask=None,
            transparency_param=None,
        )

        with mock.patch.object(self.imagegen.sys, "stdout", io.StringIO()):
            exit_code = self.imagegen.apply_transparency_command(args)

        self.assertEqual(exit_code, 0)
        self.assertFalse(target.exists())

    def test_manifest_checks_nested_declared_paths(self) -> None:
        source = self.root / "source.png"
        write_png_rgba(source, 1, 1, [(1, 2, 3, 255)])
        missing = self.root / "missing-stage.png"

        manifest, files_exist = write_manifest(
            self.root,
            [
                {
                    "id": "one",
                    "ok": True,
                    "files": [str(source)],
                    "postprocess": [{"source": str(missing)}],
                }
            ],
        )

        payload = json.loads(manifest.read_text(encoding="utf-8"))
        self.assertFalse(files_exist)
        self.assertEqual(payload["path_contract"]["status"], "fail")
        self.assertIn(str(missing), payload["path_contract"]["missing_files"])


if __name__ == "__main__":
    unittest.main()
