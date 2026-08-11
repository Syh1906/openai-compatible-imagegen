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

from image_batch import (  # noqa: E402
    fail_record,
    normalize_batch_shared,
    normalize_batch_tasks,
    prepare_batch_targets,
    write_manifest,
)


class BatchPathTests(unittest.TestCase):
    def test_output_and_input_paths_use_separate_explicit_bases(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            input_root = root / "requests"
            output_root = root / "deliveries"
            tasks = [
                {
                    "id": "badge",
                    "file": "nested/badge.png",
                    "postprocess_out_dir": "derived",
                    "images": "references/source.png",
                    "mask": "masks/mask.png",
                    "transparency_mask": "masks/alpha.png",
                }
            ]

            normalized = normalize_batch_tasks(tasks, input_root, output_root)

            self.assertEqual(
                normalized[0]["file"],
                str((output_root / "nested/badge.png").resolve()),
            )
            self.assertEqual(
                normalized[0]["postprocess_out_dir"],
                str((output_root / "derived").resolve()),
            )
            self.assertEqual(
                normalized[0]["images"],
                str((input_root / "references/source.png").resolve()),
            )
            self.assertEqual(
                normalized[0]["mask"],
                str((input_root / "masks/mask.png").resolve()),
            )
            self.assertEqual(
                normalized[0]["transparency_mask"],
                str((input_root / "masks/alpha.png").resolve()),
            )

    def test_default_task_output_is_anchored_to_batch_output_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output_root = root / "deliveries"
            normalized = normalize_batch_tasks(
                [{"id": "badge", "prompt": "A badge"}],
                root / "requests",
                output_root,
            )

            self.assertEqual(normalized[0]["out"], str(output_root.resolve()))

    def test_unnamed_task_default_file_uses_its_custom_output_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output_root = root / "deliveries"
            tasks = normalize_batch_tasks(
                [{"prompt": "Nested task", "out": "nested"}],
                root / "requests",
                output_root,
            )

            prepare_batch_targets(
                tasks,
                {},
                output_root,
                "20260811-120000",
                lambda prompt: prompt.lower().replace(" ", "-"),
                lambda task: "png",
                lambda task: False,
            )

            self.assertEqual(
                Path(tasks[0]["file"]).parent,
                (output_root / "nested").resolve(),
            )

    def test_shared_paths_use_output_root_and_input_paths_use_jsonl_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            shared = normalize_batch_shared(
                {
                    "file": "shared/result.png",
                    "out": str(root / "deliveries"),
                    "postprocess_out_dir": "derived",
                    "images": ["references/a.png", "references/b.png"],
                    "mask": "masks/mask.png",
                    "transparency_mask": "masks/alpha.png",
                },
                root / "requests",
                root / "deliveries",
            )

            self.assertEqual(shared["file"], str((root / "deliveries/shared/result.png").resolve()))
            self.assertEqual(shared["out"], str((root / "deliveries").resolve()))
            self.assertEqual(shared["postprocess_out_dir"], str((root / "deliveries/derived").resolve()))
            self.assertEqual(
                shared["images"],
                [
                    str((root / "requests/references/a.png").resolve()),
                    str((root / "requests/references/b.png").resolve()),
                ],
            )
            self.assertEqual(shared["mask"], str((root / "requests/masks/mask.png").resolve()))
            self.assertEqual(
                shared["transparency_mask"],
                str((root / "requests/masks/alpha.png").resolve()),
            )

    def test_api_rejection_fields_are_preserved_in_batch_record(self) -> None:
        error = RuntimeError("API HTTP 400: request rejected")
        error.error_kind = "api_rejected"  # type: ignore[attr-defined]
        error.status_code = 400  # type: ignore[attr-defined]
        error.operation = "images/edits"  # type: ignore[attr-defined]
        error.details = {"references": {"status": "not_evaluated"}}  # type: ignore[attr-defined]

        result = fail_record({"id": "edit-1"}, "edit", error)

        self.assertFalse(result["ok"])
        self.assertFalse(result["delivery_ready"])
        self.assertEqual(result["error_kind"], "api_rejected")
        self.assertEqual(result["status_code"], 400)
        self.assertEqual(result["operation"], "images/edits")
        self.assertIn("references", result["details"])

    def test_manifest_reports_missing_success_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            manifest, files_exist = write_manifest(
                root,
                [{"id": "one", "ok": True, "files": [str(root / "missing.png")]}],
            )

            payload = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertFalse(files_exist)
            self.assertEqual(payload["output_root"], root.resolve().as_posix())
            self.assertEqual(payload["path_contract"]["status"], "fail")
            self.assertEqual(payload["path_contract"]["missing_files"], [str(root / "missing.png")])


if __name__ == "__main__":
    unittest.main()
