from __future__ import annotations

import base64
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import zlib


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "image_runtime.py"


def load_runtime():
    module_name = "plugin_response_publication_under_test"
    spec = importlib.util.spec_from_file_location(module_name, SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load image_runtime.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def png_chunk(kind: bytes, data: bytes) -> bytes:
    checksum = zlib.crc32(kind + data) & 0xFFFFFFFF
    return len(data).to_bytes(4, "big") + kind + data + checksum.to_bytes(4, "big")


def make_png(width: int, height: int) -> bytes:
    rows = b"".join(b"\x00" + bytes((40, 120, 220, 255)) * width for _ in range(height))
    ihdr = width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00"
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", zlib.compress(rows))
        + png_chunk(b"IEND", b"")
    )


def malformed_png(width: int, height: int) -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n"
        + (13).to_bytes(4, "big")
        + b"IHDR"
        + width.to_bytes(4, "big")
        + height.to_bytes(4, "big")
    )


VALID_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUEBAUEAwUFBAUGBgUGCA4JCAcHCBEMDQoOFBEVFBMRExMWGB8bFhceFxMTGyUcHiAhIyMjFRomKSYiKR8iIyL/"
    "2wBDAQYGBggHCBAJCRAiFhMWIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiL/wgARCAADAAIDASIAAhEBAxEB/"
    "8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUAQEAAAAAAAAAAAAAAAAAAAAD/9oADAMBAAIQAxAAAAGThD//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAn//"
    "xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/An//"
    "xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEAv/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/"
    "9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q=="
)


class PluginResponsePublicationTests(unittest.TestCase):
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

    def task(self, count: int, *, batch: bool) -> dict:
        task = {
            "operation": "generate",
            "modelProfileId": "primary/gpt-image-2",
            "prompt": "response publication contract",
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
        if batch:
            task["executionMode"] = "batch-item"
        return task

    def edit_task(self, parent_id: str, count: int, *, batch: bool) -> dict:
        task = self.task(count, batch=batch)
        task.update({
            "operation": "edit",
            "inputArtifactIds": [parent_id],
        })
        return task

    def store_parent(self) -> str:
        repository = self.runtime.ArtifactRepository(self.project_root, self.artifact_root)
        return repository.store_response_images(
            images=[make_png(4, 4)],
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt="parent",
            parameters={},
        )[0].metadata["id"]

    @staticmethod
    def response(*images: bytes) -> dict:
        return {
            "data": [
                {"b64_json": base64.b64encode(image).decode("ascii")}
                for image in images
            ]
        }

    def test_batch_item_preserves_valid_original_when_later_item_is_malformed(self) -> None:
        response = self.response(make_png(3, 2), malformed_png(5, 4))
        with mock.patch.object(self.runtime, "request_json", return_value=response) as request:
            result = self.runtime.run_machine_task(
                self.task(2, batch=True),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )

        self.assertTrue(result["ok"], result)
        self.assertEqual(len(result["artifacts"]), 1)
        self.assertEqual(result["apiDelivery"]["status"], "partial")
        self.assertEqual(result["apiDelivery"]["requestedCount"], 2)
        self.assertEqual(result["apiDelivery"]["returnedCount"], 2)
        self.assertEqual(result["apiDelivery"]["publishedCount"], 1)
        self.assertIn(
            {"code": "item_unusable", "responseIndex": 2},
            result["apiDelivery"]["issues"],
        )
        request.assert_called_once()
        index = json.loads((self.artifact_root / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(len(index["artifacts"]), 1)

    def test_ordinary_candidates_reject_malformed_item_without_publishing_group(self) -> None:
        responses = [
            self.response(make_png(3, 2)),
            self.response(malformed_png(5, 4)),
        ]
        with mock.patch.object(self.runtime, "request_json", side_effect=responses):
            result = self.runtime.run_machine_task(
                self.task(2, batch=False),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "image_task_failed")
        self.assertFalse((self.artifact_root / "index.json").exists())

    def test_batch_item_edit_sends_one_multipart_request_and_keeps_valid_items(self) -> None:
        parent_id = self.store_parent()
        response = self.response(make_png(3, 2), malformed_png(5, 4))
        with mock.patch.object(self.runtime, "request_multipart", return_value=response) as request:
            result = self.runtime.run_machine_task(
                self.edit_task(parent_id, 2, batch=True),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )

        self.assertTrue(result["ok"], result)
        self.assertEqual(len(result["artifacts"]), 1)
        self.assertEqual(result["apiDelivery"]["status"], "partial")
        self.assertEqual(result["apiDelivery"]["publishedCount"], 1)
        request.assert_called_once()
        self.assertEqual(request.call_args.args[2]["n"], 2)
        index = json.loads((self.artifact_root / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(len(index["artifacts"]), 2)

    def test_ordinary_edit_rejects_a_malformed_candidate_without_publishing_the_group(self) -> None:
        parent_id = self.store_parent()
        response = self.response(make_png(3, 2), malformed_png(5, 4))
        with mock.patch.object(self.runtime, "request_multipart", return_value=response) as request:
            result = self.runtime.run_machine_task(
                self.edit_task(parent_id, 2, batch=False),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "image_task_failed")
        request.assert_called_once()
        self.assertEqual(request.call_args.args[2]["n"], 2)
        index = json.loads((self.artifact_root / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(list(index["artifacts"]), [parent_id])

    def test_provider_actual_format_is_stored_instead_of_requested_format(self) -> None:
        with mock.patch.object(
            self.runtime,
            "request_json",
            return_value=self.response(VALID_JPEG),
        ):
            result = self.runtime.run_machine_task(
                self.task(1, batch=False),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )

        self.assertTrue(result["ok"], result)
        artifact = result["artifacts"][0]
        self.assertEqual(artifact["mimeType"], "image/jpeg")
        self.assertEqual((artifact["width"], artifact["height"]), (2, 3))
        self.assertTrue(
            (self.artifact_root / "artifacts" / artifact["id"] / "image.jpg").is_file()
        )

    def test_repository_rejects_png_with_only_a_plausible_header(self) -> None:
        repository = self.runtime.ArtifactRepository(self.project_root, self.artifact_root)
        with self.assertRaisesRegex(ValueError, "complete PNG"):
            repository.store_images(
                images=[malformed_png(2, 3)],
                mime_type="image/png",
                provider="primary",
                model="gpt-image-2",
                operation="generate",
                prompt="invalid image",
                parameters={},
            )
        self.assertFalse((self.artifact_root / "index.json").exists())


if __name__ == "__main__":
    unittest.main()
