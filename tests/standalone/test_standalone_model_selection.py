from __future__ import annotations

import contextlib
import base64
from dataclasses import replace
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import imagegen


class StandaloneModelSelectionTests(unittest.TestCase):
    def test_gif_and_svg_are_not_silently_converted_by_transparency_intent(self):
        cfg = imagegen.Config(base_url="https://example.test/v1", api_key="fixture", api_key_source="fixture", model="image", defaults={}, postprocess={}, config_version=2)
        for fmt in ("gif", "svg"):
            args = imagegen.build_parser().parse_args(["generate", "--prompt", "loop", "--format", fmt, "--transparent"])
            with self.assertRaisesRegex(imagegen.ImagegenError, "GIF/SVG"):
                imagegen.resolve_common_params(args, cfg)

    def test_extended_formats_auto_size_and_markup_use_public_cli(self):
        from tests.support.python_fixtures import make_png
        cfg = imagegen.Config(base_url="https://example.test/v1", api_key="fixture", api_key_source="fixture", model="gpt-image-2.6-flare", defaults={}, postprocess={}, config_version=2, capabilities={"generate": True, "edit": True, "markup": True})
        originals = {"gif":bytes.fromhex("47494638396101000100800000000000ffffff2c00000000010001000002024401003b"), "svg":b'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"/>'}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for fmt, original in originals.items():
                output = root / f"result.{fmt}"
                args = imagegen.build_parser().parse_args(["generate", "--prompt", "loop", "--format", fmt, "--size", "auto", "--file", str(output)])
                with mock.patch.object(imagegen.image_transport, "request_json", return_value={"data":[{"b64_json":base64.b64encode(original).decode()}]}):
                    result = imagegen.generate(cfg, args)
                self.assertTrue(result["ok"], result)
                self.assertEqual(output.read_bytes(), original)
            parent, markup = root / "parent.png", root / "markup.png"
            parent.write_bytes(make_png(2, 2))
            markup.write_bytes(make_png(2, 2, 0))
            args = imagegen.build_parser().parse_args(["edit", "--prompt", "recolor", "--image", str(parent), "--markup", str(markup), "--file", str(root / "edited.png")])
            with mock.patch.object(imagegen.image_transport, "request_multipart", return_value={"data":[{"b64_json":base64.b64encode(make_png(2, 2)).decode()}]}) as send:
                result = imagegen.edit(cfg, args)
            self.assertTrue(result["ok"], result)
            self.assertEqual([upload[0] for upload in send.call_args.kwargs["files"]], ["image[]", "markup"])

    def test_v2_batch_dimension_priority_preserves_each_input_layer(self):
        cfg = imagegen.Config(base_url="https://example.test/v1", api_key="fixture", api_key_source="fixture", model="image", defaults={}, postprocess={}, config_version=2, protocol="xai-images")
        args = imagegen.build_parser().parse_args(["batch", "--input", "rows.jsonl", "--out", "outputs", "--size", "1024x1024"])
        params = imagegen.resolve_common_params(args, cfg, {"aspect": "16:9", "resolution": "2K"})
        self.assertIsNone(params["size"])
        self.assertEqual((params["aspect"], params["resolution"]), ("16:9", "2K"))
        cfg = replace(cfg, protocol="openai-compatible")
        args = imagegen.build_parser().parse_args(["batch", "--input", "rows.jsonl", "--out", "outputs", "--aspect", "16:9", "--resolution", "2K"])
        params = imagegen.resolve_common_params(args, cfg, {"size": "512x512"})
        self.assertEqual(params["size"], "512x512")
        self.assertIsNone(params["aspect"])
        with self.assertRaisesRegex(imagegen.ImagegenError, "same priority"):
            imagegen.resolve_common_params(args, cfg, {"size": "512x512", "aspect": "1:1"})

    def test_v2_preserves_transparency_and_asset_format_intent(self):
        cfg = imagegen.Config(base_url="https://example.test/v1", api_key="fixture", api_key_source="fixture", model="image", defaults={"output_format": "jpeg"}, postprocess={}, config_version=2)
        args = imagegen.build_parser().parse_args(["generate", "--prompt", "cube"])
        for intent in ("transparent", "asset"):
            self.assertEqual(imagegen.resolve_common_params(args, cfg, {intent: True})["output_format"], "png")
        with self.assertRaisesRegex(imagegen.ImagegenError, "background=transparent has been removed"):
            imagegen.resolve_common_params(args, cfg, {"background": "transparent"})
        self.assertEqual(imagegen.resolve_common_params(args, cfg, {"background": " OPAQUE "})["background"], "opaque")

    def test_v2_rejects_zero_count_and_timeout_instead_of_defaulting(self):
        cfg = imagegen.Config(base_url="https://example.test/v1", api_key="fixture", api_key_source="fixture", model="image", defaults={}, postprocess={}, config_version=2)
        args = imagegen.build_parser().parse_args(["generate", "--prompt", "cube"])
        for field in ("n", "timeout"):
            with self.subTest(field=field), self.assertRaises(imagegen.ImagegenError):
                imagegen.resolve_common_params(args, cfg, {field: 0})

    def test_disabled_generate_capability_stops_before_any_request(self):
        cfg = imagegen.Config(base_url="https://example.test/v1", api_key="fixture", api_key_source="fixture", model="image", defaults={}, postprocess={}, config_version=2, capabilities={"generate": False})
        args = imagegen.build_parser().parse_args(["generate", "--prompt", "cube"])
        with mock.patch.object(imagegen, "request_json") as request:
            with self.assertRaisesRegex(imagegen.ImagegenError, "does not support.*generat"):
                imagegen.generate(cfg, args)
        request.assert_not_called()

    def config(self):
        return {
            "config_version": 2, "active_profile": "default",
            "providers": {
                "empty": {"protocol": "openai-compatible", "base_url": "https://empty.example.test/v1"},
                "selected": {"protocol": "xai-images", "base_url": "https://selected.example.test/v1", "api_key": "fixture-selected"},
            },
            "models": {
                "default": {"provider": "empty", "model": "default-model", "capabilities": {"generate": True}},
                "alternate": {"provider": "selected", "model": "future-image", "aliases": ["alternate-alias"], "defaults": {"resolution": "8K"}, "capabilities": {"generate": True, "edit": True}},
            },
        }

    def test_explicit_cli_profile_does_not_require_default_provider_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "auth.json"
            config_path.write_text(json.dumps(self.config()), encoding="utf-8")
            args = ["imagegen", "generate", "--profile", "alternate-alias", "--prompt", "cube"]
            with mock.patch.object(imagegen, "AUTH_PATH", config_path), mock.patch.object(sys, "argv", args), mock.patch.object(imagegen, "generate", return_value={"ok": True, "files": []}) as generate, mock.patch.object(imagegen, "apply_postprocess", side_effect=lambda result, *_: result), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as errors:
                result = imagegen.main()
            self.assertEqual(result, 0, errors.getvalue())
            self.assertEqual(generate.call_args.args[0].profile_id, "alternate")

    def test_profile_selection_uses_loaded_snapshot_after_config_file_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "auth.json"
            config_path.write_text(json.dumps(self.config()), encoding="utf-8")
            with mock.patch.object(imagegen, "AUTH_PATH", config_path):
                original = imagegen.load_config(require_api_key=False)
                config_path.write_text("{}", encoding="utf-8")
                args = imagegen.build_parser().parse_args(["generate", "--prompt", "cube", "--profile", "alternate", "--parameters", '{"seed":7}'])
                selected = imagegen.request_config(original, args, {})
            self.assertEqual(selected.profile_id, "alternate")
            self.assertEqual(selected.api_key, "fixture-selected")
            self.assertEqual(selected.parameters, {"seed": 7})
            self.assertEqual(imagegen.resolve_common_params(args, selected)["resolution"], "8K")


if __name__ == "__main__":
    unittest.main()
