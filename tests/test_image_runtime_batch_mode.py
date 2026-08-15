from __future__ import annotations

import base64
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import zlib


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "image_runtime.py"


def load_runtime():
    module_name = "image_runtime_batch_mode_under_test"
    spec = importlib.util.spec_from_file_location(module_name, SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load image_runtime.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def make_png(width: int, height: int) -> bytes:
    raw = bytearray()
    for _ in range(height):
        raw.append(0)
        raw.extend((0, 128, 255, 255) * width)

    def chunk(kind: bytes, data: bytes) -> bytes:
        checksum = zlib.crc32(kind + data) & 0xFFFFFFFF
        return len(data).to_bytes(4, "big") + kind + data + checksum.to_bytes(4, "big")

    return b"\x89PNG\r\n\x1a\n" + b"".join(
        [
            chunk(
                b"IHDR",
                width.to_bytes(4, "big")
                + height.to_bytes(4, "big")
                + b"\x08\x06\x00\x00\x00",
            ),
            chunk(b"IDAT", zlib.compress(bytes(raw))),
            chunk(b"IEND", b""),
        ]
    )


class ImageRuntimeBatchExecutionModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime = load_runtime()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.project_root = Path(self.temp_dir.name)
        self.artifact_root = self.project_root / "output" / "imagegen"
        self.cfg = self.runtime.Config(
            base_url="https://images.example.test/v1",
            api_key="runtime-secret",
            api_key_source="test",
            model="gpt-image-2",
            defaults={},
            capabilities={
                "generate": True,
                "edit": True,
                "mask": False,
                "multi_reference": True,
            },
            postprocess={"enabled": False},
            user_agent="Imagegen-Test/1.0",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def task(self, count: int, *, execution_mode: object = "batch-item") -> dict:
        return {
            "operation": "generate",
            "executionMode": execution_mode,
            "modelProfileId": "primary/gpt-image-2",
            "prompt": "batch candidates",
            "inputArtifactIds": [],
            "annotationId": None,
            "output": {
                "size": "1024x1024",
                "quality": "high",
                "format": "png",
                "count": count,
                "background": "opaque",
            },
        }

    @staticmethod
    def response(count: int) -> dict:
        return {
            "data": [
                {"b64_json": base64.b64encode(make_png(index + 1, 1)).decode("ascii")}
                for index in range(count)
            ]
        }

    def test_batch_item_generate_sends_one_provider_request_with_requested_n(self) -> None:
        task = self.task(3)
        with mock.patch.object(
            self.runtime,
            "request_json",
            return_value=self.response(3),
        ) as request:
            result = self.runtime.run_machine_task(
                task,
                self.project_root,
                self.artifact_root,
                self.cfg,
            )

        self.assertTrue(result["ok"], result)
        self.assertEqual(len(result["artifacts"]), 3)
        request.assert_called_once()
        self.assertEqual(request.call_args.args[2]["n"], 3)

    def test_batch_item_generate_allows_sixteen_images(self) -> None:
        task = self.task(16)
        with mock.patch.object(
            self.runtime,
            "request_json",
            return_value=self.response(16),
        ) as request:
            result = self.runtime.run_machine_task(
                task,
                self.project_root,
                self.artifact_root,
                self.cfg,
            )

        self.assertTrue(result["ok"], result)
        self.assertEqual(len(result["artifacts"]), 16)
        request.assert_called_once()
        self.assertEqual(request.call_args.args[2]["n"], 16)

    def test_batch_item_generate_caps_extra_response_items_and_reports_mismatch(self) -> None:
        task = self.task(3)
        with mock.patch.object(
            self.runtime,
            "request_json",
            return_value=self.response(4),
        ) as request:
            result = self.runtime.run_machine_task(
                task,
                self.project_root,
                self.artifact_root,
                self.cfg,
            )

        self.assertTrue(result["ok"], result)
        self.assertEqual(len(result["artifacts"]), 3)
        self.assertEqual(result["apiDelivery"]["status"], "published_with_warnings")
        self.assertEqual(result["apiDelivery"]["returnedCount"], 4)
        self.assertIn({"code": "count_mismatch"}, result["apiDelivery"]["issues"])
        request.assert_called_once()
        self.assertTrue((self.artifact_root / "index.json").is_file())

    def test_invalid_execution_modes_are_rejected_before_provider_request(self) -> None:
        for execution_mode in (None, "", "interactive-batch", 1):
            with self.subTest(execution_mode=execution_mode):
                task = self.task(1, execution_mode=execution_mode)
                with mock.patch.object(self.runtime, "request_json") as request:
                    result = self.runtime.run_machine_task(
                        task,
                        self.project_root,
                        self.artifact_root,
                        self.cfg,
                    )

                self.assertFalse(result["ok"])
                self.assertEqual(result["error"]["code"], "invalid_task")
                self.assertIn("executionMode", result["error"]["message"])
                request.assert_not_called()

    def test_batch_item_count_outside_one_to_sixteen_is_rejected_before_provider(self) -> None:
        for count in (0, 17):
            with self.subTest(count=count):
                with mock.patch.object(self.runtime, "request_json") as request:
                    result = self.runtime.run_machine_task(
                        self.task(count),
                        self.project_root,
                        self.artifact_root,
                        self.cfg,
                    )

                self.assertFalse(result["ok"])
                self.assertEqual(result["error"]["code"], "invalid_task")
                self.assertIn("between 1 and 16", result["error"]["message"])
                request.assert_not_called()

    def test_ordinary_generate_keeps_ten_image_limit(self) -> None:
        task = self.task(11)
        task.pop("executionMode")
        with mock.patch.object(self.runtime, "request_json") as request:
            result = self.runtime.run_machine_task(
                task,
                self.project_root,
                self.artifact_root,
                self.cfg,
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "invalid_task")
        self.assertIn("between 1 and 10", result["error"]["message"])
        request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
