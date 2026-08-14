from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from image_delivery import deliver_artifact  # noqa: E402
from image_png import write_png_rgba  # noqa: E402
from image_response import detect_image_format, image_dimensions  # noqa: E402


class ImageDeliveryPreviewTests(unittest.TestCase):
    def test_preview_board_is_a_single_immutable_delivery_without_path_leaks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            source_path = Path(temp_name) / "source.png"
            write_png_rgba(source_path, 2, 2, [(240, 80, 40, 255)] * 4)
            result = deliver_artifact(
                source_artifact_id="img_source",
                source_bytes=source_path.read_bytes(),
                source_mime_type="image/png",
                delivery={
                    "preview": {
                        "sizes": ["2x2", "4x2"],
                        "backgrounds": ["white", "checker"],
                        "resample": "nearest",
                    },
                    "qa": True,
                },
            )

        self.assertTrue(result["deliveryReady"])
        self.assertEqual(result["deliveryKinds"], ["preview-board"])
        self.assertEqual(len(result["artifacts"]), 1)
        board = result["artifacts"][0]
        self.assertEqual(detect_image_format(board), "png")
        self.assertEqual(image_dimensions(board, "png"), (32, 28))
        self.assertEqual(result["qa"]["status"], "pass")
        self.assertEqual(result["summary"]["transforms"][0]["count"], 4)
        encoded = json.dumps({key: value for key, value in result.items() if key != "artifacts"})
        self.assertNotIn(str(source_path), encoded)
        self.assertNotIn("codex-image-delivery-", encoded)

    def test_exact_size_and_preview_are_qa_checked_by_their_own_dimensions(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            source_path = Path(temp_name) / "source.png"
            write_png_rgba(source_path, 2, 2, [(40, 160, 220, 255)] * 4)
            result = deliver_artifact(
                source_artifact_id="img_source",
                source_bytes=source_path.read_bytes(),
                source_mime_type="image/png",
                delivery={
                    "deliverySize": "4x4",
                    "fit": "contain",
                    "preview": {"sizes": ["2x2"], "backgrounds": ["white"]},
                    "qa": True,
                },
            )

        self.assertTrue(result["deliveryReady"], result)
        self.assertEqual(result["qa"]["status"], "pass")
        self.assertEqual(result["deliveryKinds"], ["exact-size", "preview-board"])
        self.assertEqual(len(result["artifacts"]), 2)


if __name__ == "__main__":
    unittest.main()
