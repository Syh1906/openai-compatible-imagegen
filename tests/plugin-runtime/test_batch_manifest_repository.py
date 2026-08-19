from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from scripts.artifact_repository import ArtifactRepository
from tests.support.python_fixtures import load_imagegen, make_png


class BatchManifestRepositoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.project_root = Path(self.temp_dir.name)
        self.artifact_root = self.project_root / "output" / "imagegen"
        self.repository = ArtifactRepository(self.project_root, self.artifact_root)
        self.source = self.repository.store_images(
            images=[make_png(4, 4)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt="source",
            parameters={},
        )[0]
        self.receipt_id = "delivery_" + "a" * 64
        self.derived = self.repository.store_derived_images(
            images=[make_png(8, 8)],
            mime_type="image/png",
            derived_from=self.source.metadata["id"],
            delivery_kinds=["exact-size"],
            parameters=[{"deliverySize": "8x8"}],
            receipt_id=self.receipt_id,
            receipt={
                "sourceArtifactId": self.source.metadata["id"],
                "deliveryReady": True,
                "qa": {"schema_version": "qa.v1", "status": "pass"},
                "warnings": [],
                "summary": {"source": {"format": "png", "width": 4, "height": 4}},
            },
        )[0]

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def manifest(self) -> dict:
        source_id = self.source.metadata["id"]
        return {
            "schemaVersion": "batch-manifest.v1",
            "summary": {
                "total": 1,
                "succeeded": 1,
                "failed": 0,
                "artifactCount": 1,
            },
            "results": [{
                "requestId": "generate-a",
                "operation": "generate",
                "ok": True,
                "artifactIds": [source_id],
                "apiDelivery": {
                    "status": "published",
                    "requestedCount": 1,
                    "returnedCount": 1,
                    "publishedCount": 1,
                    "items": [{
                        "responseIndex": 1,
                        "artifactId": source_id,
                        "actualFormat": "png",
                        "width": 4,
                        "height": 4,
                    }],
                    "issues": [],
                },
                "deliveryReceiptIds": [self.receipt_id],
                "deliveryArtifactIds": [self.derived.metadata["id"]],
            }],
        }

    def stored_manifest_path(self) -> tuple[dict, Path]:
        stored = self.repository.store_batch_manifest(self.manifest())
        return stored, self.artifact_root / "batches" / stored["batchId"] / "manifest.json"

    def test_manifest_is_immutable_and_can_be_read_by_stable_batch_id(self) -> None:
        stored = self.repository.store_batch_manifest(self.manifest())

        self.assertRegex(stored["batchId"], r"^batch_[0-9A-HJKMNP-TV-Z]{26}$")
        self.assertRegex(stored["createdAt"], r"Z$")
        manifest_path = self.artifact_root / "batches" / stored["batchId"] / "manifest.json"
        self.assertTrue(manifest_path.is_file())
        self.assertEqual(
            json.loads(manifest_path.read_text(encoding="utf-8")),
            stored,
        )

        stored["results"][0]["artifactIds"].clear()
        recovered = self.repository.get_batch_manifest(stored["batchId"])
        self.assertEqual(recovered["results"][0]["artifactIds"], [self.source.metadata["id"]])
        self.assertEqual(recovered["results"][0]["deliveryReceiptIds"], [self.receipt_id])

    def test_manifest_rejects_missing_artifact_without_changing_the_index(self) -> None:
        before = (self.artifact_root / "index.json").read_bytes()
        manifest = self.manifest()
        missing_id = "img_01J00000000000000000000999"
        manifest["results"][0]["artifactIds"] = [missing_id]
        manifest["results"][0]["apiDelivery"]["items"][0]["artifactId"] = missing_id

        with self.assertRaisesRegex(KeyError, "artifact not found"):
            self.repository.store_batch_manifest(manifest)

        self.assertEqual((self.artifact_root / "index.json").read_bytes(), before)
        self.assertFalse((self.artifact_root / "batches").exists())

    def test_manifest_rejects_unknown_fields(self) -> None:
        manifest = self.manifest()
        manifest["privatePath"] = "C:/Users/private/manifest.json"

        with self.assertRaisesRegex(ValueError, "manifest fields"):
            self.repository.store_batch_manifest(manifest)

    def test_delivery_receipt_source_must_match_the_derived_artifact(self) -> None:
        other_source = self.repository.store_images(
            images=[make_png(5, 5)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt="other source",
            parameters={},
        )[0]

        with self.assertRaisesRegex(ValueError, "receipt source"):
            self.repository.store_derived_images(
                images=[make_png(6, 6)],
                mime_type="image/png",
                derived_from=other_source.metadata["id"],
                delivery_kinds=["exact-size"],
                parameters=[{"deliverySize": "6x6"}],
                receipt_id="delivery_" + "b" * 64,
                receipt={
                    "sourceArtifactId": self.source.metadata["id"],
                    "deliveryReady": True,
                },
            )

    def test_delivery_receipt_read_rejects_a_tampered_source_relationship(self) -> None:
        other_source = self.repository.store_images(
            images=[make_png(5, 5)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt="other source",
            parameters={},
        )[0]
        index_path = self.artifact_root / "index.json"
        index = json.loads(index_path.read_text(encoding="utf-8"))
        index["deliveryReceipts"][self.receipt_id]["sourceArtifactId"] = other_source.metadata["id"]
        index_path.write_text(json.dumps(index), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "receipt source"):
            self.repository.get_delivery_receipt(self.receipt_id)

    def test_manifest_rejects_delivery_records_from_an_unrelated_source(self) -> None:
        other_source = self.repository.store_images(
            images=[make_png(5, 5)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt="other source",
            parameters={},
        )[0]
        other_receipt_id = "delivery_" + "c" * 64
        other_derived = self.repository.store_derived_images(
            images=[make_png(7, 7)],
            mime_type="image/png",
            derived_from=other_source.metadata["id"],
            delivery_kinds=["exact-size"],
            parameters=[{"deliverySize": "7x7"}],
            receipt_id=other_receipt_id,
            receipt={
                "sourceArtifactId": other_source.metadata["id"],
                "deliveryReady": True,
            },
        )[0]
        manifest = self.manifest()
        manifest["results"][0]["deliveryReceiptIds"] = [other_receipt_id]
        manifest["results"][0]["deliveryArtifactIds"] = [other_derived.metadata["id"]]

        with self.assertRaisesRegex(ValueError, "unrelated source"):
            self.repository.store_batch_manifest(manifest)

    def test_manifest_api_delivery_items_must_match_published_artifacts(self) -> None:
        second_source = self.repository.store_images(
            images=[make_png(5, 5)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt="second source",
            parameters={},
        )[0]
        manifest = self.manifest()
        source_id = self.source.metadata["id"]
        manifest["summary"]["artifactCount"] = 2
        manifest["results"][0]["artifactIds"] = [source_id, second_source.metadata["id"]]
        manifest["results"][0]["apiDelivery"].update({
            "requestedCount": 2,
            "returnedCount": 2,
            "publishedCount": 2,
        })
        manifest["results"][0]["apiDelivery"]["items"] = [
            {
                "responseIndex": 1,
                "artifactId": source_id,
                "actualFormat": "png",
                "width": 4,
                "height": 4,
            },
            {
                "responseIndex": 1,
                "artifactId": source_id,
                "actualFormat": "png",
                "width": 4,
                "height": 4,
            },
        ]

        with self.assertRaisesRegex(ValueError, "API delivery items"):
            self.repository.store_batch_manifest(manifest)

    def test_manifest_api_delivery_status_must_match_counts_and_issues(self) -> None:
        manifest = self.manifest()
        manifest["results"][0]["apiDelivery"]["returnedCount"] = 2
        manifest["results"][0]["apiDelivery"]["issues"] = [{"code": "count_mismatch"}]

        with self.assertRaisesRegex(ValueError, "API delivery status"):
            self.repository.store_batch_manifest(manifest)

    def test_manifest_read_rejects_a_tampered_summary(self) -> None:
        stored, manifest_path = self.stored_manifest_path()
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        payload["summary"]["artifactCount"] = 2
        manifest_path.write_text(json.dumps(payload), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "summary"):
            self.repository.get_batch_manifest(stored["batchId"])

    def test_manifest_read_rejects_an_artifact_from_an_unrelated_source(self) -> None:
        other_source = self.repository.store_images(
            images=[make_png(5, 5)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt="other source",
            parameters={},
        )[0]
        stored, manifest_path = self.stored_manifest_path()
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        payload["results"][0]["artifactIds"] = [other_source.metadata["id"]]
        payload["results"][0]["apiDelivery"]["items"][0]["artifactId"] = other_source.metadata["id"]
        manifest_path.write_text(json.dumps(payload), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "unrelated source"):
            self.repository.get_batch_manifest(stored["batchId"])

    def test_manifest_read_rejects_delivery_receipts_that_do_not_match_the_index(self) -> None:
        other_receipt_id = "delivery_" + "d" * 64
        stored, manifest_path = self.stored_manifest_path()
        index_path = self.artifact_root / "index.json"
        index = json.loads(index_path.read_text(encoding="utf-8"))
        index["deliveryReceipts"][other_receipt_id] = dict(
            index["deliveryReceipts"][self.receipt_id]
        )
        index_path.write_text(json.dumps(index), encoding="utf-8")
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        payload["results"][0]["deliveryReceiptIds"] = [other_receipt_id]
        manifest_path.write_text(json.dumps(payload), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "delivery receipt IDs do not match index"):
            self.repository.get_batch_manifest(stored["batchId"])

    def test_manifest_read_rejects_result_artifacts_that_do_not_match_the_index(self) -> None:
        stored, _ = self.stored_manifest_path()
        index_path = self.artifact_root / "index.json"
        index = json.loads(index_path.read_text(encoding="utf-8"))
        index["batchManifests"][stored["batchId"]]["artifactIds"] = [
            self.source.metadata["id"],
        ]
        index_path.write_text(json.dumps(index), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "artifact IDs do not match index"):
            self.repository.get_batch_manifest(stored["batchId"])


class BatchManifestRuntimeTests(BatchManifestRepositoryTests):
    def setUp(self) -> None:
        super().setUp()
        self.runtime = load_imagegen()
        self.cfg = self.runtime.Config(
            base_url="https://images.example.test/v1",
            api_key="runtime-secret",
            api_key_source="test",
            model="gpt-image-2",
            defaults={},
            capabilities={"generate": True, "edit": True},
            postprocess={"enabled": True},
            user_agent="Imagegen-Test/1.0",
        )

    def test_runtime_records_and_reads_the_same_batch_manifest(self) -> None:
        recorded = self.runtime.run_machine_task(
            {
                "operation": "record_batch",
                "modelProfileId": "primary/gpt-image-2",
                "manifest": self.manifest(),
            },
            self.project_root,
            self.artifact_root,
            self.cfg,
        )

        self.assertTrue(recorded["ok"], recorded)
        recovered = self.runtime.run_machine_task(
            {
                "operation": "get_batch_manifest",
                "modelProfileId": "primary/gpt-image-2",
                "batchId": recorded["manifest"]["batchId"],
            },
            self.project_root,
            self.artifact_root,
            self.cfg,
        )
        self.assertTrue(recovered["ok"], recovered)
        self.assertEqual(recovered["manifest"], recorded["manifest"])


if __name__ == "__main__":
    unittest.main()
