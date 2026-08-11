from __future__ import annotations

import importlib.util
import base64
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock
import zlib


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "imagegen.py"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def load_imagegen():
    spec = importlib.util.spec_from_file_location("imagegen_qa_under_test", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load imagegen.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def make_rgba_png(path: Path, width: int, height: int, pixels: list[tuple[int, int, int, int]]) -> None:
    if len(pixels) != width * height:
        raise ValueError("pixel count does not match dimensions")
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw.extend(pixels[y * width + x])
    chunks = [
        png_chunk(b"IHDR", width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00"),
        png_chunk(b"IDAT", zlib.compress(bytes(raw))),
        png_chunk(b"IEND", b""),
    ]
    path.write_bytes(PNG_SIGNATURE + b"".join(chunks))


def make_rgb_trns_png(path: Path) -> None:
    ihdr = (1).to_bytes(4, "big") + (1).to_bytes(4, "big") + b"\x08\x02\x00\x00\x00"
    chunks = [
        png_chunk(b"IHDR", ihdr),
        png_chunk(b"tRNS", b"\x00\xff\x00\x00\x00\x00"),
        png_chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00")),
        png_chunk(b"IEND", b""),
    ]
    path.write_bytes(PNG_SIGNATURE + b"".join(chunks))


def png_chunk(kind: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(kind + data) & 0xFFFFFFFF
    return len(data).to_bytes(4, "big") + kind + data + crc.to_bytes(4, "big")


class GenericImageQATests(unittest.TestCase):
    def setUp(self) -> None:
        self.imagegen = load_imagegen()
        self.temp_dir = Path(self._testMethodName)
        self.temp_dir.mkdir(exist_ok=True)

    def tearDown(self) -> None:
        for path in sorted(self.temp_dir.rglob("*"), reverse=True):
            if path.is_dir():
                path.rmdir()
            else:
                path.unlink()
        self.temp_dir.rmdir()

    def test_inspect_reports_generic_alpha_geometry_and_components(self) -> None:
        path = self.temp_dir / "input.png"
        pixels = [(0, 0, 0, 0)] * 36
        pixels[7] = (255, 20, 20, 255)
        pixels[8] = (255, 20, 20, 128)
        pixels[14] = (255, 20, 20, 255)
        pixels[15] = (255, 20, 20, 255)
        pixels[35] = (20, 20, 20, 255)
        make_rgba_png(path, 6, 6, pixels)

        result = self.imagegen.inspect_image_file(path, include_components=True)

        self.assertEqual(result["alpha_bbox"], [1, 1, 5, 5])
        self.assertAlmostEqual(result["alpha_coverage"], 5 / 36, places=6)
        self.assertEqual(result["alpha_margins"], {"left": 1, "top": 1, "right": 0, "bottom": 0})
        self.assertAlmostEqual(result["semi_transparent_ratio"], 1 / 36, places=6)
        self.assertEqual(result["corner_alpha"]["bottom_right"], 255)
        self.assertEqual(result["components"]["count"], 2)
        self.assertEqual(result["components"]["largest_pixels"], 4)
        self.assertTrue(result["sha256"])

    def test_evaluate_delivery_checks_expected_size_and_transparency_condition(self) -> None:
        path = self.temp_dir / "transparent.png"
        pixels = [(0, 0, 0, 0)] * 16
        pixels[5] = (255, 0, 0, 255)
        make_rgba_png(path, 4, 4, pixels)

        result = self.imagegen.evaluate_delivery(
            [path],
            expectations={"expected_size": [4, 4], "expected_count": 1},
            conditions=[{"kind": "transparent", "requested": True}],
        )

        self.assertEqual(result["schema_version"], "qa.v1")
        self.assertEqual(result["status"], "pass")
        self.assertTrue(all(check["status"] == "pass" for check in result["artifacts"][0]["checks"]))

    def test_evaluate_delivery_marks_size_mismatch_as_fail(self) -> None:
        path = self.temp_dir / "input.png"
        make_rgba_png(path, 4, 4, [(255, 0, 0, 255)] * 16)

        result = self.imagegen.evaluate_delivery([path], expectations={"expected_size": [2, 2]})

        self.assertEqual(result["status"], "fail")
        self.assertTrue(any(check["name"] == "expected_size" and check["status"] == "fail" for check in result["artifacts"][0]["checks"]))

    def test_evaluate_delivery_marks_non_png_as_unsupported(self) -> None:
        path = self.temp_dir / "photo.jpeg"
        path.write_bytes(b"not a png")

        result = self.imagegen.evaluate_delivery([path], expectations={"expected_size": [128, 128]})

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["artifacts"][0]["checks"][1]["status"], "unsupported")
        self.assertEqual(result["artifacts"][0]["checks"][2]["name"], "expected_size")
        self.assertEqual(result["artifacts"][0]["checks"][2]["status"], "unsupported")

    def test_bilinear_resize_and_safe_margin_are_available(self) -> None:
        pixels = [
            (0, 0, 0, 255),
            (255, 255, 255, 255),
            (255, 255, 255, 255),
            (0, 0, 0, 255),
        ]

        resized = self.imagegen.resize_pixels(pixels, 2, 2, 3, 3, "bilinear")
        self.assertNotIn(resized[4], {(0, 0, 0, 255), (255, 255, 255, 255)})

        contained = self.imagegen.fit_to_canvas(pixels, 2, 2, 8, 8, resample="nearest", safe_margin=0.25)
        info = self.imagegen.analyze_pixels(contained, 8, 8)
        self.assertEqual(info["alpha_bbox"], [2, 2, 5, 5])

    def test_bilinear_resize_preserves_source_corners(self) -> None:
        pixels = [
            (255, 0, 0, 255),
            (0, 255, 0, 255),
            (0, 0, 255, 255),
            (255, 255, 255, 255),
        ]

        resized = self.imagegen.resize_pixels(pixels, 2, 2, 3, 3, "bilinear")

        self.assertEqual(resized[0], pixels[0])
        self.assertEqual(resized[2], pixels[1])
        self.assertEqual(resized[6], pixels[2])
        self.assertEqual(resized[8], pixels[3])

    def test_png_reader_rejects_truncated_iend_chunk(self) -> None:
        path = self.temp_dir / "truncated.png"
        make_rgba_png(path, 1, 1, [(255, 0, 0, 255)])
        path.write_bytes(path.read_bytes()[:-2])

        with self.assertRaisesRegex(self.imagegen.ImagegenError, "invalid PNG"):
            self.imagegen.read_png_rgba(path)

    def test_png_reader_rejects_short_ihdr_as_user_facing_error(self) -> None:
        path = self.temp_dir / "short-ihdr.png"
        path.write_bytes(PNG_SIGNATURE + png_chunk(b"IHDR", b"\x00") + png_chunk(b"IEND", b""))

        with self.assertRaisesRegex(self.imagegen.ImagegenError, "IHDR"):
            self.imagegen.read_png_rgba(path)

    def test_png_reader_rejects_bad_crc_and_oversized_dimensions(self) -> None:
        crc_path = self.temp_dir / "bad-crc.png"
        make_rgba_png(crc_path, 1, 1, [(255, 0, 0, 255)])
        corrupt = bytearray(crc_path.read_bytes())
        corrupt[-1] ^= 0xFF
        crc_path.write_bytes(corrupt)

        with self.assertRaisesRegex(self.imagegen.ImagegenError, "CRC"):
            self.imagegen.read_png_rgba(crc_path)

        oversized = self.temp_dir / "oversized.png"
        ihdr = (
            (5001).to_bytes(4, "big")
            + (5000).to_bytes(4, "big")
            + b"\x08\x06\x00\x00\x00"
        )
        oversized.write_bytes(PNG_SIGNATURE + png_chunk(b"IHDR", ihdr) + png_chunk(b"IEND", b""))

        with self.assertRaisesRegex(self.imagegen.ImagegenError, "dimensions"):
            self.imagegen.read_png_rgba(oversized)

    def test_png_reader_rejects_interlaced_images(self) -> None:
        path = self.temp_dir / "interlaced.png"
        ihdr = (1).to_bytes(4, "big") + (1).to_bytes(4, "big") + b"\x08\x06\x00\x00\x01"
        raw = zlib.compress(b"\x00\xff\x00\x00\xff")
        path.write_bytes(
            PNG_SIGNATURE + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", raw) + png_chunk(b"IEND", b"")
        )

        with self.assertRaisesRegex(self.imagegen.ImagegenError, "non-interlaced"):
            self.imagegen.read_png_rgba(path)

    def test_png_reader_explicitly_rejects_rgb_trns_transparency(self) -> None:
        path = self.temp_dir / "rgb-trns.png"
        make_rgb_trns_png(path)

        with self.assertRaisesRegex(self.imagegen.ImagegenError, "RGB.*tRNS"):
            self.imagegen.read_png_rgba(path)

    def test_edge_metrics_do_not_duplicate_a_single_pixel(self) -> None:
        path = self.temp_dir / "single.png"
        make_rgba_png(path, 1, 1, [(255, 0, 0, 128)])

        result = self.imagegen.inspect_image_file(path)

        self.assertEqual(result["edge_alpha"]["pixels"], 1)
        self.assertEqual(result["edge_alpha"]["nontransparent_pixels"], 1)
        self.assertEqual(result["edge_alpha"]["partial_alpha_pixels"], 1)

    def test_batch_row_values_override_shared_batch_values(self) -> None:
        args = SimpleNamespace(quality="high", qa=True, resample="nearest")
        task = {"quality": "low", "qa": False, "resample": "bilinear"}

        self.assertEqual(self.imagegen.get_value("quality", args, task, None), "low")
        self.assertFalse(self.imagegen.get_value("qa", args, task, False))
        self.assertEqual(self.imagegen.get_value("resample", args, task, None), "bilinear")

    def test_write_response_images_rejects_incomplete_base64_before_write(self) -> None:
        target = self.temp_dir / "result.png"
        response = {"data": [{"b64_json": base64.b64encode(PNG_SIGNATURE).decode("ascii")}]}

        with self.assertRaisesRegex(self.imagegen.ImagegenError, "complete PNG, JPEG, or WebP"):
            self.imagegen.write_response_images(response, target, "png")

        self.assertFalse(target.exists())

    def test_write_response_images_rejects_non_object_before_any_write(self) -> None:
        source = self.temp_dir / "valid.png"
        make_rgba_png(source, 1, 1, [(255, 0, 0, 255)])
        response = {
            "data": [
                {"b64_json": base64.b64encode(source.read_bytes()).decode("ascii")},
                None,
            ]
        }

        with self.assertRaisesRegex(self.imagegen.ImagegenError, r"data\[1\].*object"):
            self.imagegen.write_response_images(response, self.temp_dir / "result.png", "png")

        self.assertEqual(list(self.temp_dir.glob("result*.png")), [])

    def test_write_response_images_requires_requested_count(self) -> None:
        source = self.temp_dir / "valid.png"
        make_rgba_png(source, 1, 1, [(255, 0, 0, 255)])
        response = {"data": [{"b64_json": base64.b64encode(source.read_bytes()).decode("ascii")}]}

        with self.assertRaisesRegex(self.imagegen.ImagegenError, "returned 1 image.*requested 2"):
            self.imagegen.write_response_images(
                response,
                self.temp_dir / "result.png",
                "png",
                expected_count=2,
            )

    def test_write_response_images_rejects_response_size_mismatch_before_write(self) -> None:
        source = self.temp_dir / "wrong-size.png"
        target = self.temp_dir / "result.png"
        make_rgba_png(source, 2, 3, [(255, 0, 0, 255)] * 6)
        response = {"data": [{"b64_json": base64.b64encode(source.read_bytes()).decode("ascii")}]}

        with self.assertRaisesRegex(
            self.imagegen.ImagegenError,
            r"image response size 2x3 does not match requested size 4x4",
        ):
            self.imagegen.write_response_images(
                response,
                target,
                "png",
                expected_size=(4, 4),
            )

        self.assertFalse(target.exists())

    def test_decode_base64_rejects_encoded_image_over_byte_limit(self) -> None:
        encoded = base64.b64encode(b"12345").decode("ascii")

        with mock.patch.object(self.imagegen, "MAX_IMAGE_RESPONSE_BYTES", 4, create=True):
            with self.assertRaisesRegex(self.imagegen.ImagegenError, "image response exceeds"):
                self.imagegen.decode_image_item({"b64_json": encoded})

    def test_download_rejects_stream_over_byte_limit(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.headers.get.return_value = None
        response.read.side_effect = [b"12345", b""]

        with (
            mock.patch.object(self.imagegen, "MAX_IMAGE_RESPONSE_BYTES", 4, create=True),
            mock.patch.object(self.imagegen.urllib.request, "urlopen", return_value=response),
        ):
            with self.assertRaisesRegex(self.imagegen.ImagegenError, "image response exceeds"):
                self.imagegen.download_image_url("https://cdn.example.test/image.png")

        self.assertEqual(response.read.call_args.args, (5,))

    def test_marker_only_images_are_not_complete(self) -> None:
        marker_only = [
            PNG_SIGNATURE + b"\x00\x00\x00\x00IEND\xaeB`\x82",
            b"\xff\xd8\xff\xd9",
            b"RIFF\x04\x00\x00\x00WEBP",
        ]

        for data in marker_only:
            with self.subTest(data=data[:12]):
                self.assertFalse(self.imagegen.is_complete_image_data(data))

    def test_structurally_empty_jpeg_and_webp_are_not_complete(self) -> None:
        empty_jpeg = (
            b"\xff\xd8"
            b"\xff\xc0\x00\x08\x08\x00\x01\x00\x01\x01"
            b"\xff\xda\x00\x02\x00"
            b"\xff\xd9"
        )
        empty_webp = b"RIFF" + (12).to_bytes(4, "little") + b"WEBP" + b"ANMF" + (0).to_bytes(4, "little")

        self.assertFalse(self.imagegen.is_complete_image_data(empty_jpeg))
        self.assertFalse(self.imagegen.is_complete_image_data(empty_webp))

    def test_truncated_or_invalid_jpeg_and_webp_payloads_are_not_complete(self) -> None:
        invalid_payloads = [
            bytes.fromhex("ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9"),
            bytes.fromhex("524946461600000057454250565038200a0000000000009d012a01000100"),
            bytes.fromhex("524946461600000057454250565038200a0000002000009d012a01000100"),
            bytes.fromhex("5249464612000000574542505650384c050000002f0000000000"),
            bytes.fromhex("5249464612000000574542505650384c060000002f0000002000"),
        ]

        for data in invalid_payloads:
            with self.subTest(data=data[:12]):
                self.assertFalse(self.imagegen.is_complete_image_data(data))

    def test_encoded_jpeg_and_webp_are_complete(self) -> None:
        jpeg = base64.b64decode(
            "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIs"
            "IxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy"
            "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAA"
            "AAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAk"
            "M2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKT"
            "lJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QA"
            "HwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdh"
            "cRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hp"
            "anN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk"
            "5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z"
        )
        webp = base64.b64decode("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuU")

        self.assertEqual(self.imagegen.detect_image_format(jpeg), "jpeg")
        self.assertEqual(self.imagegen.detect_image_format(webp), "webp")
        self.assertEqual(self.imagegen.image_dimensions(jpeg, "jpeg"), (1, 1))
        self.assertEqual(self.imagegen.image_dimensions(webp, "webp"), (1, 1))

    def test_write_response_images_rejects_actual_format_mismatch(self) -> None:
        source = self.temp_dir / "valid.png"
        make_rgba_png(source, 1, 1, [(255, 0, 0, 255)])
        response = {"data": [{"b64_json": base64.b64encode(source.read_bytes()).decode("ascii")}]}

        with self.assertRaisesRegex(self.imagegen.ImagegenError, "actual format png.*requested jpeg"):
            self.imagegen.write_response_images(response, self.temp_dir / "result.jpeg", "jpeg")

        self.assertFalse((self.temp_dir / "result.jpeg").exists())

    def test_resolved_png_rejects_jpeg_output_extension(self) -> None:
        args = SimpleNamespace(file=str(self.temp_dir / "result.jpeg"), out=str(self.temp_dir))

        with self.assertRaisesRegex(self.imagegen.ImagegenError, "does not match resolved format png"):
            self.imagegen.resolve_output_file(args, {}, "png", "transparent subject")

    def test_grid_qa_uses_total_count_across_multiple_source_images(self) -> None:
        first = self.temp_dir / "first.png"
        second = self.temp_dir / "second.png"
        make_rgba_png(first, 2, 2, [(255, 0, 0, 255)] * 4)
        make_rgba_png(second, 2, 2, [(0, 0, 255, 255)] * 4)
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="test-model",
            defaults={},
            postprocess={"enabled": False},
        )
        args = SimpleNamespace(
            postprocess=False,
            qa=True,
            components=False,
            delivery_size="2x2",
            grid="1x1",
            expected_count=1,
            postprocess_out_dir=str(self.temp_dir / "delivery"),
            resample="nearest",
            fit="stretch",
            safe_margin=0.0,
            transparent=False,
        )

        result = self.imagegen.apply_postprocess(
            {"ok": True, "files": [str(first), str(second)]},
            args,
            cfg,
        )

        self.assertEqual(len(result["files"]), 2)
        self.assertEqual(result["qa"]["status"], "pass")
        self.assertEqual(result["qa"]["checks"][0]["expected"], 2)

    def test_grid_postprocess_requires_delivery_size(self) -> None:
        source = self.temp_dir / "source.png"
        make_rgba_png(source, 2, 2, [(255, 0, 0, 255)] * 4)
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="test-model",
            defaults={},
            postprocess={"enabled": False},
        )
        args = SimpleNamespace(
            postprocess=False,
            qa=False,
            components=False,
            delivery_size=None,
            grid="2x2",
            expected_count=4,
            postprocess_out_dir=None,
            resample="nearest",
            fit="stretch",
            safe_margin=0.0,
            transparent=False,
        )

        with self.assertRaisesRegex(self.imagegen.ImagegenError, "grid requires delivery_size"):
            self.imagegen.apply_postprocess({"ok": True, "files": [str(source)]}, args, cfg)

    def test_unmet_transparency_returns_original_without_padding(self) -> None:
        source = self.temp_dir / "opaque-source.png"
        make_rgba_png(source, 4, 4, [(20, 40, 60, 255)] * 16)
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="test-model",
            defaults={},
            postprocess={"enabled": False},
        )
        args = SimpleNamespace(
            postprocess=False,
            qa=True,
            components=False,
            delivery_size="8x8",
            grid=None,
            expected_count=None,
            postprocess_out_dir=str(self.temp_dir / "transparent-delivery"),
            resample="nearest",
            fit="contain",
            safe_margin=0.125,
            transparent=True,
        )

        result = self.imagegen.apply_postprocess(
            {
                "ok": True,
                "files": [str(source)],
                "transparency": {
                    "requested": True,
                    "mode": "prompt-alpha",
                    "key": None,
                    "status": "pending",
                },
            },
            args,
            cfg,
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["transparency"]["status"], "unmet")
        self.assertEqual(result["files"], [source.resolve().as_posix()])
        self.assertTrue(result["warnings"])
        self.assertEqual(result["qa"]["status"], "fail")
        self.assertEqual([item["role"] for item in result["qa"]["artifacts"]], ["delivery"])
        self.assertFalse((self.temp_dir / "transparent-delivery").exists())

    def test_prompt_alpha_success_keeps_api_file_as_delivery(self) -> None:
        source = self.temp_dir / "native-alpha.png"
        pixels = [(0, 0, 0, 0)] * 16
        pixels[5] = (220, 30, 40, 255)
        make_rgba_png(source, 4, 4, pixels)
        out_dir = self.temp_dir / "unused-delivery"
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="test-model",
            defaults={},
            postprocess={"enabled": False},
        )
        args = SimpleNamespace(
            postprocess=False,
            qa=True,
            components=False,
            delivery_size=None,
            grid=None,
            expected_count=None,
            postprocess_out_dir=str(out_dir),
            resample="nearest",
            fit="contain",
            safe_margin=0.0,
            transparent=True,
        )

        result = self.imagegen.apply_postprocess(
            {
                "ok": True,
                "files": [str(source)],
                "transparency": {
                    "requested": True,
                    "mode": "prompt-alpha",
                    "key": None,
                    "status": "pending",
                },
            },
            args,
            cfg,
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["transparency"]["status"], "pass")
        self.assertEqual(result["files"], [source.resolve().as_posix()])
        self.assertNotIn("original_files", result)
        self.assertFalse(out_dir.exists())
        self.assertEqual(result["qa"]["status"], "pass")

    def test_chroma_key_success_preserves_api_original_and_delivers_derived_file(self) -> None:
        source = self.temp_dir / "chroma-source.png"
        green = (0, 255, 0, 255)
        red = (220, 30, 40, 255)
        pixels = [green] * 49
        for y in range(2, 5):
            for x in range(2, 5):
                pixels[y * 7 + x] = red
        make_rgba_png(source, 7, 7, pixels)
        original = source.read_bytes()
        out_dir = self.temp_dir / "transparent-delivery"
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="test-model",
            defaults={},
            postprocess={"enabled": True},
        )
        args = SimpleNamespace(
            postprocess=True,
            qa=True,
            components=False,
            delivery_size=None,
            grid=None,
            expected_count=None,
            postprocess_out_dir=str(out_dir),
            resample="nearest",
            fit="contain",
            safe_margin=0.0,
            transparent=True,
        )

        result = self.imagegen.apply_postprocess(
            {
                "ok": True,
                "files": [str(source)],
                "transparency": {
                    "requested": True,
                    "mode": "chroma-key",
                    "key": "#00FF00",
                    "status": "pending",
                },
            },
            args,
            cfg,
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["transparency"]["status"], "pass")
        self.assertEqual(result["original_files"], [str(source)])
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(len(result["files"]), 1)
        self.assertNotEqual(result["files"][0], source.resolve().as_posix())
        self.assertTrue(Path(result["files"][0]).is_file())
        self.assertEqual(result["qa"]["status"], "pass")

    def test_mixed_transparency_results_are_delivered_per_image(self) -> None:
        passing = self.temp_dir / "passing.png"
        failing = self.temp_dir / "failing.png"
        green = (0, 255, 0, 255)
        red = (220, 30, 40, 255)
        keyed_pixels = [green] * 49
        for y in range(2, 5):
            for x in range(2, 5):
                keyed_pixels[y * 7 + x] = red
        make_rgba_png(passing, 7, 7, keyed_pixels)
        make_rgba_png(failing, 7, 7, [(30, 40, 50, 255)] * 49)
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="test-model",
            defaults={},
            postprocess={"enabled": True},
        )
        args = SimpleNamespace(
            postprocess=True,
            qa=False,
            components=False,
            delivery_size=None,
            grid=None,
            expected_count=None,
            postprocess_out_dir=str(self.temp_dir / "mixed-delivery"),
            resample="nearest",
            fit="contain",
            safe_margin=0.0,
            transparent=True,
        )

        result = self.imagegen.apply_postprocess(
            {
                "ok": True,
                "files": [str(passing), str(failing)],
                "transparency": {
                    "requested": True,
                    "mode": "chroma-key",
                    "key": "#00FF00",
                    "status": "pending",
                },
            },
            args,
            cfg,
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["transparency"]["status"], "unmet")
        self.assertEqual(
            [item["status"] for item in result["transparency"]["artifacts"]],
            ["pass", "unmet"],
        )
        self.assertNotEqual(result["files"][0], passing.resolve().as_posix())
        self.assertEqual(result["files"][1], failing.resolve().as_posix())
        self.assertTrue(Path(result["files"][0]).is_file())

    def test_transparency_processing_exception_returns_api_original(self) -> None:
        source = self.temp_dir / "source.png"
        make_rgba_png(source, 4, 4, [(20, 40, 60, 255)] * 16)
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="test-model",
            defaults={},
            postprocess={"enabled": True},
        )
        args = SimpleNamespace(
            postprocess=True,
            qa=False,
            components=False,
            delivery_size=None,
            grid=None,
            expected_count=None,
            postprocess_out_dir=str(self.temp_dir / "failed-delivery"),
            resample="nearest",
            fit="contain",
            safe_margin=0.0,
            transparent=True,
        )

        with mock.patch("image_postprocess.process_transparency_file", side_effect=RuntimeError("test failure")):
            result = self.imagegen.apply_postprocess(
                {
                    "ok": True,
                    "files": [str(source)],
                    "transparency": {
                        "requested": True,
                        "mode": "chroma-key",
                        "key": "#00FF00",
                        "status": "pending",
                    },
                },
                args,
                cfg,
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["files"], [source.resolve().as_posix()])
        self.assertEqual(result["transparency"]["status"], "unmet")
        self.assertIn("local_transparency_processing_failed", result["warnings"][0])

    def test_transparency_delivery_failure_returns_api_original(self) -> None:
        source = self.temp_dir / "source.png"
        green = (0, 255, 0, 255)
        pixels = [green] * 49
        for y in range(2, 5):
            for x in range(2, 5):
                pixels[y * 7 + x] = (220, 30, 40, 255)
        make_rgba_png(source, 7, 7, pixels)
        original = source.read_bytes()
        out_dir = self.temp_dir / "failed-delivery"
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="test-model",
            defaults={},
            postprocess={"enabled": True},
        )
        args = SimpleNamespace(
            postprocess=True,
            qa=False,
            components=False,
            delivery_size="4x4",
            grid=None,
            expected_count=None,
            postprocess_out_dir=str(out_dir),
            resample="nearest",
            fit="contain",
            safe_margin=0.0,
            transparent=True,
        )

        with mock.patch.object(
            self.imagegen,
            "normalize_image_file",
            side_effect=self.imagegen.ImagegenError("test delivery failure"),
        ):
            result = self.imagegen.apply_postprocess(
                {
                    "ok": True,
                    "files": [str(source)],
                    "transparency": {
                        "requested": True,
                        "mode": "chroma-key",
                        "key": "#00FF00",
                        "status": "pending",
                    },
                },
                args,
                cfg,
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["files"], [source.resolve().as_posix()])
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(result["transparency"]["status"], "unmet")
        self.assertIn("postprocess_publish_failed", result["warnings"][0])
        self.assertEqual(list(out_dir.glob("*.png")), [])

    def test_transparent_intent_uses_only_the_delivery_flag(self) -> None:
        args = SimpleNamespace(transparent=False, background="transparent")

        self.assertFalse(self.imagegen.transparent_intent(args, {}))

    def test_apply_prompt_directives_uses_resolved_transparency_plan(self) -> None:
        args = SimpleNamespace(asset=False)
        plan = self.imagegen.TransparencyPlan(
            mode="prompt-alpha",
            prompt="A clinic calendar\n\nOutput a PNG with a real alpha channel.",
        )

        prompt = self.imagegen.apply_prompt_directives("A clinic calendar", args, {}, plan)

        self.assertIn("real alpha channel", prompt)

    def test_preview_board_writes_manifest_and_background_variants(self) -> None:
        source = self.temp_dir / "source.png"
        out_dir = self.temp_dir / "preview"
        make_rgba_png(source, 4, 4, [(255, 0, 0, 255)] * 16)

        result = self.imagegen.preview_board_image(
            source,
            out_dir,
            sizes=[(2, 2), (3, 3)],
            backgrounds=["transparent", "white"],
            resample="nearest",
        )

        self.assertEqual(result["count"], 4)
        self.assertTrue(Path(result["board"]).is_file())
        self.assertTrue(Path(result["manifest"]).is_file())
        manifest = json.loads(Path(result["manifest"]).read_text(encoding="utf-8"))
        self.assertEqual(len(manifest["previews"]), 4)
        self.assertTrue(any(item["background"] == "white" for item in manifest["previews"]))

    def test_preview_board_deduplicates_repeated_sizes_and_backgrounds(self) -> None:
        source = self.temp_dir / "source.png"
        out_dir = self.temp_dir / "preview"
        make_rgba_png(source, 4, 4, [(255, 0, 0, 255)] * 16)

        result = self.imagegen.preview_board_image(
            source,
            out_dir,
            sizes=[(2, 2), (2, 2)],
            backgrounds=["white", "white"],
            resample="nearest",
        )

        self.assertEqual(result["count"], 1)
        self.assertEqual(len(result["previews"]), 1)

    def test_preview_board_rejects_total_pixels_before_rendering(self) -> None:
        source = self.temp_dir / "source.png"
        make_rgba_png(source, 1, 1, [(255, 0, 0, 255)])

        with (
            mock.patch("image_preview.MAX_PREVIEW_TOTAL_PIXELS", 10, create=True),
            mock.patch("image_preview._fit_pixels") as fit_pixels,
        ):
            with self.assertRaisesRegex(self.imagegen.ImagegenError, "preview.*pixel limit"):
                self.imagegen.preview_board_image(
                    source,
                    self.temp_dir / "preview",
                    sizes=[(2, 2), (3, 3)],
                    backgrounds=["white", "black"],
                    resample="nearest",
                )

        fit_pixels.assert_not_called()

    def test_preview_matrix_uses_compact_pixel_buffers(self) -> None:
        from image_png import PixelBuffer
        from image_preview import render_preview_matrix

        previews, _, _, board = render_preview_matrix(
            PixelBuffer(bytes((255, 0, 0, 255))),
            1,
            1,
            [(1, 1)],
            ["white"],
            self.imagegen.fit_to_canvas,
            "nearest",
        )

        self.assertIsInstance(previews[0]["pixels"], PixelBuffer)
        self.assertIsInstance(board, PixelBuffer)

    def test_batch_rejects_duplicate_targets_before_workers_start(self) -> None:
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="test-model",
            defaults={},
            postprocess={"enabled": False},
        )
        args = SimpleNamespace(
            input=str(self.temp_dir / "tasks.jsonl"),
            out=str(self.temp_dir / "batch"),
            concurrency=2,
            file=None,
            format="png",
            n=1,
        )
        duplicate = str(self.temp_dir / "same.png")
        tasks = [
            {"id": "first", "prompt": "first", "file": duplicate, "format": "png"},
            {"id": "second", "prompt": "second", "file": duplicate, "format": "png"},
        ]

        with (
            mock.patch.object(self.imagegen, "read_jsonl", return_value=tasks),
            mock.patch.object(self.imagegen, "run_one_task") as run_one,
        ):
            run_one.return_value = {"id": "unexpected", "ok": True}
            with self.assertRaisesRegex(self.imagegen.ImagegenError, "batch target path conflict"):
                self.imagegen.batch(cfg, args)

        run_one.assert_not_called()

    def test_batch_rejects_duplicate_transparency_targets_before_workers_start(self) -> None:
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="test-model",
            defaults={},
            postprocess={"enabled": True},
        )
        derived = self.temp_dir / "derived"
        args = SimpleNamespace(
            input=str(self.temp_dir / "tasks.jsonl"),
            out=str(self.temp_dir / "batch"),
            concurrency=2,
            file=None,
            format="png",
            n=1,
            transparent=False,
            delivery_size=None,
            grid=None,
            postprocess_out_dir=str(derived),
        )
        tasks = [
            {
                "id": "first",
                "prompt": "first",
                "file": str(self.temp_dir / "a" / "same.png"),
                "transparent": True,
            },
            {
                "id": "second",
                "prompt": "second",
                "file": str(self.temp_dir / "b" / "same.png"),
                "transparent": True,
            },
        ]

        with (
            mock.patch.object(self.imagegen, "read_jsonl", return_value=tasks),
            mock.patch.object(self.imagegen, "run_one_task") as run_one,
        ):
            with self.assertRaisesRegex(self.imagegen.ImagegenError, "batch target path conflict"):
                self.imagegen.batch(cfg, args)

        run_one.assert_not_called()

    def test_batch_prompt_alpha_does_not_reserve_unused_transparency_targets(self) -> None:
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="gpt-image-2",
            defaults={},
            postprocess={"enabled": False},
            transparency=self.imagegen.resolve_transparency_policy(
                {
                    "prompt_only_allow": [
                        {
                            "model": "gpt-image-2",
                            "mode": "generate",
                            "size": "1024x1024",
                        }
                    ]
                }
            ),
        )
        derived = self.temp_dir / "derived"
        args = SimpleNamespace(
            input=str(self.temp_dir / "tasks.jsonl"),
            out=str(self.temp_dir / "batch-prompt-alpha"),
            concurrency=2,
            file=None,
            format="png",
            n=1,
            transparent=False,
            delivery_size=None,
            grid=None,
            postprocess_out_dir=str(derived),
            postprocess=False,
        )
        tasks = [
            {
                "id": "first",
                "prompt": "first",
                "file": str(self.temp_dir / "a" / "same.png"),
                "transparent": True,
                "size": "1024x1024",
            },
            {
                "id": "second",
                "prompt": "second",
                "file": str(self.temp_dir / "b" / "same.png"),
                "transparent": True,
                "size": "1024x1024",
            },
        ]

        def successful_result(_cfg: object, _args: object, task: dict[str, object]) -> dict[str, object]:
            return {"id": task["id"], "ok": True, "files": []}

        with (
            mock.patch.object(self.imagegen, "read_jsonl", return_value=tasks),
            mock.patch.object(self.imagegen, "run_one_task", side_effect=successful_result) as run_one,
        ):
            self.assertEqual(self.imagegen.batch(cfg, args), 0)

        self.assertEqual(run_one.call_count, 2)

    def test_batch_rejects_undeclared_transparency_route_before_workers_start(self) -> None:
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="gpt-image-2",
            defaults={},
            postprocess={"enabled": False},
        )
        args = SimpleNamespace(
            input=str(self.temp_dir / "tasks.jsonl"),
            out=str(self.temp_dir / "batch-transparent-unavailable"),
            concurrency=1,
            file=None,
            format=None,
            n=None,
            postprocess=False,
        )
        tasks = [{"id": "transparent", "prompt": "isolated badge", "transparent": True, "size": "1024x1024"}]

        with (
            mock.patch.object(self.imagegen, "read_jsonl", return_value=tasks),
            mock.patch.object(self.imagegen, "run_one_task") as run_one,
        ):
            with self.assertRaisesRegex(self.imagegen.ImagegenError, "No image request was sent"):
                self.imagegen.batch(cfg, args)

        run_one.assert_not_called()

    def test_batch_uses_resolved_png_format_for_transparent_unnamed_task(self) -> None:
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="test-model",
            defaults={"output_format": "jpeg"},
            postprocess={"enabled": False},
        )
        args = SimpleNamespace(
            input=str(self.temp_dir / "tasks.jsonl"),
            out=str(self.temp_dir / "batch-transparent"),
            concurrency=1,
            file=None,
            format=None,
            n=None,
            postprocess=True,
        )
        tasks = [{"prompt": "transparent subject", "transparent": True}]

        with (
            mock.patch.object(self.imagegen, "read_jsonl", return_value=tasks),
            mock.patch.object(
                self.imagegen,
                "run_one_task",
                return_value={"id": None, "ok": True, "files": []},
            ) as run_one,
        ):
            self.assertEqual(self.imagegen.batch(cfg, args), 0)

        submitted_task = run_one.call_args.args[2]
        self.assertEqual(Path(submitted_task["file"]).suffix, ".png")

    def test_batch_workers_receive_normalized_shared_output_paths(self) -> None:
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="test-model",
            defaults={},
            postprocess={"enabled": False},
        )
        output_root = self.temp_dir / "batch-relative"
        args = SimpleNamespace(
            input=str(self.temp_dir / "tasks.jsonl"),
            out=str(output_root),
            concurrency=1,
            file="shared/result.png",
            format="png",
            n=1,
            postprocess=False,
            postprocess_out_dir="derived",
        )
        tasks = [{"id": "one", "prompt": "one"}]

        with (
            mock.patch.object(self.imagegen, "read_jsonl", return_value=tasks),
            mock.patch.object(
                self.imagegen,
                "run_one_task",
                return_value={"id": "one", "ok": True, "files": []},
            ) as run_one,
        ):
            self.assertEqual(self.imagegen.batch(cfg, args), 0)

        worker_args = run_one.call_args.args[1]
        self.assertEqual(Path(worker_args.file), (output_root / "shared/result.png").resolve())
        self.assertEqual(Path(worker_args.postprocess_out_dir), (output_root / "derived").resolve())
        self.assertEqual(args.file, "shared/result.png")

    def test_batch_rejects_explicit_extension_that_conflicts_with_resolved_format(self) -> None:
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="test-model",
            defaults={"output_format": "jpeg"},
            postprocess={"enabled": False},
        )
        args = SimpleNamespace(
            input=str(self.temp_dir / "tasks.jsonl"),
            out=str(self.temp_dir / "batch-transparent-explicit"),
            concurrency=1,
            file=None,
            format=None,
            n=None,
            postprocess=True,
        )
        tasks = [
            {
                "prompt": "transparent subject",
                "transparent": True,
                "file": str(self.temp_dir / "wrong.jpeg"),
            }
        ]

        with (
            mock.patch.object(self.imagegen, "read_jsonl", return_value=tasks),
            mock.patch.object(self.imagegen, "run_one_task") as run_one,
        ):
            with self.assertRaisesRegex(self.imagegen.ImagegenError, "does not match resolved format png"):
                self.imagegen.batch(cfg, args)

        run_one.assert_not_called()

    def test_read_jsonl_accepts_bom_and_blank_lines(self) -> None:
        path = self.temp_dir / "tasks.jsonl"
        path.write_text('\ufeff{"id":"one","prompt":"first"}\n\n{"id":"two","prompt":"second"}\n', encoding="utf-8")

        self.assertEqual(
            self.imagegen.read_jsonl(path),
            [
                {"id": "one", "prompt": "first"},
                {"id": "two", "prompt": "second"},
            ],
        )

    def test_read_jsonl_reports_invalid_line_number(self) -> None:
        path = self.temp_dir / "tasks.jsonl"
        path.write_text('{"id":"one"}\nnot-json\n', encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "invalid JSONL at line 2"):
            self.imagegen.read_jsonl(path)

    def test_postprocess_failure_leaves_no_partial_delivery(self) -> None:
        first = self.temp_dir / "first.png"
        second = self.temp_dir / "second.png"
        make_rgba_png(first, 2, 2, [(255, 0, 0, 255)] * 4)
        make_rgba_png(second, 2, 2, [(0, 0, 255, 255)] * 4)
        out_dir = self.temp_dir / "delivery"
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="test-model",
            defaults={},
            postprocess={"enabled": False},
        )
        args = SimpleNamespace(
            postprocess=False,
            qa=False,
            components=False,
            delivery_size="1x1",
            grid=None,
            expected_count=None,
            postprocess_out_dir=str(out_dir),
            resample="nearest",
            fit="stretch",
            safe_margin=0.0,
            transparent=False,
        )
        real_normalize = self.imagegen.normalize_image_file
        calls = 0

        def fail_second(*call_args, **call_kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise self.imagegen.ImagegenError("second transform failed")
            return real_normalize(*call_args, **call_kwargs)

        with mock.patch.object(self.imagegen, "normalize_image_file", side_effect=fail_second):
            with self.assertRaisesRegex(self.imagegen.ImagegenError, "second transform failed"):
                self.imagegen.apply_postprocess(
                    {"ok": True, "files": [str(first), str(second)]},
                    args,
                    cfg,
                )

        self.assertEqual(list(out_dir.glob("*.png")), [])


if __name__ == "__main__":
    unittest.main()
