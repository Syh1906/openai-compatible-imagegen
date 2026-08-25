from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest
import zlib


HANDOFF_ID = "handoff_" + "a" * 64
IMAGE_ID = "img_01J00000000000000000000000"
PARENT_IMAGE_ID = "img_01J00000000000000000000001"
ANNOTATION_ID = "ann_01J00000000000000000000000"
SUBMISSION_ID = "sub_0123456789abcdef0123456789abcdef"


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


class HostImageImportTests(unittest.TestCase):
    def setUp(self) -> None:
        from scripts.host_image_import import HostImageImportManager

        self.temp_dir = tempfile.TemporaryDirectory()
        self.project_root = Path(self.temp_dir.name) / "project"
        self.project_root.mkdir()
        self.artifact_root = self.project_root / "output" / "imagegen"
        self.clock = 1_800_000_000_000
        self.manager = HostImageImportManager(
            self.project_root,
            self.artifact_root,
            handoff_id_factory=lambda: HANDOFF_ID,
            artifact_id_factory=lambda: IMAGE_ID,
            epoch_ms_factory=lambda: self.clock,
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_prepare_stage_and_replayed_finalize_publish_one_import(self) -> None:
        prepared = self.manager.prepare(
            route="chatgpt",
            intent="generate",
            prompt="a red square",
            count=1,
        )
        source = self.project_root / "host-output.png"
        source.write_bytes(make_png(3, 2))
        os.utime(source, ns=(self.clock * 1_000_000, self.clock * 1_000_000))

        staged = self.manager.stage(
            HANDOFF_ID,
            host_output={"type": "codex-imagegen-saved-path", "savedPath": str(source)},
        )
        committed = self.manager.finalize(HANDOFF_ID, action="commit")
        replay = self.manager.finalize(HANDOFF_ID, action="commit")

        self.assertEqual(prepared, {"handoffId": HANDOFF_ID, "status": "prepared"})
        self.assertEqual(staged["status"], "staged")
        self.assertEqual(staged["imageCount"], 1)
        self.assertEqual(committed, replay)
        self.assertEqual(committed["status"], "committed")
        self.assertEqual(committed["artifacts"][0]["operation"], "import")
        self.assertNotIn(str(source), json.dumps(committed))
        self.assertFalse((self.artifact_root / ".handoffs" / HANDOFF_ID / "image.bin").exists())

    def test_edit_import_preserves_parent_annotation_and_submission_relationships(self) -> None:
        parent_repository = self.manager.repository
        parent_repository.id_factory = lambda: PARENT_IMAGE_ID
        parent_repository.store_images(
            images=[make_png(3, 2)],
            mime_type="image/png",
            provider="test",
            model="test",
            operation="generate",
            prompt="parent",
            parameters={},
        )
        parent_repository.id_factory = lambda: IMAGE_ID
        self.manager.prepare(
            route="chatgpt",
            intent="edit",
            prompt="brighten the marked area",
            count=1,
            parentImageId=PARENT_IMAGE_ID,
            annotationId=ANNOTATION_ID,
            submissionId=SUBMISSION_ID,
            revisionSha256="a" * 64,
            claimGeneration=1,
        )
        source = self.project_root / "host-edit.png"
        source.write_bytes(make_png(3, 2))
        os.utime(source, ns=(self.clock * 1_000_000, self.clock * 1_000_000))
        self.manager.stage(
            HANDOFF_ID,
            host_output={"type": "codex-imagegen-saved-path", "savedPath": str(source)},
        )

        committed = self.manager.finalize(HANDOFF_ID, action="commit")
        metadata = committed["artifacts"][0]

        self.assertEqual(metadata["operation"], "import")
        self.assertEqual(metadata["parentIds"], [PARENT_IMAGE_ID])
        self.assertEqual(metadata["annotationId"], ANNOTATION_ID)
        self.assertEqual(metadata["parameters"]["submissionId"], SUBMISSION_ID)
        self.assertEqual(committed["editContext"]["claimGeneration"], 1)

    def test_edit_import_allows_a_text_only_submission_without_annotation(self) -> None:
        parent_repository = self.manager.repository
        parent_repository.id_factory = lambda: PARENT_IMAGE_ID
        parent_repository.store_images(
            images=[make_png(2, 2)],
            mime_type="image/png",
            provider="test",
            model="test",
            operation="generate",
            prompt="parent",
            parameters={},
        )
        parent_repository.id_factory = lambda: IMAGE_ID
        self.manager.prepare(
            route="chatgpt",
            intent="edit",
            prompt="make the image warmer",
            count=1,
            parentImageId=PARENT_IMAGE_ID,
            annotationId=None,
            submissionId=SUBMISSION_ID,
            revisionSha256="b" * 64,
            claimGeneration=1,
        )
        source = self.project_root / "host-text-only.png"
        source.write_bytes(make_png(2, 2))
        os.utime(source, ns=(self.clock * 1_000_000, self.clock * 1_000_000))
        self.manager.stage(
            HANDOFF_ID,
            host_output={"type": "codex-imagegen-saved-path", "savedPath": str(source)},
        )

        committed = self.manager.finalize(HANDOFF_ID, action="commit")

        self.assertEqual(committed["artifacts"][0]["parentIds"], [PARENT_IMAGE_ID])
        self.assertIsNone(committed["artifacts"][0]["annotationId"])
        self.assertEqual(committed["artifacts"][0]["parameters"]["submissionId"], SUBMISSION_ID)

    def test_stage_rejects_stale_non_image_and_linked_outputs(self) -> None:
        self.manager.prepare(route="chatgpt", intent="generate", prompt="sample", count=1)
        stale = self.project_root / "stale.png"
        stale.write_bytes(make_png(1, 1))
        os.utime(stale, ns=((self.clock - 1) * 1_000_000, (self.clock - 1) * 1_000_000))
        with self.assertRaisesRegex(ValueError, "current handoff"):
            self.manager.stage(
                HANDOFF_ID,
                host_output={"type": "codex-imagegen-saved-path", "savedPath": str(stale)},
            )

        invalid = self.project_root / "invalid.png"
        invalid.write_bytes(b"not an image")
        os.utime(invalid, ns=(self.clock * 1_000_000, self.clock * 1_000_000))
        with self.assertRaisesRegex(ValueError, "image"):
            self.manager.stage(
                HANDOFF_ID,
                host_output={"type": "codex-imagegen-saved-path", "savedPath": str(invalid)},
            )

        linked = self.project_root / "linked.png"
        try:
            linked.symlink_to(invalid)
        except OSError:
            return
        with self.assertRaisesRegex(ValueError, "reparse point"):
            self.manager.stage(
                HANDOFF_ID,
                host_output={"type": "codex-imagegen-saved-path", "savedPath": str(linked)},
            )

    def test_abort_removes_the_staged_snapshot_and_freezes_the_terminal_state(self) -> None:
        self.manager.prepare(route="chatgpt", intent="generate", prompt="sample", count=1)
        source = self.project_root / "host-output.png"
        source.write_bytes(make_png(2, 2))
        os.utime(source, ns=(self.clock * 1_000_000, self.clock * 1_000_000))
        self.manager.stage(
            HANDOFF_ID,
            host_output={"type": "codex-imagegen-saved-path", "savedPath": str(source)},
        )

        self.assertEqual(
            self.manager.finalize(HANDOFF_ID, action="abort"),
            {"handoffId": HANDOFF_ID, "status": "aborted"},
        )
        state_root = self.artifact_root / ".handoffs" / HANDOFF_ID
        self.assertFalse((state_root / "image.bin").exists())
        self.assertEqual(json.loads((state_root / "handoff.json").read_text(encoding="utf-8"))["status"], "aborted")
        with self.assertRaisesRegex(ValueError, "aborted"):
            self.manager.finalize(HANDOFF_ID, action="commit")

    def test_prepare_rejects_unimplemented_routes_and_capabilities(self) -> None:
        cases = [
            {"route": "apikey", "intent": "generate", "prompt": "sample", "count": 1},
            {
                "route": "chatgpt",
                "intent": "edit",
                "prompt": "sample",
                "count": 1,
                "parentImageId": None,
                "annotationId": None,
                "submissionId": None,
                "claimGeneration": None,
            },
            {"route": "chatgpt", "intent": "generate", "prompt": "sample", "count": 2},
        ]
        for case in cases:
            with self.subTest(case=case), self.assertRaises(ValueError):
                self.manager.prepare(**case)

    def test_execute_reports_stable_error_codes_without_source_details(self) -> None:
        from scripts.host_image_import import HostImageImportError, execute

        with self.assertRaises(HostImageImportError) as raised:
            execute({
                "operation": "stage",
                "projectRoot": str(self.project_root),
                "artifactRoot": str(self.artifact_root),
                "handoffId": HANDOFF_ID,
                "hostOutput": {
                    "type": "codex-imagegen-saved-path",
                    "savedPath": str(self.project_root / "private-source.png"),
                },
            })

        self.assertEqual(raised.exception.code, "host_image_handoff_not_found")
        self.assertNotIn("private-source.png", str(raised.exception))

    def test_imported_image_can_use_local_delivery_without_a_provider_profile(self) -> None:
        from scripts.image_runtime import run_machine_task

        self.manager.prepare(route="chatgpt", intent="generate", prompt="sample", count=1)
        source = self.project_root / "host-output.png"
        source.write_bytes(make_png(2, 2))
        os.utime(source, ns=(self.clock * 1_000_000, self.clock * 1_000_000))
        self.manager.stage(
            HANDOFF_ID,
            host_output={"type": "codex-imagegen-saved-path", "savedPath": str(source)},
        )
        committed = self.manager.finalize(HANDOFF_ID, action="commit")
        local_config = json.dumps({
            "config_version": 1,
            "defaults": {"size": "1024x1024", "quality": "auto", "output_format": "png"},
            "postprocess": {"enabled": True},
            "transparency": {"default_route": "chroma-matting"},
            "storage": {"output_directory": "output/imagegen"},
        }).encode("utf-8")
        import hashlib

        result = run_machine_task(
            {
                "operation": "deliver",
                "inputArtifactIds": [committed["artifacts"][0]["id"]],
                "delivery": {"qa": True},
            },
            self.project_root,
            self.artifact_root,
            config_snapshot=local_config,
            config_sha256=hashlib.sha256(local_config).hexdigest(),
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["sourceArtifactId"], committed["artifacts"][0]["id"])


if __name__ == "__main__":
    unittest.main()
