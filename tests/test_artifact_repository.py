from __future__ import annotations

import json
import concurrent.futures
from pathlib import Path
import tempfile
import unittest
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
        ids = iter(
            [
                "img_01J00000000000000000000000",
                "img_01J00000000000000000000001",
            ]
        )
        self.repository = ArtifactRepository(self.project_root, id_factory=lambda: next(ids))

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_store_images_creates_independent_artifacts_and_atomic_index(self) -> None:
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

    def test_get_rejects_invalid_artifact_id(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid artifact ID"):
            self.repository.get_artifact("../auth.json")

    def test_concurrent_writes_preserve_every_index_entry(self) -> None:
        from scripts.artifact_repository import ArtifactRepository

        ids = ["img_01J00000000000000000000000", "img_01J00000000000000000000001"]

        def store(artifact_id: str) -> str:
            repository = ArtifactRepository(self.project_root, id_factory=lambda: artifact_id)
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
