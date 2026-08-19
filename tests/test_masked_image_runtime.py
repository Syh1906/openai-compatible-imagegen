from __future__ import annotations

import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import zlib


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "image_runtime.py"


def load_imagegen():
    spec = importlib.util.spec_from_file_location("masked_imagegen_runtime_under_test", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load image_runtime.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def make_png(width: int, height: int, pixels: list[tuple[int, int, int, int]]) -> bytes:
    if len(pixels) != width * height:
        raise ValueError("pixel count mismatch")
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw.extend(pixels[y * width + x])

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


VALID_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/"
    "2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/"
    "8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK"
    "FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG"
    "x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC"
    "AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOE"
    "hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDlqKKK8c9Q/9k="
)


class MaskedImageRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.imagegen = load_imagegen()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.project_root = Path(self.temp_dir.name)
        self.artifact_root = self.project_root / "output" / "imagegen"
        self.cfg = self.imagegen.Config(
            base_url="https://images.example.test/v1",
            api_key="runtime-secret",
            api_key_source="test",
            model="gpt-image-2",
            defaults={},
            capabilities={"generate": True, "edit": True, "mask": True, "multi_reference": True},
            postprocess={"enabled": False},
            user_agent="Imagegen-Test/1.0",
        )
        self.parent_pixels = [
            (10, 20, 30, 255),
            (40, 50, 60, 255),
            (255, 0, 0, 255),
            (255, 0, 0, 0),
        ]
        self.generated_pixels = [
            (210, 220, 230, 255),
            (1, 2, 3, 255),
            (0, 0, 255, 255),
            (0, 0, 255, 255),
        ]
        self.parent_id = self._store_parent(make_png(2, 2, self.parent_pixels))
        self.annotation_id = "ann_01J00000000000000000000000"
        self.mask_bytes = make_png(
            2,
            2,
            [
                (255, 255, 255, 255),
                (255, 255, 255, 0),
                (255, 255, 255, 128),
                (255, 255, 255, 255),
            ],
        )
        self.mask_path = self.project_root / "output" / "imagegen" / "annotations" / self.annotation_id / "mask.png"
        self.mask_path.parent.mkdir(parents=True)
        self.mask_path.write_bytes(self.mask_bytes)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _store_parent(self, image_bytes: bytes, mime_type: str = "image/png") -> str:
        record = self.imagegen.ArtifactRepository(self.project_root, self.artifact_root).store_images(
            images=[image_bytes],
            mime_type=mime_type,
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt="parent",
            parameters={},
        )[0]
        return record.metadata["id"]

    def _use_fully_transparent_mask(self) -> None:
        self.mask_bytes = make_png(2, 2, [(255, 255, 255, 0)] * 4)
        self.mask_path.write_bytes(self.mask_bytes)

    def _policy(self, strategy: str = "mixed", parent_id: str | None = None) -> dict[str, object]:
        masks = {
            "edit-only": [
                {"id": "edit-1", "mode": "edit", "operation": "paint", "radiusPx": 0.5},
            ],
            "protect-only": [
                {"id": "protect-1", "mode": "protect", "operation": "paint", "radiusPx": 0.25},
            ],
            "mixed": [
                {"id": "edit-1", "mode": "edit", "operation": "paint", "radiusPx": 0.5},
                {"id": "protect-1", "mode": "protect", "operation": "paint", "radiusPx": 0.25},
            ],
        }[strategy]
        body = {
            "policyVersion": "mask-policy-v2",
            "modelProfileId": "primary/gpt-image-2",
            "requiredCapabilities": {"mask": True},
            "strategy": strategy,
            "parentImageId": parent_id or self.parent_id,
            "annotationId": self.annotation_id,
            "width": 2,
            "height": 2,
            "masks": masks,
            "hardBoundary": {
                "source": "none" if strategy == "protect-only" else "edit-strokes",
                "postprocess": "none" if strategy == "protect-only" else "parent-blend",
            },
            "semanticProtection": {
                "enabled": strategy != "edit-only",
                "source": "protect-strokes",
                "preserve": ["identity", "geometry", "text", "texture"],
                "allowAdaptation": ["lighting", "shadow", "tone"],
            },
            "transitionBand": {
                "kind": "outer-feather",
                "featherRatio": 0.35,
                "minimumWidthPx": 1,
            },
            "maskSha256": hashlib.sha256(self.mask_bytes).hexdigest(),
        }
        canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return {**body, "policySha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest()}

    def _task(self, strategy: str = "mixed", parent_id: str | None = None) -> dict[str, object]:
        resolved_parent_id = parent_id or self.parent_id
        return {
            "operation": "edit",
            "modelProfileId": "primary/gpt-image-2",
            "prompt": "Change the cup.\n\n[Mask policy: mandatory]",
            "inputArtifactIds": [resolved_parent_id],
            "annotationId": self.annotation_id,
            "submissionId": "sub_00000000000000000000000000000000",
            "mask": str(self.mask_path),
            "maskPolicy": self._policy(strategy, resolved_parent_id),
            "output": {
                "size": "2x2",
                "quality": "high",
                "format": "png",
                "count": 1,
                "background": "opaque",
            },
        }

    def test_mask_snapshot_drives_request_prompt_postprocess_and_audit_metadata(self) -> None:
        generated = {
            "data": [
                {
                    "b64_json": base64.b64encode(
                        make_png(2, 2, self.generated_pixels)
                    ).decode("ascii")
                }
            ]
        }

        def request_side_effect(_cfg, _path, fields, files, _timeout):
            guard = self.imagegen.MASK_GUARD_V2_BY_STRATEGY["mixed"]
            self.assertTrue(fields["prompt"].endswith(guard))
            self.assertEqual(fields["prompt"].count(guard), 1)
            mask_upload = next(upload for upload in files if upload[0] == "mask")
            self.assertEqual(mask_upload[1], self.mask_path)
            self.assertEqual(mask_upload[2], self.mask_bytes)
            self.mask_path.write_bytes(make_png(2, 2, [(255, 255, 255, 0)] * 4))
            return generated

        with mock.patch.object(
            self.imagegen,
            "request_multipart",
            side_effect=request_side_effect,
        ) as request:
            result = self.imagegen.run_machine_task(self._task(), self.project_root, self.artifact_root, self.cfg)

        self.assertTrue(result["ok"], result)
        request.assert_called_once()
        artifact = result["artifacts"][0]
        self.assertEqual(artifact["prompt"], self._task()["prompt"])
        audit = artifact["parameters"]
        self.assertEqual(audit["sourcePrompt"], self._task()["prompt"])
        self.assertTrue(audit["effectivePrompt"].endswith(self.imagegen.MASK_GUARD_V2_BY_STRATEGY["mixed"]))
        self.assertEqual(
            audit["effectivePromptSha256"],
            hashlib.sha256(audit["effectivePrompt"].encode("utf-8")).hexdigest(),
        )
        self.assertEqual(audit["maskSha256"], self._policy()["maskSha256"])
        self.assertEqual(audit["annotationId"], self.annotation_id)
        self.assertEqual(audit["maskPolicySha256"], self._policy()["policySha256"])
        self.assertEqual(audit["maskPolicyVersion"], "mask-policy-v2")
        self.assertEqual(audit["promptGuardVersion"], "mask-guard-v2")
        self.assertTrue(audit["providerMaskUploaded"])
        self.assertEqual(audit["hardBoundarySource"], "edit-strokes")
        self.assertEqual(audit["hardBoundaryPostprocess"], "parent-blend")
        self.assertTrue(audit["hardBoundaryBlendApplied"])
        self.assertTrue(audit["semanticProtectionRequested"])
        self.assertEqual(audit["semanticProtectionSource"], "protect-strokes")
        self.assertNotIn("maskBlendApplied", audit)
        self.assertEqual((audit["finalWidth"], audit["finalHeight"], audit["finalFormat"]), (2, 2, "png"))
        child_path = self.imagegen.ArtifactRepository(self.project_root, self.artifact_root).get_image_path(artifact["id"])
        blended = self.imagegen.read_png_rgba(child_path)["pixels"]
        self.assertEqual(blended[0], self.parent_pixels[0])
        self.assertEqual(blended[1], self.generated_pixels[1])
        self.assertEqual(blended[2], (188, 0, 187, 255))
        self.assertEqual(blended[3], self.parent_pixels[3])

    def test_masked_edit_uses_the_explicit_artifact_root_for_annotations(self) -> None:
        custom_root = self.project_root / ".project-data" / "image-artifacts"
        repository = self.imagegen.ArtifactRepository(self.project_root, custom_root)
        parent = repository.store_images(
            images=[make_png(2, 2, self.parent_pixels)],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt="parent",
            parameters={},
        )[0]
        task = self._task("mixed", parent.metadata["id"])
        custom_mask_path = custom_root / "annotations" / self.annotation_id / "mask.png"
        custom_mask_path.parent.mkdir(parents=True)
        custom_mask_path.write_bytes(self.mask_bytes)
        task["mask"] = str(custom_mask_path)
        response = {
            "data": [{"b64_json": base64.b64encode(make_png(2, 2, self.generated_pixels)).decode("ascii")}]
        }

        with mock.patch.object(self.imagegen, "request_multipart", return_value=response) as request:
            result = self.imagegen.run_machine_task(task, self.project_root, custom_root, self.cfg)

        self.assertTrue(result["ok"])
        self.assertEqual(next(item[1] for item in request.call_args.args[3] if item[0] == "mask"), custom_mask_path)

    def test_protect_only_keeps_provider_scene_without_parent_pixel_reinjection(self) -> None:
        self._use_fully_transparent_mask()
        response = {
            "data": [{
                "b64_json": base64.b64encode(make_png(2, 2, self.generated_pixels)).decode("ascii"),
            }]
        }

        def request_side_effect(_cfg, _path, fields, files, _timeout):
            self.assertTrue(fields["prompt"].endswith(self.imagegen.MASK_GUARD_V2_BY_STRATEGY["protect-only"]))
            self.assertEqual(next(upload for upload in files if upload[0] == "mask")[2], self.mask_bytes)
            return response

        with mock.patch.object(self.imagegen, "request_multipart", side_effect=request_side_effect):
            result = self.imagegen.run_machine_task(
                self._task("protect-only"),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )

        self.assertTrue(result["ok"])
        audit = result["artifacts"][0]["parameters"]
        self.assertEqual(audit["hardBoundarySource"], "none")
        self.assertEqual(audit["hardBoundaryPostprocess"], "none")
        self.assertFalse(audit["hardBoundaryBlendApplied"])
        self.assertTrue(audit["semanticProtectionRequested"])
        child_path = self.imagegen.ArtifactRepository(self.project_root, self.artifact_root).get_image_path(result["artifacts"][0]["id"])
        self.assertEqual(self.imagegen.read_png_rgba(child_path)["pixels"], self.generated_pixels)

    def test_protect_only_rejects_a_nontransparent_provider_mask_before_request(self) -> None:
        with mock.patch.object(self.imagegen, "request_multipart") as request:
            result = self.imagegen.run_machine_task(
                self._task("protect-only"),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "invalid_task")
        self.assertIn("fully transparent mask", result["error"]["message"])
        request.assert_not_called()

    def test_protect_only_rejects_a_semitransparent_mask_before_request(self) -> None:
        self.mask_bytes = make_png(2, 2, [(255, 255, 255, 1)] * 4)
        self.mask_path.write_bytes(self.mask_bytes)

        with mock.patch.object(self.imagegen, "request_multipart") as request:
            result = self.imagegen.run_machine_task(
                self._task("protect-only"),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "invalid_task")
        self.assertIn("fully transparent mask", result["error"]["message"])
        request.assert_not_called()

    def test_protect_only_accepts_a_non_png_parent_without_local_pixel_blending(self) -> None:
        self._use_fully_transparent_mask()
        jpeg_parent_id = self._store_parent(VALID_JPEG, "image/jpeg")
        response = {
            "data": [{
                "b64_json": base64.b64encode(make_png(2, 2, self.generated_pixels)).decode("ascii"),
            }]
        }

        with mock.patch.object(self.imagegen, "request_multipart", return_value=response) as request:
            result = self.imagegen.run_machine_task(
                self._task("protect-only", jpeg_parent_id),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )

        self.assertTrue(result["ok"])
        request.assert_called_once()
        child_path = self.imagegen.ArtifactRepository(self.project_root, self.artifact_root).get_image_path(result["artifacts"][0]["id"])
        self.assertEqual(self.imagegen.read_png_rgba(child_path)["pixels"], self.generated_pixels)

        with mock.patch.object(self.imagegen, "request_multipart") as edit_request:
            edit_task = self._task("edit-only", jpeg_parent_id)
            edit_task["submissionId"] = "sub_11111111111111111111111111111111"
            rejected = self.imagegen.run_machine_task(
                edit_task,
                self.project_root,
                self.artifact_root,
                self.cfg,
            )
        self.assertFalse(rejected["ok"])
        self.assertEqual(rejected["error"]["code"], "invalid_task")
        self.assertIn("PNG parent", rejected["error"]["message"])
        edit_request.assert_not_called()

    def test_protect_only_native_alpha_output_preserves_provider_rgba(self) -> None:
        self._use_fully_transparent_mask()
        generated_pixels = [
            (210, 220, 230, 255),
            (1, 2, 3, 192),
            (0, 0, 255, 64),
            (0, 0, 0, 0),
        ]
        response = {
            "data": [{
                "b64_json": base64.b64encode(make_png(2, 2, generated_pixels)).decode("ascii"),
            }]
        }
        task = self._task("protect-only")
        task["output"] = {**task["output"], "background": "opaque"}
        cfg = self.cfg

        def request_side_effect(_cfg, _path, fields, files, _timeout):
            self.assertEqual(fields["background"], "opaque")
            self.assertEqual(next(upload for upload in files if upload[0] == "mask")[2], self.mask_bytes)
            return response

        with mock.patch.object(self.imagegen, "request_multipart", side_effect=request_side_effect) as request:
            result = self.imagegen.run_machine_task(task, self.project_root, self.artifact_root, cfg)

        self.assertTrue(result["ok"])
        request.assert_called_once()
        child_path = self.imagegen.ArtifactRepository(self.project_root, self.artifact_root).get_image_path(result["artifacts"][0]["id"])
        self.assertEqual(self.imagegen.read_png_rgba(child_path)["pixels"], generated_pixels)

    def test_edit_only_retains_the_signed_hard_boundary_without_semantic_protection(self) -> None:
        response = {
            "data": [{
                "b64_json": base64.b64encode(make_png(2, 2, self.generated_pixels)).decode("ascii"),
            }]
        }

        with mock.patch.object(self.imagegen, "request_multipart", return_value=response):
            result = self.imagegen.run_machine_task(
                self._task("edit-only"),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )

        self.assertTrue(result["ok"])
        audit = result["artifacts"][0]["parameters"]
        self.assertEqual(audit["hardBoundarySource"], "edit-strokes")
        self.assertTrue(audit["hardBoundaryBlendApplied"])
        self.assertFalse(audit["semanticProtectionRequested"])
        self.assertEqual(audit["semanticProtectionSource"], "none")
        child_path = self.imagegen.ArtifactRepository(self.project_root, self.artifact_root).get_image_path(result["artifacts"][0]["id"])
        blended = self.imagegen.read_png_rgba(child_path)["pixels"]
        self.assertEqual(blended[0], self.parent_pixels[0])
        self.assertEqual(blended[1], self.generated_pixels[1])

    def test_mask_preflight_rejects_untrusted_or_incompatible_tasks_before_request(self) -> None:
        cases = []
        missing_policy = self._task()
        missing_policy.pop("maskPolicy")
        cases.append(("missing policy", missing_policy, "invalid_task"))
        missing_mask = self._task()
        missing_mask.pop("mask")
        cases.append(("missing mask", missing_mask, "invalid_task"))
        for name, key, value in [
            ("legacy version", "policyVersion", "mask-policy-v1"),
            ("wrong model profile", "modelProfileId", "secondary/gpt-image-2"),
            ("mask capability not required", "requiredCapabilities", {"mask": False}),
            ("unexpected required capability", "requiredCapabilities", {"mask": True, "edit": True}),
            ("wrong parent", "parentImageId", "img_01J00000000000000000000000"),
            ("wrong annotation", "annotationId", "ann_01J00000000000000000000001"),
            ("wrong width", "width", 3),
            ("wrong digest", "maskSha256", "0" * 64),
            ("wrong hard boundary", "hardBoundary", {"source": "none", "postprocess": "none"}),
            ("wrong semantic protection", "semanticProtection", {"enabled": False}),
        ]:
            task = self._task()
            policy_body = {**task["maskPolicy"], key: value}
            policy_body.pop("policySha256")
            canonical = json.dumps(policy_body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            task["maskPolicy"] = {
                **policy_body,
                "policySha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
            }
            cases.append((name, task, "invalid_task"))
        no_annotation = self._task()
        no_annotation["annotationId"] = None
        cases.append(("missing annotation ID", no_annotation, "invalid_task"))
        guard_only = self._task()
        guard_only["prompt"] = self.imagegen.MASK_GUARD_V2_BY_STRATEGY["mixed"]
        cases.append(("guard-only prompt", guard_only, "invalid_task"))
        for name, key, value in [
            ("multiple results", "count", 2),
            ("non-PNG output", "format", "jpeg"),
            ("different output size", "size", "3x2"),
        ]:
            task = self._task()
            task["output"] = {**task["output"], key: value}
            cases.append((name, task, "invalid_task"))

        for name, task, expected_code in cases:
            with self.subTest(name=name):
                with mock.patch.object(self.imagegen, "request_multipart") as request:
                    result = self.imagegen.run_machine_task(
                        copy.deepcopy(task),
                        self.project_root,
                        self.artifact_root,
                        self.cfg,
                    )
                self.assertFalse(result["ok"])
                self.assertEqual(result["error"]["code"], expected_code)
                request.assert_not_called()

        unsupported = self.imagegen.Config(
            **{**self.cfg.__dict__, "capabilities": {**self.cfg.capabilities, "mask": False}}
        )
        with mock.patch.object(self.imagegen, "request_multipart") as request:
            result = self.imagegen.run_machine_task(
                self._task(),
                self.project_root,
                self.artifact_root,
                unsupported,
            )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "unsupported_capability")
        request.assert_not_called()

        for declared_value in (1, "false", "true"):
            non_boolean = self.imagegen.Config(
                **{
                    **self.cfg.__dict__,
                    "capabilities": {**self.cfg.capabilities, "mask": declared_value},
                }
            )
            with mock.patch.object(self.imagegen, "request_multipart") as request:
                result = self.imagegen.run_machine_task(
                    self._task(),
                    self.project_root,
                    self.artifact_root,
                    non_boolean,
                )
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"]["code"], "unsupported_capability")
            request.assert_not_called()

    def test_mask_preflight_rejects_repository_reparse_points_before_request(self) -> None:
        from scripts.repository_fs import DirectoryLease

        original_open_file = DirectoryLease.open_file

        def reject_mask(lease, relative_path):
            if Path(relative_path).parts[:1] == ("annotations",):
                raise ValueError("artifact path contains a reparse point: mask.png")
            return original_open_file(lease, relative_path)

        with (
            mock.patch(
                "scripts.mask_policy.DirectoryLease.open_file",
                autospec=True,
                side_effect=reject_mask,
            ),
            mock.patch.object(self.imagegen, "request_multipart") as request,
        ):
            result = self.imagegen.run_machine_task(
                self._task(),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "invalid_task")
        self.assertIn("reparse point", result["error"]["message"])
        request.assert_not_called()

    def test_masked_edit_reuses_verified_parent_and_mask_snapshots_without_reopening_paths(self) -> None:
        original_mask = self.mask_path.read_bytes()
        repository = self.imagegen.ArtifactRepository(self.project_root, self.artifact_root)
        original_parent = repository.get_artifact(self.parent_id).image_bytes

        def request_side_effect(_cfg, _path, _fields, files, _timeout):
            snapshots = {name: snapshot for name, _path, snapshot in files}
            self.assertEqual(snapshots["image[]"], original_parent)
            self.assertEqual(snapshots["mask"], original_mask)
            return {
                "data": [
                    {
                        "b64_json": base64.b64encode(
                            make_png(2, 2, self.generated_pixels)
                        ).decode("ascii")
                    }
                ]
            }

        with (
            mock.patch.object(
                Path,
                "read_bytes",
                side_effect=AssertionError("masked edit reopened a repository path"),
            ),
            mock.patch.object(
                self.imagegen,
                "request_multipart",
                side_effect=request_side_effect,
            ),
        ):
            result = self.imagegen.run_machine_task(
                self._task(),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )

        self.assertTrue(result["ok"], result)

    def test_mask_preflight_rejects_an_annotation_id_path_escape_before_request(self) -> None:
        with tempfile.TemporaryDirectory() as outside_directory:
            outside_mask = Path(outside_directory) / "mask.png"
            outside_mask.write_bytes(self.mask_bytes)
            task = self._task()
            escaped_annotation_id = str(Path(outside_directory).resolve())
            policy_body = {
                **task["maskPolicy"],
                "annotationId": escaped_annotation_id,
            }
            policy_body.pop("policySha256")
            canonical = json.dumps(policy_body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            task["annotationId"] = escaped_annotation_id
            task["mask"] = str(outside_mask)
            task["maskPolicy"] = {
                **policy_body,
                "policySha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
            }

            with mock.patch.object(self.imagegen, "request_multipart") as request:
                result = self.imagegen.run_machine_task(task, self.project_root, self.artifact_root, self.cfg)

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "invalid_task")
        self.assertIn("annotation ID", result["error"]["message"])
        request.assert_not_called()

    def test_mask_postflight_rejects_invalid_provider_results_without_child_versions(self) -> None:
        invalid_results = [
            b"not-a-png",
            make_png(3, 2, [(1, 2, 3, 255)] * 6),
        ]
        for generated_bytes in invalid_results:
            with self.subTest(length=len(generated_bytes)):
                response = {
                    "data": [
                        {"b64_json": base64.b64encode(generated_bytes).decode("ascii")}
                    ]
                }
                with mock.patch.object(
                    self.imagegen,
                    "request_multipart",
                    return_value=response,
                ) as request:
                    result = self.imagegen.run_machine_task(
                        self._task(),
                        self.project_root,
                        self.artifact_root,
                        self.cfg,
                    )
                self.assertFalse(result["ok"])
                request.assert_called_once()
                parent = self.imagegen.ArtifactRepository(self.project_root, self.artifact_root).get_artifact(self.parent_id)
                self.assertEqual(parent.metadata["childIds"], [])

        index = json.loads(
            (self.project_root / "output" / "imagegen" / "index.json").read_text(encoding="utf-8")
        )
        self.assertEqual(list(index["artifacts"]), [self.parent_id])


if __name__ == "__main__":
    unittest.main()
