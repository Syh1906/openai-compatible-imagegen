from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from scripts import image_transport


class ImageTransportTests(unittest.TestCase):
    def test_multipart_body_uses_bytes_snapshot_without_reopening_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "parent.png"
            path.write_bytes(b"path-content")
            snapshot = b"snapshot-content"

            body = image_transport.build_multipart_body(
                "test-boundary",
                {"prompt": "keep this"},
                [("image[]", path, snapshot)],
            )

            path.write_bytes(b"changed-after-snapshot")
            self.assertIn(snapshot, body)
            self.assertNotIn(b"changed-after-snapshot", body)

    def test_multipart_body_rejects_missing_input_path(self) -> None:
        missing = Path(tempfile.gettempdir()) / "image-transport-missing-input.png"
        with self.assertRaisesRegex(ValueError, "input file not found"):
            image_transport.build_multipart_body("test-boundary", {}, [("image[]", missing)])


if __name__ == "__main__":
    unittest.main()
