"""Compatibility snapshots for the Standalone v0.3.0 Python interface."""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from scripts import image_batch, imagegen
from scripts.image_cli import build_parser
from scripts.image_png import write_png_rgba


SUPPORTED_ASPECTS = {"1:1", "16:9", "4:3", "3:4", "9:16"}
SUPPORTED_RESOLUTIONS = {"1K", "2K", "4K"}
V030_COMMANDS = {
    "init",
    "generate",
    "edit",
    "batch",
    "inspect-image",
    "normalize",
    "split-grid",
    "preview-board",
    "apply-transparency",
    "info",
}


class StandaloneCompatibilityTests(unittest.TestCase):
    def test_v030_command_and_argument_snapshot(self) -> None:
        parser = build_parser(SUPPORTED_ASPECTS, SUPPORTED_RESOLUTIONS)
        self.assertEqual(set(parser._subparsers._group_actions[0].choices), V030_COMMANDS)

        generate = parser.parse_args(
            ["generate", "--prompt", "a blue square", "--aspect", "16:9", "--n", "2"]
        )
        self.assertEqual(generate.command, "generate")
        self.assertEqual(generate.prompt, "a blue square")
        self.assertEqual(generate.aspect, "16:9")
        self.assertEqual(generate.n, 2)
        self.assertEqual(generate.format, None)
        self.assertEqual(generate.resample, "bilinear")

        edit = parser.parse_args(["edit", "--prompt", "retouch", "-i", "source.png", "-i", "second.png"])
        self.assertEqual(edit.image, ["source.png", "second.png"])
        self.assertIsNone(edit.mask)

        batch = parser.parse_args(["batch", "--input", "tasks.jsonl", "--out", "out"])
        self.assertEqual(batch.input, "tasks.jsonl")
        self.assertEqual(batch.out, "out")
        self.assertIsNone(batch.concurrency)

    def test_inspect_json_snapshot_has_v030_public_fields(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            image_path = Path(root) / "sample.png"
            write_png_rgba(image_path, 2, 1, [(255, 0, 0, 255), (0, 0, 0, 64)])
            payload = imagegen.inspect_image_file(image_path)

        self.assertEqual(
            set(payload),
            {
                "path",
                "format",
                "width",
                "height",
                "mode",
                "has_alpha",
                "sha256",
                "alpha_bbox",
                "alpha_coverage",
                "alpha_margins",
                "nontransparent_pixels",
                "semi_transparent_ratio",
                "corner_alpha",
                "edge_alpha",
            },
        )
        self.assertEqual(payload["format"], "png")
        self.assertEqual((payload["width"], payload["height"], payload["mode"]), (2, 1, "rgba"))
        self.assertTrue(payload["has_alpha"])
        self.assertEqual(payload["alpha_bbox"], [0, 0, 1, 0])
        self.assertRegex(payload["sha256"], r"^[0-9a-f]{64}$")

    def test_cli_exit_code_and_info_json_snapshot(self) -> None:
        cfg = SimpleNamespace(
            model="gpt-image-1",
            base_url="https://example.invalid/v1",
            user_agent="compat-test",
            defaults={"quality": "medium"},
            postprocess={"enabled": False},
            transparency=SimpleNamespace(
                default_route="prompt-alpha",
                prompt_only_allow=[],
                llm_assisted=SimpleNamespace(to_record=lambda: {"enabled": False}),
            ),
            url_download={"proxy_mode": "environment"},
            proxy={},
            api_key_source="env:IMAGE_API_KEY",
        )
        stdout = io.StringIO()
        with (
            patch.object(sys, "argv", ["imagegen", "info"]),
            patch.object(imagegen, "load_config", return_value=cfg),
            contextlib.redirect_stdout(stdout),
        ):
            self.assertEqual(imagegen.main(), 0)
        info = json.loads(stdout.getvalue())
        self.assertEqual(
            set(info),
            {
                "model",
                "base_url",
                "user_agent",
                "defaults",
                "postprocess",
                "transparency",
                "url_download",
                "proxy",
                "script_path",
                "auth_json",
                "api_key_source",
                "api_key",
            },
        )
        self.assertEqual(info["api_key"], "***REDACTED***")
        self.assertEqual(info["proxy"], {"configured": False})

        stderr = io.StringIO()
        with patch.object(sys, "argv", ["imagegen", "inspect-image", "missing.png"]), contextlib.redirect_stderr(stderr):
            self.assertEqual(imagegen.main(), 2)
        self.assertTrue(stderr.getvalue().startswith("error: "))

        stderr = io.StringIO()
        with (
            patch.object(sys, "argv", ["imagegen", "inspect-image", "ignored.png"]),
            patch.object(imagegen, "inspect_image_command", side_effect=RuntimeError("boom")),
            contextlib.redirect_stderr(stderr),
        ):
            self.assertEqual(imagegen.main(), 1)
        self.assertEqual(stderr.getvalue(), "error: unexpected failure: boom\n")

    def test_batch_manifest_json_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            out_dir = Path(root)
            output = out_dir / "image.png"
            output.write_bytes(b"png")
            results = [{"id": "task-1", "ok": True, "files": [str(output)]}]
            manifest_path, contract_ok = image_batch.write_manifest(out_dir, results)
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))

        self.assertTrue(contract_ok)
        self.assertRegex(payload["created_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$")
        self.assertEqual(set(payload), {"created_at", "output_root", "path_contract", "results", "summary"})
        self.assertEqual(payload["path_contract"]["status"], "pass")
        self.assertTrue(payload["path_contract"]["files_exist"])
        self.assertEqual(payload["path_contract"]["missing_files"], [])
        self.assertEqual(payload["results"], results)
        self.assertEqual(payload["summary"], {"total": 1, "ok": 1, "failed": 0})


if __name__ == "__main__":
    unittest.main()
