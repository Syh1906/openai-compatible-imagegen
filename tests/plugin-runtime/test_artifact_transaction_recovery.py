from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts.artifact_repository import ArtifactRepository
from tests.support.python_fixtures import make_png


class ArtifactTransactionRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.project_root = Path(self.temp_dir.name)
        self.artifact_root = self.project_root / "output" / "imagegen"
        self.repository = ArtifactRepository(self.project_root, self.artifact_root)
        self.repository.store_images(
            images=[make_png(2, 2)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt="baseline",
            parameters={},
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def create_marker(self, artifact_id: str, *, files: list[str] | None = None) -> Path:
        transaction_id = "txn_" + "e" * 64
        marker_dir = self.artifact_root / ".transactions" / transaction_id
        marker_dir.mkdir(parents=True)
        (marker_dir / "manifest.json").write_text(
            json.dumps({
                "version": 1,
                "resources": [{
                    "kind": "artifact",
                    "id": artifact_id,
                    "files": files or ["image.png", "meta.json"],
                }],
            }),
            encoding="utf-8",
        )
        return marker_dir

    def store_next(self) -> None:
        self.repository.store_images(
            images=[make_png(3, 3)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt="next",
            parameters={},
        )

    def test_next_mutation_removes_only_unindexed_resources_owned_by_a_marker(self) -> None:
        orphan_id = "img_01J00000000000000000000701"
        orphan_dir = self.artifact_root / "artifacts" / orphan_id
        orphan_dir.mkdir()
        (orphan_dir / "image.png").write_bytes(make_png(4, 4))
        (orphan_dir / "meta.json").write_text("{}", encoding="utf-8")
        marker_dir = self.create_marker(orphan_id)

        self.store_next()

        self.assertFalse(orphan_dir.exists())
        self.assertFalse(marker_dir.exists())

    def test_successful_mutation_leaves_no_pending_transaction_marker(self) -> None:
        self.store_next()

        transactions_root = self.artifact_root / ".transactions"
        self.assertTrue(transactions_root.is_dir())
        self.assertEqual(list(transactions_root.iterdir()), [])

    def test_committed_resource_survives_a_marker_left_after_index_commit(self) -> None:
        index = json.loads((self.artifact_root / "index.json").read_text(encoding="utf-8"))
        artifact_id = next(iter(index["artifacts"]))
        artifact_dir = self.artifact_root / "artifacts" / artifact_id
        marker_dir = self.create_marker(artifact_id)

        self.store_next()

        self.assertTrue(artifact_dir.is_dir())
        self.assertFalse(marker_dir.exists())

    def test_extended_format_recovery_cleans_orphans_and_preserves_committed_originals(self) -> None:
        originals = {
            "gif": bytes.fromhex("47494638396101000100800000000000ffffff2c00000000010001000002024401003b"),
            "svg": b'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>',
        }
        for fmt, original in originals.items():
            for committed in (False, True):
                with self.subTest(format=fmt, committed=committed):
                    if committed:
                        artifact = self.repository.store_response_images(images=[original], provider="test", model="image", operation="generate", prompt="", parameters={})[0]
                        artifact_id = artifact.metadata["id"]
                        directory = self.artifact_root / "artifacts" / artifact_id
                    else:
                        artifact_id = "img_01J00000000000000000000703"
                        directory = self.artifact_root / "artifacts" / artifact_id
                        directory.mkdir()
                        (directory / f"image.{fmt}").write_bytes(original)
                        (directory / "meta.json").write_text("{}", encoding="utf-8")
                    marker = self.create_marker(artifact_id, files=[f"image.{fmt}", "meta.json"])
                    self.store_next()
                    self.assertFalse(marker.exists())
                    self.assertEqual(directory.exists(), committed)
                    if committed:
                        self.assertEqual(self.repository.get_artifact(artifact_id).image_bytes, original)

    def test_recovery_refuses_to_delete_an_orphan_directory_with_unknown_files(self) -> None:
        orphan_id = "img_01J00000000000000000000702"
        orphan_dir = self.artifact_root / "artifacts" / orphan_id
        orphan_dir.mkdir()
        (orphan_dir / "image.png").write_bytes(make_png(4, 4))
        (orphan_dir / "meta.json").write_text("{}", encoding="utf-8")
        (orphan_dir / "unexpected.bin").write_bytes(b"do not delete")
        marker_dir = self.create_marker(orphan_id)

        with self.assertRaisesRegex(OSError, "unknown entries"):
            self.store_next()

        self.assertTrue(orphan_dir.is_dir())
        self.assertTrue(marker_dir.is_dir())

    def test_receipt_only_crash_does_not_leave_an_empty_file_transaction(self) -> None:
        index = json.loads((self.artifact_root / "index.json").read_text(encoding="utf-8"))
        source_id = next(iter(index["artifacts"]))
        receipt_id = "delivery_" + "d" * 64

        with mock.patch.object(
            self.repository,
            "_store_images_locked",
            side_effect=RuntimeError("simulated receipt commit crash"),
        ):
            with self.assertRaisesRegex(RuntimeError, "simulated receipt commit crash"):
                self.repository.store_derived_images(
                    images=[],
                    mime_type="image/png",
                    derived_from=source_id,
                    delivery_kinds=[],
                    parameters=[],
                    receipt_id=receipt_id,
                    receipt={"sourceArtifactId": source_id, "artifacts": []},
                )

        self.store_next()

    def test_recovery_rejects_a_partially_indexed_multi_resource_transaction(self) -> None:
        index = json.loads((self.artifact_root / "index.json").read_text(encoding="utf-8"))
        committed_id = next(iter(index["artifacts"]))
        orphan_id = "img_01J00000000000000000000703"
        orphan_dir = self.artifact_root / "artifacts" / orphan_id
        orphan_dir.mkdir()
        (orphan_dir / "image.png").write_bytes(make_png(4, 4))
        (orphan_dir / "meta.json").write_text("{}", encoding="utf-8")
        marker_dir = self.artifact_root / ".transactions" / ("txn_" + "f" * 64)
        marker_dir.mkdir(parents=True)
        (marker_dir / "manifest.json").write_text(json.dumps({
            "version": 1,
            "resources": [
                {"kind": "artifact", "id": committed_id, "files": ["image.png", "meta.json"]},
                {"kind": "artifact", "id": orphan_id, "files": ["image.png", "meta.json"]},
            ],
        }), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "partially committed"):
            self.store_next()

        self.assertTrue(orphan_dir.is_dir())
        self.assertTrue(marker_dir.is_dir())

    def test_recovery_rejects_an_empty_transaction_resource_list(self) -> None:
        marker_dir = self.artifact_root / ".transactions" / ("txn_" + "a" * 64)
        marker_dir.mkdir(parents=True)
        (marker_dir / "manifest.json").write_text(
            json.dumps({"version": 1, "resources": []}),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(ValueError, "resources are invalid"):
            self.store_next()

        self.assertTrue(marker_dir.is_dir())

    def test_recovery_rejects_unknown_entries_in_the_transaction_root(self) -> None:
        transactions_root = self.artifact_root / ".transactions"
        transactions_root.mkdir(parents=True, exist_ok=True)
        unknown = transactions_root / "unexpected.txt"
        unknown.write_text("do not delete", encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "unknown entry"):
            self.store_next()

        self.assertTrue(unknown.is_file())

    def test_recovery_rejects_a_broken_resource_symlink(self) -> None:
        orphan_id = "img_01J00000000000000000000704"
        orphan_dir = self.artifact_root / "artifacts" / orphan_id
        try:
            orphan_dir.symlink_to(
                self.project_root / "missing-outside-resource",
                target_is_directory=True,
            )
        except OSError as exc:
            self.skipTest(f"creating Windows directory links is unavailable: {exc}")
        marker_dir = self.create_marker(orphan_id)

        with self.assertRaisesRegex(ValueError, "reparse point"):
            self.store_next()

        self.assertTrue(orphan_dir.is_symlink())
        self.assertTrue(marker_dir.is_dir())

    def test_recovery_rejects_a_broken_marker_symlink(self) -> None:
        marker_dir = self.artifact_root / ".transactions" / ("txn_" + "b" * 64)
        marker_dir.parent.mkdir(parents=True, exist_ok=True)
        try:
            marker_dir.symlink_to(
                self.project_root / "missing-outside-marker",
                target_is_directory=True,
            )
        except OSError as exc:
            self.skipTest(f"creating Windows directory links is unavailable: {exc}")

        with self.assertRaisesRegex(ValueError, "reparse point"):
            self.store_next()

        self.assertTrue(marker_dir.is_symlink())


if __name__ == "__main__":
    unittest.main()
