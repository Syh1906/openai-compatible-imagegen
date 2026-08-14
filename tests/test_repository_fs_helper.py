from __future__ import annotations

import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


IMAGE_ID = "img_01J00000000000000000000000"
ANNOTATION_ID = "ann_01J00000000000000000000000"


class RepositoryFsHelperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.repository = Path(self.temp_dir.name) / "imagegen"
        artifact_dir = self.repository / "artifacts" / IMAGE_ID
        artifact_dir.mkdir(parents=True)
        (artifact_dir / "image.png").write_bytes(b"image")
        (self.repository / "index.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "artifacts": {
                        IMAGE_ID: {
                            "id": IMAGE_ID,
                            "parentIds": [],
                            "mimeType": "image/png",
                            "width": 1,
                            "height": 1,
                            "imageFile": "image.png",
                        }
                    },
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_reads_artifact_and_annotation_from_verified_handles(self) -> None:
        from scripts.repository_fs_helper import read_annotation, read_artifact

        artifact = read_artifact(self.repository, IMAGE_ID)
        self.assertEqual(base64.b64decode(artifact["dataBase64"]), b"image")
        self.assertEqual(artifact["metadata"]["id"], IMAGE_ID)

        record = self._record(mask=True)
        self._write_annotation_fixture(record, mask=True)
        self.assertEqual(read_annotation(self.repository, ANNOTATION_ID), record)

    def test_artifact_index_and_image_share_one_directory_lease(self) -> None:
        from scripts import repository_fs_helper as helper

        original_lease = helper.DirectoryLease
        with mock.patch.object(
            helper,
            "DirectoryLease",
            side_effect=original_lease,
        ) as lease_factory:
            artifact = helper.read_artifact(self.repository, IMAGE_ID)

        self.assertEqual(base64.b64decode(artifact["dataBase64"]), b"image")
        lease_factory.assert_called_once_with(self.repository)

    def test_annotation_record_and_derivatives_share_one_directory_lease(self) -> None:
        from scripts import repository_fs_helper as helper

        record = self._record(mask=True)
        self._write_annotation_fixture(record, mask=True)
        original_lease = helper.DirectoryLease
        with mock.patch.object(
            helper,
            "DirectoryLease",
            side_effect=original_lease,
        ) as lease_factory:
            self.assertEqual(helper.read_annotation(self.repository, ANNOTATION_ID), record)

        lease_factory.assert_called_once_with(self.repository)

    def test_saves_and_deletes_only_the_known_annotation_files(self) -> None:
        from scripts.repository_fs_helper import (
            delete_annotation,
            read_annotation,
            save_annotation_files,
        )

        record = self._record(mask=True)
        save_annotation_files(
            self.repository,
            ANNOTATION_ID,
            b"preview",
            b"mask",
            record,
        )
        self.assertEqual(read_annotation(self.repository, ANNOTATION_ID), record)

        delete_annotation(self.repository, ANNOTATION_ID)
        self.assertFalse((self.repository / "annotations" / ANNOTATION_ID).exists())

    def test_failed_annotation_publish_rolls_back_only_its_new_directory(self) -> None:
        from scripts import repository_fs_helper as helper

        original_publish = helper.RepositoryMutation.publish_new_file

        def fail_record(mutation, relative_path, data):
            if Path(relative_path).name == "annotation.json":
                raise OSError("record publish failed")
            return original_publish(mutation, relative_path, data)

        with mock.patch.object(
            helper.RepositoryMutation,
            "publish_new_file",
            autospec=True,
            side_effect=fail_record,
        ):
            with self.assertRaisesRegex(OSError, "record publish failed"):
                helper.save_annotation_files(
                    self.repository,
                    ANNOTATION_ID,
                    b"preview",
                    None,
                    self._record(mask=False),
                )

        self.assertFalse((self.repository / "annotations" / ANNOTATION_ID).exists())

    def test_failed_annotation_publish_rolls_back_inside_the_same_mutation(self) -> None:
        from scripts import repository_fs_helper as helper

        original_mutation = helper.RepositoryMutation
        instances = []

        class FailingMutation(original_mutation):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                instances.append(self)

            def publish_new_file(self, relative_path, data):
                if Path(relative_path).name == "annotation.json":
                    raise OSError("record publish failed")
                return super().publish_new_file(relative_path, data)

        with mock.patch.object(helper, "RepositoryMutation", FailingMutation):
            with self.assertRaisesRegex(OSError, "record publish failed"):
                helper.save_annotation_files(
                    self.repository,
                    ANNOTATION_ID,
                    b"preview",
                    None,
                    self._record(mask=False),
                )

        self.assertEqual(len(instances), 1)
        self.assertFalse((self.repository / "annotations" / ANNOTATION_ID).exists())

    def test_delete_validates_and_removes_annotation_inside_one_mutation(self) -> None:
        from scripts import repository_fs_helper as helper

        record = self._record(mask=True)
        self._write_annotation_fixture(record, mask=True)
        events = []
        original_mutation = helper.RepositoryMutation

        class TrackingMutation(original_mutation):
            def __enter__(self):
                events.append("mutation-enter")
                return super().__enter__()

            def remove_directory_if_known(self, relative_path, known_files):
                events.append("remove")
                return super().remove_directory_if_known(relative_path, known_files)

            def __exit__(self, exc_type, exc_value, traceback):
                events.append("mutation-exit")
                return super().__exit__(exc_type, exc_value, traceback)

        with mock.patch.object(helper, "RepositoryMutation", TrackingMutation):
            helper.delete_annotation(self.repository, ANNOTATION_ID)

        self.assertEqual(
            events,
            ["mutation-enter", "remove", "mutation-exit"],
        )
        self.assertFalse((self.repository / "annotations" / ANNOTATION_ID).exists())

    def test_delete_reads_record_and_derivatives_through_the_same_mutation(self) -> None:
        from scripts import repository_fs_helper as helper

        record = self._record(mask=True)
        self._write_annotation_fixture(record, mask=True)
        original_mutation = helper.RepositoryMutation
        opened_files = []

        class TrackingMutation(original_mutation):
            def open_file(self, relative_path, *, protect_from_rename=False):
                opened_files.append(Path(relative_path))
                return super().open_file(
                    relative_path,
                    protect_from_rename=protect_from_rename,
                )

        with (
            mock.patch.object(helper, "RepositoryMutation", TrackingMutation),
            mock.patch.object(
                helper,
                "DirectoryLease",
                side_effect=AssertionError("delete must not open an independent lease"),
            ),
        ):
            helper.delete_annotation(self.repository, ANNOTATION_ID)

        root = Path("annotations") / ANNOTATION_ID
        self.assertEqual(
            opened_files,
            [root / "annotation.json", root / "preview.svg", root / "mask.png"],
        )
        self.assertFalse((self.repository / root).exists())

    def test_id_collision_preserves_the_existing_annotation(self) -> None:
        from scripts.repository_fs_helper import save_annotation_files

        original = self._record(mask=False)
        self._write_annotation_fixture(original, mask=False)
        record_path = self.repository / "annotations" / ANNOTATION_ID / "annotation.json"
        original_snapshot = record_path.read_bytes()

        with self.assertRaises(OSError):
            save_annotation_files(
                self.repository,
                ANNOTATION_ID,
                b"replacement preview",
                None,
                {**original, "createdAt": "replacement"},
            )

        self.assertEqual(record_path.read_bytes(), original_snapshot)

    def _record(self, *, mask: bool) -> dict[str, object]:
        return {
            "id": ANNOTATION_ID,
            "imageId": IMAGE_ID,
            "items": [{"id": "rect-1", "type": "rectangle"}],
            "previewFile": "preview.svg",
            "previewMimeType": "image/svg+xml",
            "maskFile": "mask.png" if mask else None,
            "maskMimeType": "image/png" if mask else None,
            "maskPolicy": None,
            "createdAt": "2026-08-14T00:00:00.000Z",
        }

    def _write_annotation_fixture(self, record: dict[str, object], *, mask: bool) -> None:
        root = self.repository / "annotations" / ANNOTATION_ID
        root.mkdir(parents=True)
        (root / "preview.svg").write_bytes(b"preview")
        if mask:
            (root / "mask.png").write_bytes(b"mask")
        (root / "annotation.json").write_text(json.dumps(record), encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
