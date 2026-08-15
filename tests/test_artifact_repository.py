from __future__ import annotations

import json
import concurrent.futures
from contextlib import contextmanager
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import zlib


ROOT = Path(__file__).resolve().parents[1]


def make_png(width: int, height: int) -> bytes:
    raw = bytearray()
    for _ in range(height):
        raw.append(0)
        raw.extend((255, 0, 0, 255) * width)

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


class ArtifactRepositoryTests(unittest.TestCase):
    def setUp(self) -> None:
        from scripts.artifact_repository import ArtifactRepository

        self.temp_dir = tempfile.TemporaryDirectory()
        self.project_root = Path(self.temp_dir.name)
        self.artifact_root = self.project_root / "output" / "imagegen"
        ids = iter(
            [
                "img_01J00000000000000000000000",
                "img_01J00000000000000000000001",
            ]
        )
        self.repository = ArtifactRepository(
            self.project_root,
            self.artifact_root,
            id_factory=lambda: next(ids),
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_uses_the_explicit_project_local_artifact_root(self) -> None:
        from scripts.artifact_repository import ArtifactRepository

        artifact_root = self.project_root / ".image-workspace" / "artifacts-v2"
        repository = ArtifactRepository(
            self.project_root,
            artifact_root,
            id_factory=lambda: "img_01J00000000000000000000000",
        )

        record = repository.store_images(
            images=[make_png(2, 2)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt="explicit root",
            parameters={},
        )[0]

        self.assertTrue((artifact_root / "artifacts" / record.metadata["id"] / "image.png").is_file())
        self.assertTrue((artifact_root / "index.json").is_file())
        self.assertFalse((self.project_root / "output" / "imagegen").exists())

    def test_derived_artifacts_do_not_enter_edit_version_lineage(self) -> None:
        source = self.repository.store_images(
            images=[make_png(2, 2)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt="source image",
            parameters={},
        )[0]

        derived = self.repository.store_derived_images(
            images=[make_png(4, 4)],
            mime_type="image/png",
            derived_from=source.metadata["id"],
            delivery_kinds=["exact-size"],
            parameters=[{"deliverySize": "4x4"}],
        )[0]

        loaded_source = self.repository.get_artifact(source.metadata["id"])
        loaded_derived = self.repository.get_artifact(derived.metadata["id"])
        self.assertEqual(loaded_source.metadata["childIds"], [])
        self.assertEqual(loaded_derived.metadata["parentIds"], [])
        self.assertEqual(loaded_derived.metadata["childIds"], [])
        self.assertEqual(loaded_derived.metadata["operation"], "derive")
        self.assertEqual(loaded_derived.metadata["derivedFrom"], source.metadata["id"])
        self.assertEqual(loaded_derived.metadata["deliveryKind"], "exact-size")
        self.assertEqual(loaded_derived.metadata["parameters"], {"deliverySize": "4x4"})

    def test_rejects_artifact_roots_that_are_not_safe_project_descendants(self) -> None:
        from scripts.artifact_repository import ArtifactRepository

        file_root = self.project_root / "artifact-file"
        file_root.write_text("not a directory", encoding="utf-8")
        with tempfile.TemporaryDirectory() as outside_directory:
            cases = [
                (self.project_root, "strict descendant"),
                (Path(outside_directory), "inside the project root"),
                (self.project_root / "nested" / ".." / ".." / "escaped", "inside the project root"),
                (file_root, "directory"),
            ]
            for artifact_root, message in cases:
                with self.subTest(artifact_root=artifact_root):
                    with self.assertRaisesRegex(ValueError, message):
                        ArtifactRepository(self.project_root, artifact_root)

    def test_rejects_existing_reparse_segments_in_the_artifact_root(self) -> None:
        from scripts import artifact_repository as repository_module

        artifact_root = self.project_root / "linked" / "artifacts"
        with mock.patch.object(
            repository_module,
            "reject_reparse_points",
            side_effect=[None, ValueError("artifact path contains a reparse point: linked")],
        ):
            with self.assertRaisesRegex(ValueError, "reparse point"):
                repository_module.ArtifactRepository(self.project_root, artifact_root)

    def test_store_rejects_preexisting_internal_symlinks_to_outside_project(self) -> None:
        for internal_name in ("artifacts", "index.json"):
            with self.subTest(internal_name=internal_name):
                artifact_root = self.project_root / internal_name.replace(".", "-")
                artifact_root.mkdir(parents=True)
                repository = type(self.repository)(
                    self.project_root,
                    artifact_root,
                    id_factory=lambda: "img_01J00000000000000000000000",
                )
                with tempfile.TemporaryDirectory() as outside_directory:
                    outside_root = Path(outside_directory)
                    internal_path = artifact_root / internal_name
                    if internal_name == "artifacts":
                        internal_path.symlink_to(outside_root, target_is_directory=True)
                    else:
                        outside_index = outside_root / "index.json"
                        outside_index.write_text('{"version":1,"artifacts":{}}', encoding="utf-8")
                        internal_path.symlink_to(outside_index)

                    with self.assertRaisesRegex(ValueError, "reparse point"):
                        repository.store_images(
                            images=[make_png(2, 2)],
                            mime_type="image/png",
                            provider="primary",
                            model="gpt-image-2",
                            operation="generate",
                            prompt="must stay inside the project",
                            parameters={},
                        )

                    self.assertFalse((outside_root / "artifacts").exists())

    def test_store_holds_the_output_parent_lease_for_the_full_transaction(self) -> None:
        from scripts import artifact_repository as repository_module

        original_ensure = repository_module.ensure_directory_tree_safely
        replacement_blocked = False

        with tempfile.TemporaryDirectory() as outside_directory:
            outside_root = Path(outside_directory)

            @contextmanager
            def ensure_then_attempt_parent_replacement(project_root: Path, artifact_root: Path):
                nonlocal replacement_blocked
                with original_ensure(project_root, artifact_root) as lease:
                    with self.assertRaises(OSError):
                        self.artifact_root.parent.rename(self.project_root / "replaced-output")
                    replacement_blocked = True
                    yield lease

            with mock.patch.object(
                repository_module,
                "ensure_directory_tree_safely",
                side_effect=ensure_then_attempt_parent_replacement,
            ):
                self.repository.store_images(
                    images=[make_png(2, 2)],
                    mime_type="image/png",
                    provider="primary",
                    model="gpt-image-2",
                    operation="generate",
                    prompt="must hold the output parent",
                    parameters={},
                )

            self.assertTrue(replacement_blocked)
            self.assertEqual(list(outside_root.iterdir()), [])

    def test_store_holds_the_artifact_root_lease_for_the_full_transaction(self) -> None:
        from scripts import artifact_repository as repository_module

        original_ensure = repository_module.ensure_directory_tree_safely
        replacement_blocked = False

        with tempfile.TemporaryDirectory() as outside_directory:
            outside_root = Path(outside_directory)

            @contextmanager
            def ensure_then_attempt_root_replacement(project_root: Path, artifact_root: Path):
                nonlocal replacement_blocked
                with original_ensure(project_root, artifact_root) as lease:
                    with self.assertRaises(OSError):
                        self.artifact_root.rename(self.artifact_root.with_name("replaced-imagegen"))
                    replacement_blocked = True
                    yield lease

            with mock.patch.object(
                repository_module,
                "ensure_directory_tree_safely",
                side_effect=ensure_then_attempt_root_replacement,
            ):
                self.repository.store_images(
                    images=[make_png(2, 2)],
                    mime_type="image/png",
                    provider="primary",
                    model="gpt-image-2",
                    operation="generate",
                    prompt="must hold the artifact root",
                    parameters={},
                )

            self.assertTrue(replacement_blocked)
            self.assertEqual(list(outside_root.iterdir()), [])

    def test_store_images_creates_independent_artifacts_and_atomic_index(self) -> None:
        from scripts import artifact_repository as repository_module

        calls: list[tuple[str, Path]] = []
        mutation_type = repository_module.RepositoryMutation

        class RecordingMutation(mutation_type):
            def create_directory(self, relative_path):
                calls.append(("create_directory", Path(relative_path)))
                return super().create_directory(relative_path)

            def create_new_directory(self, relative_path):
                calls.append(("create_new_directory", Path(relative_path)))
                return super().create_new_directory(relative_path)

            def publish_new_file(self, relative_path, data):
                calls.append(("publish_new_file", Path(relative_path)))
                return super().publish_new_file(relative_path, data)

            def publish_replace_file(self, relative_path, data):
                calls.append(("publish_replace_file", Path(relative_path)))
                return super().publish_replace_file(relative_path, data)

        with mock.patch.object(repository_module, "RepositoryMutation", RecordingMutation):
            records = self.repository.store_images(
                images=[make_png(3, 2), make_png(4, 3)],
                mime_type="image/png",
                provider="primary",
                model="gpt-image-2",
                operation="generate",
                prompt="red samples",
                parameters={"count": 2, "quality": "high"},
            )

        self.assertEqual(
            [record.metadata["id"] for record in records],
            ["img_01J00000000000000000000000", "img_01J00000000000000000000001"],
        )
        self.assertEqual(records[0].metadata["width"], 3)
        self.assertEqual(records[1].metadata["height"], 3)
        self.assertNotIn(str(self.project_root), json.dumps(records[0].metadata))

        data_root = self.project_root / "output" / "imagegen"
        for record in records:
            artifact_dir = data_root / "artifacts" / record.metadata["id"]
            self.assertEqual((artifact_dir / "image.png").read_bytes(), record.image_bytes)
            self.assertTrue((artifact_dir / "meta.json").is_file())

        index = json.loads((data_root / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(set(index["artifacts"]), {record.metadata["id"] for record in records})
        self.assertFalse((data_root / "index.json.tmp").exists())
        self.assertFalse((data_root / ".index.lock").exists())
        self.assertIn(("create_directory", Path("artifacts")), calls)
        self.assertIn(("publish_replace_file", Path("index.json")), calls)
        for record in records:
            relative_dir = Path("artifacts") / record.metadata["id"]
            self.assertIn(("create_new_directory", relative_dir), calls)
            self.assertIn(("publish_new_file", relative_dir / "image.png"), calls)
            self.assertIn(("publish_new_file", relative_dir / "meta.json"), calls)

    def test_edit_creates_child_without_overwriting_parent(self) -> None:
        parent = self.repository.store_images(
            images=[make_png(2, 2)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt="parent",
            parameters={},
        )[0]
        parent_bytes = parent.image_bytes

        child = self.repository.store_images(
            images=[make_png(5, 4)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="edit",
            prompt="child",
            parameters={},
            parent_ids=[parent.metadata["id"]],
        )[0]

        loaded_parent = self.repository.get_artifact(parent.metadata["id"])
        loaded_child = self.repository.get_artifact(child.metadata["id"])
        self.assertEqual(loaded_parent.image_bytes, parent_bytes)
        self.assertEqual(loaded_parent.metadata["childIds"], [child.metadata["id"]])
        self.assertEqual(loaded_child.metadata["parentIds"], [parent.metadata["id"]])

    def test_get_artifact_reads_index_and_image_under_one_directory_lease(self) -> None:
        from scripts import artifact_repository as repository_module

        record = self.repository.store_images(
            images=[make_png(2, 2)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt="leased read",
            parameters={},
        )[0]
        lease_type = repository_module.DirectoryLease
        leases: list[object] = []
        opened: list[Path] = []

        class RecordingLease(lease_type):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                leases.append(self)

            def open_file(self, relative_path, *args, **kwargs):
                opened.append(Path(relative_path))
                return super().open_file(relative_path, *args, **kwargs)

        with mock.patch.object(repository_module, "DirectoryLease", RecordingLease):
            loaded = self.repository.get_artifact(record.metadata["id"])

        self.assertEqual(loaded.image_bytes, record.image_bytes)
        self.assertEqual(len(leases), 1)
        self.assertEqual(
            opened,
            [Path("index.json"), Path("artifacts") / record.metadata["id"] / "image.png"],
        )

    def test_get_image_snapshot_reads_index_and_image_under_one_directory_lease(self) -> None:
        from scripts import artifact_repository as repository_module

        record = self.repository.store_images(
            images=[make_png(2, 2)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt="snapshot lease",
            parameters={},
        )[0]
        lease_type = repository_module.DirectoryLease
        leases: list[object] = []
        opened: list[Path] = []

        class RecordingLease(lease_type):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                leases.append(self)

            def open_file(self, relative_path, *args, **kwargs):
                opened.append(Path(relative_path))
                return super().open_file(relative_path, *args, **kwargs)

        with mock.patch.object(repository_module, "DirectoryLease", RecordingLease):
            image_path, image_bytes = self.repository.get_image_snapshot(record.metadata["id"])

        self.assertEqual(image_bytes, record.image_bytes)
        self.assertEqual(image_path, self.artifact_root / "artifacts" / record.metadata["id"] / "image.png")
        self.assertEqual(len(leases), 1)
        self.assertEqual(
            opened,
            [Path("index.json"), Path("artifacts") / record.metadata["id"] / "image.png"],
        )

    def test_read_index_treats_a_missing_verified_index_as_empty(self) -> None:
        from scripts import artifact_repository as repository_module

        self.artifact_root.mkdir(parents=True)
        lease_type = repository_module.DirectoryLease

        class MissingIndexLease(lease_type):
            def open_file(self, relative_path, *args, **kwargs):
                if Path(relative_path) == Path("index.json"):
                    raise FileNotFoundError("index disappeared before verified open")
                return super().open_file(relative_path, *args, **kwargs)

        with mock.patch.object(repository_module, "DirectoryLease", MissingIndexLease):
            self.assertEqual(self.repository._read_index(), {"version": 1, "artifacts": {}})

    def test_find_edits_reads_only_index_metadata_under_one_directory_lease(self) -> None:
        from scripts import artifact_repository as repository_module

        parent = self.repository.store_images(
            images=[make_png(2, 2)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt="parent",
            parameters={},
        )[0]
        child = self.repository.store_images(
            images=[make_png(3, 3)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="edit",
            prompt="child",
            parameters={
                "submissionId": "sub_replay",
                "submissionRequestFingerprint": "fingerprint",
            },
            parent_ids=[parent.metadata["id"]],
            annotation_id="ann_replay",
        )[0]
        lease_type = repository_module.DirectoryLease
        leases: list[object] = []
        opened: list[Path] = []

        class RecordingLease(lease_type):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                leases.append(self)

            def open_file(self, relative_path, *args, **kwargs):
                opened.append(Path(relative_path))
                return super().open_file(relative_path, *args, **kwargs)

        with mock.patch.object(repository_module, "DirectoryLease", RecordingLease):
            matches = self.repository.find_edits_by_submission_id(
                "sub_replay",
                parent_id=parent.metadata["id"],
                annotation_id="ann_replay",
                request_fingerprint="fingerprint",
            )

        self.assertEqual([record["id"] for record in matches or []], [child.metadata["id"]])
        self.assertEqual(len(leases), 1)
        self.assertEqual(opened, [Path("index.json")])

    def test_invalid_image_does_not_create_index_entry(self) -> None:
        with self.assertRaisesRegex(ValueError, "PNG"):
            self.repository.store_images(
                images=[b"not-an-image"],
                mime_type="image/png",
                provider="primary",
                model="gpt-image-2",
                operation="generate",
                prompt="broken",
                parameters={},
            )

        index_path = self.project_root / "output" / "imagegen" / "index.json"
        if index_path.exists():
            index = json.loads(index_path.read_text(encoding="utf-8"))
            self.assertEqual(index["artifacts"], {})

    def test_index_replace_failure_preserves_old_index_and_rolls_back_the_candidate_group(self) -> None:
        from scripts import artifact_repository as repository_module

        existing = self.repository.store_images(
            images=[make_png(2, 2)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt="existing",
            parameters={},
        )[0]
        data_root = self.project_root / "output" / "imagegen"
        index_path = data_root / "index.json"
        old_index = index_path.read_bytes()
        mutation_type = repository_module.RepositoryMutation
        removed: list[tuple[Path, set[str]]] = []

        class FailingIndexMutation(mutation_type):
            def publish_replace_file(self, relative_path, data):
                if Path(relative_path) == Path("index.json"):
                    raise OSError("index replace failed")
                return super().publish_replace_file(relative_path, data)

            def remove_directory_if_known(self, relative_path, known_files):
                removed.append((Path(relative_path), set(known_files)))
                return super().remove_directory_if_known(relative_path, known_files)

        with mock.patch.object(repository_module, "RepositoryMutation", FailingIndexMutation):
            with self.assertRaisesRegex(OSError, "index replace failed"):
                self.repository.store_images(
                    images=[make_png(3, 2)],
                    mime_type="image/png",
                    provider="primary",
                    model="gpt-image-2",
                    operation="generate",
                    prompt="atomic candidates",
                    parameters={"count": 1},
                )

        self.assertEqual(index_path.read_bytes(), old_index)
        self.assertIn(existing.metadata["id"], json.loads(old_index)["artifacts"])
        self.assertFalse((data_root / "artifacts" / "img_01J00000000000000000000001").exists())
        self.assertEqual(
            removed,
            [(Path("artifacts") / "img_01J00000000000000000000001", {"image.png", "meta.json"})],
        )

    def test_candidate_failure_rolls_back_only_known_published_files(self) -> None:
        from scripts import artifact_repository as repository_module

        mutation_type = repository_module.RepositoryMutation
        published = 0
        removed: list[tuple[Path, set[str]]] = []

        class FailingCandidateMutation(mutation_type):
            def publish_new_file(self, relative_path, data):
                nonlocal published
                if Path(relative_path).parts[0] != ".transactions":
                    published += 1
                    if published == 3:
                        raise OSError("candidate publish failed")
                return super().publish_new_file(relative_path, data)

            def remove_directory_if_known(self, relative_path, known_files):
                removed.append((Path(relative_path), set(known_files)))
                return super().remove_directory_if_known(relative_path, known_files)

        with mock.patch.object(repository_module, "RepositoryMutation", FailingCandidateMutation):
            with self.assertRaisesRegex(OSError, "candidate publish failed"):
                self.repository.store_images(
                    images=[make_png(3, 2), make_png(4, 3)],
                    mime_type="image/png",
                    provider="primary",
                    model="gpt-image-2",
                    operation="generate",
                    prompt="rollback known files",
                    parameters={"count": 2},
                )

        self.assertEqual(
            removed,
            [
                (Path("artifacts") / "img_01J00000000000000000000001", {"image.png", "meta.json"}),
                (Path("artifacts") / "img_01J00000000000000000000000", {"image.png", "meta.json"}),
            ],
        )
        data_root = self.project_root / "output" / "imagegen"
        self.assertFalse((data_root / "artifacts" / "img_01J00000000000000000000000").exists())
        self.assertFalse((data_root / "artifacts" / "img_01J00000000000000000000001").exists())

    def test_get_rejects_invalid_artifact_id(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid artifact ID"):
            self.repository.get_artifact("../auth.json")

    def test_concurrent_writes_preserve_every_index_entry(self) -> None:
        from scripts.artifact_repository import ArtifactRepository

        ids = ["img_01J00000000000000000000000", "img_01J00000000000000000000001"]

        def store(artifact_id: str) -> str:
            repository = ArtifactRepository(
                self.project_root,
                self.artifact_root,
                id_factory=lambda: artifact_id,
            )
            return repository.store_images(
                images=[make_png(2, 2)],
                mime_type="image/png",
                provider="primary",
                model="gpt-image-2",
                operation="generate",
                prompt=artifact_id,
                parameters={},
            )[0].metadata["id"]

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            written = list(executor.map(store, ids))

        index_path = self.project_root / "output" / "imagegen" / "index.json"
        index = json.loads(index_path.read_text(encoding="utf-8"))
        self.assertEqual(set(index["artifacts"]), set(written))


if __name__ == "__main__":
    unittest.main()
