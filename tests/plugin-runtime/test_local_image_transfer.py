from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tests.support.python_fixtures import make_png


class LocalImageTransferTests(unittest.TestCase):
    def setUp(self) -> None:
        from scripts.local_image_transfer import LocalImageTransfer

        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name) / "project"
        self.project.mkdir()
        self.root = self.project / "output" / "imagegen"
        self.transfer = LocalImageTransfer(self.project, self.root)
        self.image = make_png(3, 2)
        (self.project / "reference.png").write_bytes(self.image)

    def test_import_export_preserves_bytes_and_local_provenance(self) -> None:
        artifact = self.transfer.import_image("reference.png")
        self.assertEqual(artifact["operation"], "import")
        self.assertEqual(artifact["provider"], "local-file")
        self.assertEqual(artifact["parentIds"], [])
        self.assertEqual(artifact["childIds"], [])
        self.assertEqual(artifact["width"], 3)
        self.assertNotIn(str(self.project), json.dumps(artifact))
        self.assertNotIn("reference.png", json.dumps(artifact))
        before = self.transfer.repository.index_path.read_bytes()
        receipt = self.transfer.export_image(artifact["id"], "decoded/参考.png")
        self.assertEqual(receipt["destinationPath"], "decoded/参考.png")
        self.assertEqual(receipt["sha256"], hashlib.sha256(self.image).hexdigest())
        self.assertEqual(receipt["byteLength"], len(self.image))
        self.assertEqual((self.project / receipt["destinationPath"]).read_bytes(), self.image)
        self.assertEqual(self.transfer.repository.index_path.read_bytes(), before)

    def test_import_is_a_snapshot_and_repeated_imports_are_independent(self) -> None:
        first = self.transfer.import_image("reference.png")
        second = self.transfer.import_image("reference.png")
        self.assertNotEqual(first["id"], second["id"])
        (self.project / "reference.png").write_bytes(make_png(1, 1))
        self.assertEqual(self.transfer.repository.get_artifact(first["id"]).image_bytes, self.image)

    def test_imported_image_can_parent_an_edit_and_edited_image_can_be_exported(self) -> None:
        parent = self.transfer.import_image("reference.png")
        edited = make_png(4, 2)
        child = self.transfer.repository.store_images(
            images=[edited], mime_type="image/png", provider="fixture", model="fixture",
            operation="edit", prompt="edit", parameters={}, parent_ids=[parent["id"]],
        )[0]
        self.transfer.export_image(child.metadata["id"], "decoded/edited.png")
        self.assertEqual((self.project / "decoded/edited.png").read_bytes(), edited)
        self.assertEqual(self.transfer.repository.get_artifact(parent["id"]).image_bytes, self.image)

    def test_invalid_source_never_publishes_an_index(self) -> None:
        for source in ("missing.png", "../reference.png", "/reference.png", "reference.png/child", "a\\b.png"):
            with self.subTest(source=source), self.assertRaises((ValueError, OSError)):
                self.transfer.import_image(source)
        (self.project / "bad.png").write_bytes(b"not an image")
        with self.assertRaises(ValueError):
            self.transfer.import_image("bad.png")
        self.assertFalse(self.transfer.repository.index_path.exists())

    def test_byte_limit_is_applied_by_the_open_file_reader(self) -> None:
        with patch("scripts.local_image_transfer.MAX_IMAGE_BYTES", len(self.image) - 1):
            with self.assertRaises(ValueError):
                self.transfer.import_image("reference.png")
        self.assertFalse(self.transfer.repository.index_path.exists())

    def test_export_rejects_overwrite_escape_repository_and_wrong_extension(self) -> None:
        artifact = self.transfer.import_image("reference.png")
        before = self.transfer.repository.index_path.read_bytes()
        with self.assertRaises(FileExistsError):
            self.transfer.export_image(artifact["id"], "reference.png")
        for destination in ("reference.png", "../escape.png", "output/imagegen/injected.png", "wrong.jpg", "a/../escape.png"):
            with self.subTest(destination=destination), self.assertRaises((ValueError, OSError)):
                self.transfer.export_image(artifact["id"], destination)
        self.assertEqual((self.project / "reference.png").read_bytes(), self.image)
        self.assertEqual(self.transfer.repository.index_path.read_bytes(), before)

    def test_linked_source_and_export_directory_are_rejected(self) -> None:
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (outside / "image.png").write_bytes(self.image)
        link = self.project / "linked"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"symlinks unavailable: {error}")
        with self.assertRaises((ValueError, OSError)):
            self.transfer.import_image("linked/image.png")
        artifact = self.transfer.import_image("reference.png")
        with self.assertRaises((ValueError, OSError)):
            self.transfer.export_image(artifact["id"], "linked/export.png")
        self.assertFalse((outside / "export.png").exists())

    def test_failed_publication_leaves_no_dangling_artifact(self) -> None:
        from scripts.repository_fs import RepositoryMutation
        from scripts.local_image_transfer import LocalImageTransferError

        original = RepositoryMutation.publish_new_file

        def fail_metadata(mutation, relative, data):
            if Path(relative).name == "meta.json":
                raise OSError("injected failure")
            return original(mutation, relative, data)

        with patch.object(RepositoryMutation, "publish_new_file", fail_metadata):
            with self.assertRaisesRegex(LocalImageTransferError, "local_image_import_failed"):
                self.transfer.import_image("reference.png")
        self.assertFalse(self.transfer.repository.index_path.exists())
        artifact = self.transfer.import_image("reference.png")
        self.assertEqual(self.transfer.repository.get_artifact(artifact["id"]).image_bytes, self.image)

    def test_runtime_errors_are_stable_and_do_not_expose_paths(self) -> None:
        from scripts.local_image_transfer import execute, LocalImageTransferError

        with self.assertRaises(LocalImageTransferError) as caught:
            execute({"operation": "import", "projectRoot": str(self.project),
                     "artifactRoot": str(self.root), "sourcePath": "missing.png"})
        self.assertEqual(str(caught.exception), "local_image_source_invalid")

    def test_repository_write_failure_is_not_reported_as_an_invalid_source(self) -> None:
        from scripts.local_image_transfer import execute, LocalImageTransferError
        from scripts.artifact_repository import ArtifactRepository

        with patch.object(ArtifactRepository, "store_local_image", side_effect=OSError("disk full")):
            with self.assertRaises(LocalImageTransferError) as caught:
                execute({"operation": "import", "projectRoot": str(self.project),
                         "artifactRoot": str(self.root), "sourcePath": "reference.png"})
        self.assertEqual(str(caught.exception), "local_image_import_failed")
