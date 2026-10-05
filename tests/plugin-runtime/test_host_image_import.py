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

    def _store_parent(self) -> None:
        self.manager.repository.id_factory = lambda: PARENT_IMAGE_ID
        self.manager.repository.store_images(images=[make_png(2, 2)], mime_type="image/png",
            provider="test", model="test", operation="generate", prompt="parent", parameters={})
        self.manager.repository.id_factory = lambda: IMAGE_ID

    def test_conversation_edit_publishes_an_immutable_child_without_canvas_fields(self) -> None:
        self._store_parent()
        prepared = self.manager.prepare(route="chatgpt", intent="edit", prompt="warm colors",
            count=1, parentImageId=PARENT_IMAGE_ID)
        source = self.project_root / "conversation-edit.png"
        source.write_bytes(make_png(3, 3))
        os.utime(source, ns=(self.clock * 1_000_000, self.clock * 1_000_000))
        self.manager.stage(prepared["handoffId"], host_output={
            "type": "codex-imagegen-saved-path", "savedPath": str(source)})
        result = self.manager.finalize(prepared["handoffId"], action="commit")
        self.assertEqual(result["artifacts"][0]["parentIds"], [PARENT_IMAGE_ID])
        self.assertNotIn("submissionId", result["artifacts"][0]["parameters"])
        self.assertNotIn("editContext", result)
        self.assertEqual(self.manager.repository.get_artifact(PARENT_IMAGE_ID).image_bytes, make_png(2, 2))

    def test_keyed_prepare_replays_across_restart_and_rejects_conflicting_requests(self) -> None:
        from scripts.host_image_import import HostImageImportManager
        request = dict(route="chatgpt", intent="generate", prompt="sample", count=1, submissionKey="lost-receipt")
        first = self.manager.prepare(**request)
        restored = HostImageImportManager(self.project_root, self.artifact_root)
        second = restored.prepare(**request)
        self.assertEqual(second["handoffId"], first["handoffId"])
        self.assertFalse(first["replayed"])
        self.assertTrue(second["replayed"])
        self.assertEqual(restored.get(submission_key="lost-receipt")["status"], "prepared")
        with self.assertRaisesRegex(ValueError, "conflict"):
            restored.prepare(**{**request, "prompt": "different"})

    def test_keyed_prepare_recovers_an_interruption_before_record_publication(self) -> None:
        from unittest.mock import patch
        from scripts.host_image_import import HostImageImportManager

        request = dict(route="chatgpt", intent="generate", prompt="sample", count=1,
            submissionKey="interrupted-prepare")
        with patch("scripts.host_image_import.publish_new_file_safely", side_effect=OSError("interrupted")):
            with self.assertRaisesRegex(OSError, "interrupted"):
                self.manager.prepare(**request)
        restored = HostImageImportManager(self.project_root, self.artifact_root)
        recovered = restored.prepare(**request)
        self.assertFalse(recovered["replayed"])
        self.assertEqual(restored.get(submission_key=request["submissionKey"])["status"], "prepared")
        self.assertTrue(restored.prepare(**request)["replayed"])

    def test_keyed_prepare_preserves_unrecognized_and_invalid_records(self) -> None:
        from unittest.mock import patch

        for name, contents in (("image.bin", b"unknown output"), ("handoff.json", b"{}")):
            with self.subTest(name=name):
                request = dict(route="chatgpt", intent="generate", prompt="sample", count=1,
                    submissionKey="incomplete-" + name)
                with patch("scripts.host_image_import.publish_new_file_safely", side_effect=OSError("interrupted")):
                    with self.assertRaises(OSError):
                        self.manager.prepare(**request)
                target = self.artifact_root / ".handoffs" / self.manager._keyed_id(request["submissionKey"]) / name
                target.write_bytes(contents)
                with self.assertRaises((FileNotFoundError, ValueError)):
                    self.manager.prepare(**request)
                self.assertEqual(target.read_bytes(), contents)
                if name != "handoff.json":
                    self.assertFalse((target.parent / "handoff.json").exists())

    def test_canvas_abort_retains_context_for_idempotent_submission_release(self) -> None:
        self._store_parent()
        self.manager.prepare(route="chatgpt", intent="edit", prompt="sample", count=1,
            parentImageId=PARENT_IMAGE_ID, annotationId=None, submissionId=SUBMISSION_ID,
            revisionSha256="a" * 64, claimGeneration=2)
        first = self.manager.finalize(HANDOFF_ID, action="abort")
        self.assertEqual(first["editContext"]["claimGeneration"], 2)
        self.assertEqual(first, self.manager.finalize(HANDOFF_ID, action="abort"))
        self.assertEqual(first, self.manager.get(handoff_id=HANDOFF_ID))

    def test_terminal_publication_survives_cleanup_failure_and_replay(self) -> None:
        from unittest.mock import patch
        self.manager.prepare(route="chatgpt", intent="generate", prompt="sample", count=1)
        source = self.project_root / "host.png"
        source.write_bytes(make_png(2, 2))
        os.utime(source, ns=(self.clock * 1_000_000, self.clock * 1_000_000))
        self.manager.stage(HANDOFF_ID, host_output={"type": "codex-imagegen-saved-path", "savedPath": str(source)})
        with patch.object(self.manager, "_cleanup_snapshot", side_effect=OSError("interrupted cleanup")):
            with self.assertRaises(OSError):
                self.manager.finalize(HANDOFF_ID, action="commit")
        stored = self.manager.get(handoff_id=HANDOFF_ID)
        self.assertEqual(stored["status"], "committed")
        self.assertEqual(self.manager.finalize(HANDOFF_ID, action="commit"), stored)
        self.assertFalse((self.artifact_root / ".handoffs" / HANDOFF_ID / "image.bin").exists())

    def test_keyed_concurrent_preparations_publish_one_receipt(self) -> None:
        from concurrent.futures import ThreadPoolExecutor
        from scripts.host_image_import import HostImageImportManager
        request = dict(route="chatgpt", intent="generate", prompt="sample", count=1, submissionKey="concurrent")
        def prepare(_):
            return HostImageImportManager(self.project_root, self.artifact_root).prepare(**request)
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(prepare, range(2)))
        self.assertEqual(results[0]["handoffId"], results[1]["handoffId"])
        self.assertEqual(sorted(item["replayed"] for item in results), [False, True])

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
        self.assertEqual(self.manager.get(handoff_id=HANDOFF_ID)["status"], "aborted")
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
