from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
import zlib


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "imagegen.py"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def load_imagegen():
    spec = importlib.util.spec_from_file_location("imagegen_under_test", SCRIPT)
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


def png_chunk(kind: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(kind + data) & 0xFFFFFFFF
    return len(data).to_bytes(4, "big") + kind + data + crc.to_bytes(4, "big")


class AuthConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.imagegen = load_imagegen()
        self.temp_dir = Path(self._testMethodName)
        self.temp_dir.mkdir(exist_ok=True)
        self.auth_path = self.temp_dir / "auth.json"
        self.example_path = self.temp_dir / "auth.example.json"
        self.example_path.write_text(
            json.dumps(
                {
                    "base_url": "https://example.com/v1",
                    "api_key": "replace-with-temporary-local-key",
                    "api_key_env": "OPENAI_API_KEY",
                    "model": "gpt-image-2",
                    "capabilities": {"transparent_background": True},
                    "defaults": {
                        "size": "2048x2048",
                        "quality": "auto",
                        "output_format": "png",
                    },
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        self.imagegen.AUTH_PATH = self.auth_path
        self.imagegen.EXAMPLE_AUTH_PATH = self.example_path

    def tearDown(self) -> None:
        for path in sorted(self.temp_dir.rglob("*"), reverse=True):
            if path.is_dir():
                path.rmdir()
            else:
                path.unlink()
        self.temp_dir.rmdir()

    def test_init_auth_creates_local_config_without_api_secret(self) -> None:
        args = SimpleNamespace(
            force=False,
            base_url="https://images.example.test/v1",
            model="gpt-image-2",
            api_key_env="IMAGEGEN_API_KEY",
            transparent_background=False,
        )

        exit_code = self.imagegen.init_auth(args)

        self.assertEqual(exit_code, 0)
        data = json.loads(self.auth_path.read_text(encoding="utf-8"))
        self.assertEqual(data["base_url"], "https://images.example.test/v1")
        self.assertEqual(data["api_key"], "replace-with-temporary-local-key")
        self.assertEqual(data["api_key_env"], "IMAGEGEN_API_KEY")
        self.assertEqual(data["model"], "gpt-image-2")
        self.assertFalse(data["capabilities"]["transparent_background"])

    def test_load_config_uses_api_key_env_when_file_key_is_placeholder(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://images.example.test/v1",
                    "api_key": "replace-with-temporary-local-key",
                    "api_key_env": "IMAGEGEN_TEST_KEY",
                    "model": "gpt-image-2",
                }
            ),
            encoding="utf-8",
        )
        old_value = os.environ.get("IMAGEGEN_TEST_KEY")
        os.environ["IMAGEGEN_TEST_KEY"] = "env-secret"
        try:
            cfg = self.imagegen.load_config()
        finally:
            if old_value is None:
                os.environ.pop("IMAGEGEN_TEST_KEY", None)
            else:
                os.environ["IMAGEGEN_TEST_KEY"] = old_value

        self.assertEqual(cfg.api_key, "env-secret")
        self.assertEqual(cfg.api_key_source, "env:IMAGEGEN_TEST_KEY")

    def test_load_config_prefers_direct_api_key_over_env(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://images.example.test/v1",
                    "api_key": "file-secret",
                    "api_key_env": "IMAGEGEN_TEST_KEY",
                    "model": "gpt-image-2",
                }
            ),
            encoding="utf-8",
        )
        old_value = os.environ.get("IMAGEGEN_TEST_KEY")
        os.environ["IMAGEGEN_TEST_KEY"] = "env-secret"
        try:
            cfg = self.imagegen.load_config()
        finally:
            if old_value is None:
                os.environ.pop("IMAGEGEN_TEST_KEY", None)
            else:
                os.environ["IMAGEGEN_TEST_KEY"] = old_value

        self.assertEqual(cfg.api_key, "file-secret")
        self.assertEqual(cfg.api_key_source, "auth.json api_key")

    def test_info_mode_allows_unconfigured_api_key(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://images.example.test/v1",
                    "api_key": "replace-with-temporary-local-key",
                    "api_key_env": "IMAGEGEN_TEST_KEY",
                    "model": "gpt-image-2",
                }
            ),
            encoding="utf-8",
        )

        cfg = self.imagegen.load_config(require_api_key=False)

        self.assertEqual(cfg.api_key, "")
        self.assertEqual(cfg.api_key_source, "missing")

    def test_postprocess_config_defaults_to_disabled_when_missing(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://images.example.test/v1",
                    "api_key": "file-secret",
                    "model": "gpt-image-2",
                }
            ),
            encoding="utf-8",
        )

        cfg = self.imagegen.load_config()

        self.assertFalse(cfg.postprocess["enabled"])


class PostprocessImageTests(unittest.TestCase):
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

    def test_inspect_image_reports_png_size_and_alpha_bbox(self) -> None:
        path = self.temp_dir / "input.png"
        pixels = [(0, 0, 0, 0)] * 16
        pixels[5] = (255, 0, 0, 255)
        pixels[6] = (255, 0, 0, 255)
        pixels[9] = (255, 0, 0, 128)
        pixels[10] = (255, 0, 0, 128)
        make_rgba_png(path, 4, 4, pixels)

        result = self.imagegen.inspect_image_file(path)

        self.assertEqual(result["width"], 4)
        self.assertEqual(result["height"], 4)
        self.assertTrue(result["has_alpha"])
        self.assertEqual(result["alpha_bbox"], [1, 1, 2, 2])

    def test_normalize_image_resizes_to_delivery_size(self) -> None:
        source = self.temp_dir / "source.png"
        output = self.temp_dir / "normalized.png"
        pixels = [(255, 0, 0, 255)] * 16
        make_rgba_png(source, 4, 4, pixels)

        result = self.imagegen.normalize_image_file(source, output, (2, 2))

        self.assertEqual(result["output"]["width"], 2)
        self.assertEqual(result["output"]["height"], 2)
        self.assertTrue(output.is_file())

    def test_split_grid_crops_full_cells_before_resizing(self) -> None:
        source = self.temp_dir / "grid.png"
        out_dir = self.temp_dir / "split"
        pixels: list[tuple[int, int, int, int]] = []
        colors = [
            (255, 0, 0, 255),
            (0, 255, 0, 255),
            (0, 0, 255, 255),
            (255, 255, 0, 255),
        ]
        for y in range(4):
            for x in range(4):
                cell = (y // 2) * 2 + (x // 2)
                pixels.append(colors[cell])
        make_rgba_png(source, 4, 4, pixels)

        result = self.imagegen.split_grid_image(source, out_dir, rows=2, cols=2, delivery_size=(2, 2))

        self.assertEqual(len(result["outputs"]), 4)
        self.assertEqual(result["grid"], {"rows": 2, "cols": 2, "count": 4})
        for item in result["outputs"]:
            info = self.imagegen.inspect_image_file(Path(item["file"]))
            self.assertEqual((info["width"], info["height"]), (2, 2))

    def test_split_grid_allows_non_divisible_canvas_size(self) -> None:
        source = self.temp_dir / "non_divisible_grid.png"
        out_dir = self.temp_dir / "non_divisible_split"
        pixels = [(255, 0, 0, 255)] * 25
        make_rgba_png(source, 5, 5, pixels)

        result = self.imagegen.split_grid_image(source, out_dir, rows=2, cols=2, delivery_size=(2, 2))

        self.assertEqual(len(result["outputs"]), 4)
        self.assertEqual(result["outputs"][0]["source_cell"], [0, 0, 2, 2])
        self.assertEqual(result["outputs"][1]["source_cell"], [2, 0, 3, 2])
        self.assertEqual(result["outputs"][2]["source_cell"], [0, 2, 2, 3])
        self.assertEqual(result["outputs"][3]["source_cell"], [2, 2, 3, 3])

    def test_apply_postprocess_keeps_record_unchanged_when_disabled(self) -> None:
        source = self.temp_dir / "source.png"
        make_rgba_png(source, 4, 4, [(255, 0, 0, 255)] * 16)
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="gpt-image-2",
            defaults={},
            capabilities={},
            postprocess={"enabled": False},
        )
        args = SimpleNamespace(
            postprocess=False,
            delivery_size=None,
            grid=None,
            expected_count=None,
            postprocess_out_dir=None,
        )
        record = {"ok": True, "files": [str(source)]}

        result = self.imagegen.apply_postprocess(record, args, cfg)

        self.assertEqual(result, record)

    def test_apply_postprocess_normalizes_when_delivery_size_is_explicit(self) -> None:
        source = self.temp_dir / "source.png"
        out_dir = self.temp_dir / "post"
        make_rgba_png(source, 4, 4, [(255, 0, 0, 255)] * 16)
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="gpt-image-2",
            defaults={},
            capabilities={},
            postprocess={"enabled": False},
        )
        args = SimpleNamespace(
            postprocess=False,
            delivery_size="2x2",
            grid=None,
            expected_count=None,
            postprocess_out_dir=str(out_dir),
        )
        record = {"ok": True, "files": [str(source)]}

        result = self.imagegen.apply_postprocess(record, args, cfg)

        self.assertEqual(result["original_files"], [str(source)])
        self.assertEqual(len(result["files"]), 1)
        info = self.imagegen.inspect_image_file(Path(result["files"][0]))
        self.assertEqual((info["width"], info["height"]), (2, 2))


if __name__ == "__main__":
    unittest.main()
