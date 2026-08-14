from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from tests.test_image_runtime import load_imagegen, make_png


class ImageRuntimeDeliveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.imagegen = load_imagegen()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.project_root = Path(self.temp_dir.name)
        self.artifact_root = self.project_root / "output" / "imagegen"
        self.repository = self.imagegen.ArtifactRepository(
            self.project_root,
            self.artifact_root,
        )
        self.cfg = self.imagegen.Config(
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
                "transparent_background": True,
            },
            postprocess={"enabled": False},
            user_agent="Imagegen-Test/1.0",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def store_source(self, width: int, height: int, prompt: str):
        return self.repository.store_images(
            images=[make_png(width, height)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt=prompt,
            parameters={},
        )[0]

    def deliver(self, source_id: str, delivery: dict):
        return self.imagegen.run_machine_task(
            {
                "operation": "deliver",
                "modelProfileId": "primary/gpt-image-2",
                "inputArtifactIds": [source_id],
                "delivery": delivery,
            },
            self.project_root,
            self.artifact_root,
            self.cfg,
        )

    def test_deliver_creates_an_immutable_derived_artifact_without_provider_request(self) -> None:
        source = self.store_source(2, 2, "source image")
        delivery = {
            "deliverySize": "4x4",
            "fit": "contain",
            "resample": "nearest",
            "safeMargin": 0.0,
            "qa": True,
        }

        with (
            mock.patch.object(self.imagegen, "request_json", side_effect=AssertionError("provider called")),
            mock.patch.object(self.imagegen, "request_multipart", side_effect=AssertionError("provider called")),
        ):
            result = self.deliver(source.metadata["id"], delivery)

        self.assertTrue(result["ok"], result)
        self.assertTrue(result["deliveryReady"])
        self.assertEqual(result["sourceArtifactId"], source.metadata["id"])
        self.assertEqual(result["qa"]["status"], "pass")
        self.assertEqual(len(result["artifacts"]), 1)
        derived = result["artifacts"][0]
        self.assertEqual((derived["width"], derived["height"]), (4, 4))
        self.assertEqual(derived["operation"], "derive")
        self.assertEqual(derived["derivedFrom"], source.metadata["id"])
        self.assertEqual(derived["deliveryKind"], "exact-size")
        self.assertEqual(derived["parentIds"], [])
        self.assertEqual(
            self.repository.get_artifact(source.metadata["id"]).metadata["childIds"],
            [],
        )
        encoded = json.dumps(result)
        self.assertNotIn("runtime-secret", encoded)
        self.assertNotIn(str(self.project_root), encoded)

    def test_deliver_qa_failure_preserves_source_without_publishing_derivatives(self) -> None:
        source = self.store_source(2, 2, "source image")
        with mock.patch.object(
            self.imagegen.image_delivery,
            "evaluate_delivery",
            return_value={
                "schema_version": "qa.v1",
                "status": "fail",
                "artifacts": [],
                "conditions": [],
                "errors": [],
            },
        ):
            result = self.deliver(
                source.metadata["id"],
                {"deliverySize": "4x4", "qa": True},
            )

        self.assertTrue(result["ok"], result)
        self.assertFalse(result["deliveryReady"])
        self.assertEqual(result["artifacts"], [])
        self.assertEqual(result["qa"]["status"], "fail")
        self.assertEqual(
            self.repository.get_artifact(source.metadata["id"]).metadata["childIds"],
            [],
        )

    def test_deliver_grid_publishes_independent_cells(self) -> None:
        source = self.store_source(4, 2, "grid source")
        result = self.deliver(
            source.metadata["id"],
            {
                "deliverySize": "2x2",
                "grid": "1x2",
                "expectedCount": 2,
                "qa": True,
            },
        )

        self.assertTrue(result["ok"], result)
        self.assertTrue(result["deliveryReady"])
        self.assertEqual(result["qa"]["status"], "pass")
        self.assertEqual(len(result["artifacts"]), 2)
        self.assertEqual(
            [item["deliveryKind"] for item in result["artifacts"]],
            ["grid-cell", "grid-cell"],
        )
        self.assertTrue(
            all(item["derivedFrom"] == source.metadata["id"] for item in result["artifacts"])
        )

    def test_deliver_preview_persists_one_sanitized_preview_board(self) -> None:
        source = self.store_source(2, 2, "preview source")
        result = self.deliver(
            source.metadata["id"],
            {
                "preview": {
                    "sizes": ["2x2", "4x2"],
                    "backgrounds": ["white", "checker"],
                    "resample": "nearest",
                },
                "qa": True,
            },
        )

        self.assertTrue(result["ok"], result)
        self.assertTrue(result["deliveryReady"])
        self.assertEqual(result["qa"]["status"], "pass")
        self.assertEqual(len(result["artifacts"]), 1)
        derived = result["artifacts"][0]
        self.assertEqual(derived["operation"], "derive")
        self.assertEqual(derived["deliveryKind"], "preview-board")
        self.assertEqual(derived["derivedFrom"], source.metadata["id"])
        self.assertEqual(
            derived["parameters"],
            {
                "previewSizes": [[2, 2], [4, 2]],
                "previewBackgrounds": ["white", "checker"],
                "resample": "nearest",
            },
        )
        reopened = self.repository.get_artifact(derived["id"])
        self.assertEqual(reopened.metadata, derived)
        self.assertTrue(reopened.image_bytes.startswith(self.imagegen.PNG_SIGNATURE))
        encoded = json.dumps(result)
        self.assertNotIn(str(self.project_root), encoded)
        self.assertNotIn("codex-image-delivery-", encoded)


if __name__ == "__main__":
    unittest.main()
