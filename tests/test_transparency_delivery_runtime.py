from __future__ import annotations

import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from tests.test_image_runtime import load_imagegen, make_png


class TransparencyDeliveryRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime = load_imagegen()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.project_root = Path(self.temp_dir.name)
        self.artifact_root = self.project_root / "output" / "imagegen"
        self.repository = self.runtime.ArtifactRepository(
            self.project_root,
            self.artifact_root,
        )
        self.cfg = self.runtime.Config(
            base_url="https://images.example.test/v1",
            api_key="runtime-secret",
            api_key_source="test",
            model="gpt-image-2",
            defaults={},
            capabilities={
                "generate": True,
                "edit": True,
                "mask": False,
                "multi_reference": True,
            },
            postprocess={"enabled": True},
            user_agent="Imagegen-Test/1.0",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def store_source(
        self,
        image_bytes: bytes,
        *,
        parameters: dict | None = None,
        prompt: str = "source image",
    ):
        return self.repository.store_images(
            images=[image_bytes],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="generate",
            prompt=prompt,
            parameters=parameters or {},
        )[0]

    def run_task(self, task: dict):
        return self.runtime.run_machine_task(
            task,
            self.project_root,
            self.artifact_root,
            self.cfg,
        )

    def generation_task(self, operation: str, input_ids: list[str] | None = None) -> dict:
        return {
            "operation": operation,
            "modelProfileId": "primary/gpt-image-2",
            "prompt": "A red enamel badge",
            "inputArtifactIds": input_ids or [],
            "output": {"size": "1024x1024", "format": "png"},
            "transparency": {
                "route": "chroma-matting",
                "options": {"outer_tolerance": 150},
            },
        }

    def deliver(self, source_id: str, delivery: dict):
        return self.run_task(
            {
                "operation": "deliver",
                "modelProfileId": "primary/gpt-image-2",
                "inputArtifactIds": [source_id],
                "delivery": delivery,
            }
        )

    def chroma_source(self) -> bytes:
        width = height = 7
        green = (0, 255, 0, 255)
        red = (220, 30, 40, 255)
        pixels = [green] * (width * height)
        for y in range(2, 5):
            for x in range(2, 5):
                pixels[y * width + x] = red
        return self.runtime.encode_png_rgba(
            width,
            height,
            bytes(channel for pixel in pixels for channel in pixel),
        )

    def test_direct_delivery_allocates_and_persists_an_immutable_receipt(self) -> None:
        source = self.store_source(make_png(4, 4))

        result = self.deliver(
            source.metadata["id"],
            {"deliverySize": "8x8", "fit": "stretch", "qa": True},
        )

        self.assertTrue(result["ok"], result)
        self.assertRegex(result["deliveryReceiptId"], r"^delivery_[0-9a-f]{64}$")
        receipt = self.repository.get_delivery_receipt(result["deliveryReceiptId"])
        self.assertIsNotNone(receipt)
        self.assertEqual(receipt["sourceArtifactId"], source.metadata["id"])
        self.assertEqual(receipt["deliveryReady"], result["deliveryReady"])
        self.assertEqual(receipt["artifacts"], result["artifacts"])
        recovered = self.run_task({
            "operation": "get_delivery_receipt",
            "modelProfileId": "primary/gpt-image-2",
            "deliveryReceiptId": result["deliveryReceiptId"],
        })
        self.assertTrue(recovered["ok"], recovered)
        self.assertEqual(recovered["receipt"], receipt)

    def native_alpha_source(self) -> bytes:
        width = height = 5
        transparent = (0, 0, 0, 0)
        red = (220, 30, 40, 255)
        pixels = [transparent] * (width * height)
        for y in range(1, 4):
            for x in range(1, 4):
                pixels[y * width + x] = red
        return self.runtime.encode_png_rgba(
            width,
            height,
            bytes(channel for pixel in pixels for channel in pixel),
        )

    @staticmethod
    def saved_chroma_plan() -> dict:
        return {
            "requested": True,
            "mode": "chroma-matting",
            "key": "#00FF00",
            "options": {},
            "llm_assisted": {
                "enabled": False,
                "max_attempts": 2,
                "allow_parameter_tuning": True,
                "allow_route_change": True,
                "allow_api_retry": False,
            },
            "status": "pending",
            "warnings": [],
        }

    def assert_sanitized_saved_plan(self, artifact: dict, provider_prompt: str) -> None:
        self.assertIn(
            "transparency",
            artifact["parameters"],
            "generate/edit must persist the resolved transparency plan",
        )
        plan = artifact["parameters"]["transparency"]
        self.assertTrue(plan["requested"])
        self.assertEqual(plan["mode"], "chroma-matting")
        self.assertRegex(plan["key"], r"^#[0-9A-F]{6}$")
        self.assertEqual(plan["options"]["outer_tolerance"], 150.0)
        self.assertEqual(plan["status"], "pending")
        self.assertIn(plan["key"], provider_prompt)
        self.assertEqual(artifact["prompt"], "A red enamel badge")

        encoded = json.dumps(plan)
        self.assertNotIn("mask", plan)
        self.assertNotIn(str(self.project_root), encoded)
        self.assertNotIn("runtime-secret", encoded)
        self.assertNotIn(provider_prompt, encoded)

    def test_generate_saves_sanitized_nested_transparency_plan(self) -> None:
        provider_image = base64.b64encode(make_png(4, 4, alpha=0)).decode("ascii")
        with mock.patch.object(
            self.runtime,
            "request_json",
            return_value={"data": [{"b64_json": provider_image}]},
        ) as request:
            result = self.run_task(self.generation_task("generate"))

        self.assertTrue(result["ok"], result)
        self.assert_sanitized_saved_plan(
            result["artifacts"][0],
            request.call_args.args[2]["prompt"],
        )

    def test_edit_saves_sanitized_nested_transparency_plan(self) -> None:
        parent = self.store_source(make_png(4, 4))
        provider_image = base64.b64encode(make_png(4, 4, alpha=0)).decode("ascii")
        with mock.patch.object(
            self.runtime,
            "request_multipart",
            return_value={"data": [{"b64_json": provider_image}]},
        ) as request:
            result = self.run_task(self.generation_task("edit", [parent.metadata["id"]]))

        self.assertTrue(result["ok"], result)
        self.assert_sanitized_saved_plan(
            result["artifacts"][0],
            request.call_args.args[2]["prompt"],
        )

    def test_transparency_forces_the_api_original_to_png(self) -> None:
        task = self.generation_task("generate")
        task["output"]["format"] = "webp"
        provider_image = base64.b64encode(make_png(4, 4, alpha=0)).decode("ascii")

        with mock.patch.object(
            self.runtime,
            "request_json",
            return_value={"data": [{"b64_json": provider_image}]},
        ) as request:
            result = self.run_task(task)

        self.assertTrue(result["ok"], result)
        self.assertEqual(request.call_args.args[2]["output_format"], "png")
        self.assertEqual(result["artifacts"][0]["mimeType"], "image/png")

    def test_edit_submission_fingerprint_includes_transparency_semantics(self) -> None:
        task = self.generation_task("edit", ["img_01J00000000000000000000000"])
        params = {
            "size": "1024x1024",
            "quality": "medium",
            "format": "png",
            "count": 1,
            "background": "opaque",
            "compression": None,
            "timeout": 600,
        }
        changed = json.loads(json.dumps(task))
        changed["transparency"]["options"]["outer_tolerance"] = 160

        self.assertNotEqual(
            self.runtime.edit_submission_fingerprint(task, params),
            self.runtime.edit_submission_fingerprint(changed, params),
        )

        changed_delivery = json.loads(json.dumps(task))
        changed_delivery["delivery"] = {"deliverySize": "2048x2048", "qa": True}
        self.assertNotEqual(
            self.runtime.edit_submission_fingerprint(task, params),
            self.runtime.edit_submission_fingerprint(changed_delivery, params),
        )

    def test_prompt_alpha_allow_rule_enhances_the_request_and_accepts_native_alpha(self) -> None:
        self.cfg = self.runtime.parse_plugin_config(
            {
                "config_version": 1,
                "active_profile": "primary/gpt-image-2",
                "providers": {
                    "primary": {
                        "protocol": "openai-compatible",
                        "base_url": "https://images.example.test/v1",
                        "api_key": "runtime-secret",
                    }
                },
                "models": {
                    "primary/gpt-image-2": {
                        "provider": "primary",
                        "model": "gpt-image-2",
                        "capabilities": {"generate": True, "edit": True},
                    }
                },
                "postprocess": {"enabled": False},
                "transparency": {
                    "prompt_only_allow": [
                        {
                            "model": "gpt-image-2",
                            "mode": "generate",
                            "size": "1024x1024",
                        }
                    ]
                },
            },
            require_api_key=True,
            model_profile_id="primary/gpt-image-2",
        )
        task = self.generation_task("generate")
        task["transparency"] = {}
        provider_image = base64.b64encode(self.native_alpha_source()).decode("ascii")

        with mock.patch.object(
            self.runtime,
            "request_json",
            return_value={"data": [{"b64_json": provider_image}]},
        ) as request:
            result = self.run_task(task)

        self.assertTrue(result["ok"], result)
        self.assertIn("real alpha channel", request.call_args.args[2]["prompt"])
        source = result["artifacts"][0]
        self.assertEqual(source["parameters"]["transparency"]["mode"], "prompt-alpha")

        delivery = self.deliver(source["id"], {"qa": True})

        self.assertTrue(delivery["ok"], delivery)
        self.assertTrue(delivery["deliveryReady"], delivery)
        self.assertEqual(len(delivery["artifacts"]), 1)
        self.assertEqual(delivery["artifacts"][0]["deliveryKind"], "transparent")

    def test_inspect_alpha_keeps_the_prompt_and_preserves_an_opaque_original(self) -> None:
        self.cfg = self.runtime.Config(
            base_url="https://images.example.test/v1",
            api_key="runtime-secret",
            api_key_source="test",
            model="gpt-image-2",
            defaults={},
            capabilities={"generate": True, "edit": True},
            postprocess={"enabled": False},
            user_agent="Imagegen-Test/1.0",
        )
        task = self.generation_task("generate")
        task["transparency"] = {}
        provider_image = base64.b64encode(make_png(5, 5)).decode("ascii")

        with mock.patch.object(
            self.runtime,
            "request_json",
            return_value={"data": [{"b64_json": provider_image}]},
        ) as request:
            result = self.run_task(task)

        self.assertTrue(result["ok"], result)
        self.assertEqual(request.call_args.args[2]["prompt"], "A red enamel badge")
        source = result["artifacts"][0]
        self.assertEqual(source["parameters"]["transparency"]["mode"], "inspect-alpha")
        original_bytes = self.repository.get_artifact(source["id"]).image_bytes

        delivery = self.deliver(source["id"], {"qa": True})

        self.assertTrue(delivery["ok"], delivery)
        self.assertFalse(delivery["deliveryReady"], delivery)
        self.assertEqual(delivery["artifacts"], [])
        self.assertTrue(delivery["warnings"][0].startswith("source_alpha_unmet:"))
        self.assertEqual(
            self.repository.get_artifact(source["id"]).image_bytes,
            original_bytes,
        )

    def test_mask_alpha_plan_persists_only_the_stable_mask_image_id(self) -> None:
        parent = self.store_source(make_png(4, 4), prompt="parent")
        mask = self.store_source(make_png(4, 4, alpha=0), prompt="mask")
        task = self.generation_task("edit", [parent.metadata["id"]])
        task["transparency"] = {
            "route": "mask-alpha",
            "maskImageId": mask.metadata["id"],
            "options": {"source": "luminance"},
        }
        provider_image = base64.b64encode(make_png(4, 4, alpha=0)).decode("ascii")

        with mock.patch.object(
            self.runtime,
            "request_multipart",
            return_value={"data": [{"b64_json": provider_image}]},
        ):
            result = self.run_task(task)

        self.assertTrue(result["ok"], result)
        self.assertIn(
            "transparency",
            result["artifacts"][0]["parameters"],
            "edit must persist the resolved mask-alpha plan",
        )
        plan = result["artifacts"][0]["parameters"]["transparency"]
        self.assertEqual(plan["mode"], "mask-alpha")
        self.assertEqual(plan["maskImageId"], mask.metadata["id"])
        self.assertNotIn("mask", plan)
        self.assertNotIn(str(self.project_root), json.dumps(plan))

    def test_deliver_uses_saved_plan_to_publish_an_immutable_transparent_derivative(self) -> None:
        source = self.store_source(
            self.chroma_source(),
            parameters={"transparency": self.saved_chroma_plan()},
        )
        source_bytes = source.image_bytes

        result = self.deliver(source.metadata["id"], {"qa": True})

        self.assertTrue(result["ok"], result)
        self.assertTrue(result["deliveryReady"], result)
        self.assertEqual(len(result["artifacts"]), 1)
        derived = result["artifacts"][0]
        self.assertEqual(derived["operation"], "derive")
        self.assertEqual(derived["derivedFrom"], source.metadata["id"])
        self.assertNotEqual(derived["id"], source.metadata["id"])
        reopened = self.repository.get_artifact(derived["id"])
        decoded = self.runtime.decode_png_rgba(reopened.image_bytes)
        self.assertIn(0, decoded.pixels[3::4])
        self.assertEqual(
            self.repository.get_artifact(source.metadata["id"]).image_bytes,
            source_bytes,
        )
    def test_transparency_failure_preserves_source_and_publishes_no_derivatives(self) -> None:
        source = self.store_source(
            make_png(8, 8),
            parameters={"transparency": self.saved_chroma_plan()},
        )
        source_bytes = source.image_bytes

        result = self.deliver(
            source.metadata["id"],
            {
                "deliverySize": "16x16",
                "preview": {"sizes": ["8x8"], "backgrounds": ["white"]},
                "qa": True,
            },
        )

        self.assertTrue(result["ok"], result)
        self.assertFalse(result["deliveryReady"], result)
        self.assertEqual(result["artifacts"], [])
        self.assertEqual(
            self.repository.get_artifact(source.metadata["id"]).image_bytes,
            source_bytes,
        )
        index = json.loads(self.repository.index_path.read_text(encoding="utf-8"))
        self.assertEqual(set(index["artifacts"]), {source.metadata["id"]})

    def test_size_and_preview_run_only_after_transparency_succeeds(self) -> None:
        source = self.store_source(
            self.chroma_source(),
            parameters={"transparency": self.saved_chroma_plan()},
        )

        result = self.deliver(
            source.metadata["id"],
            {
                "deliverySize": "14x14",
                "resample": "nearest",
                "preview": {"sizes": ["7x7"], "backgrounds": ["white"]},
                "qa": True,
            },
        )

        self.assertTrue(result["ok"], result)
        self.assertTrue(result["deliveryReady"], result)
        by_kind = {artifact["deliveryKind"]: artifact for artifact in result["artifacts"]}
        self.assertIn("exact-size", by_kind)
        self.assertIn("preview-board", by_kind)
        exact_size = self.repository.get_artifact(by_kind["exact-size"]["id"])
        decoded = self.runtime.decode_png_rgba(exact_size.image_bytes)
        self.assertIn(0, decoded.pixels[3::4])

    def test_nested_inline_chroma_delivery_reuses_the_generated_plan(self) -> None:
        task = self.generation_task("generate")
        transparency = task.pop("transparency")
        task["delivery"] = {"transparency": transparency, "qa": True}
        provider_image = base64.b64encode(self.chroma_source()).decode("ascii")

        with mock.patch.object(
            self.runtime,
            "request_json",
            return_value={"data": [{"b64_json": provider_image}]},
        ):
            result = self.run_task(task)

        self.assertTrue(result["ok"], result)
        saved = result["artifacts"][0]["parameters"]["transparency"]
        self.assertEqual(saved["key"], "#00FF00")
        self.assertEqual(len(result["deliveries"]), 1)
        receipt = result["deliveries"][0]
        self.assertTrue(receipt["deliveryReady"], receipt)
        self.assertEqual(receipt["artifacts"][0]["deliveryKind"], "transparent")

    def test_nested_transparency_overrides_a_separate_generation_plan(self) -> None:
        task = self.generation_task("generate")
        task["delivery"] = {
            "transparency": {"route": "prompt-alpha"},
            "qa": True,
        }
        provider_image = base64.b64encode(self.chroma_source()).decode("ascii")

        with mock.patch.object(
            self.runtime,
            "request_json",
            return_value={"data": [{"b64_json": provider_image}]},
        ):
            result = self.run_task(task)

        self.assertTrue(result["ok"], result)
        self.assertEqual(
            result["artifacts"][0]["parameters"]["transparency"]["mode"],
            "chroma-matting",
        )
        receipt = result["deliveries"][0]
        self.assertFalse(receipt["deliveryReady"], receipt)
        self.assertEqual(receipt["summary"]["transforms"][0]["mode"], "inspect-alpha")

    def test_invalid_nested_transparency_is_rejected_before_provider_call(self) -> None:
        task = self.generation_task("generate")
        task["delivery"] = {
            "transparency": {"options": []},
            "qa": True,
        }

        with mock.patch.object(self.runtime, "request_json") as request:
            result = self.run_task(task)

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["error"]["code"], "invalid_task")
        request.assert_not_called()

    def test_missing_nested_transparency_mask_is_rejected_before_provider_call(self) -> None:
        task = self.generation_task("generate")
        task["delivery"] = {
            "transparency": {
                "route": "mask-alpha",
                "maskImageId": "img_00000000000000000000000000",
            },
            "qa": True,
        }

        with mock.patch.object(self.runtime, "request_json") as request:
            result = self.run_task(task)

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["error"]["code"], "artifact_not_found")
        request.assert_not_called()

    def test_invalid_nested_transparency_mask_id_is_invalid_task(self) -> None:
        task = self.generation_task("generate")
        task["delivery"] = {
            "transparency": {
                "route": "mask-alpha",
                "maskImageId": "not-an-image-id",
            },
            "qa": True,
        }

        with mock.patch.object(self.runtime, "request_json") as request:
            result = self.run_task(task)

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["error"]["code"], "invalid_task")
        request.assert_not_called()

    def test_invalid_standalone_transparency_is_not_downgraded_to_success(self) -> None:
        source = self.store_source(self.chroma_source())

        result = self.deliver(
            source.metadata["id"],
            {"transparency": {"options": []}, "qa": True},
        )

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["error"]["code"], "invalid_task")

    def test_missing_standalone_transparency_mask_is_artifact_not_found(self) -> None:
        source = self.store_source(self.chroma_source())

        result = self.deliver(
            source.metadata["id"],
            {
                "transparency": {
                    "route": "mask-alpha",
                    "maskImageId": "img_00000000000000000000000000",
                },
                "qa": True,
            },
        )

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["error"]["code"], "artifact_not_found")

    def test_transparency_cannot_hide_a_grid_without_delivery_size(self) -> None:
        source = self.store_source(
            self.chroma_source(),
            parameters={"transparency": self.saved_chroma_plan()},
        )

        result = self.deliver(
            source.metadata["id"],
            {"grid": "2x2", "expectedCount": 4, "qa": True},
        )

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["error"]["code"], "invalid_delivery")
        self.assertIn("grid requires deliverySize", result["error"]["message"])

    def test_expected_count_requires_grid(self) -> None:
        source = self.store_source(self.chroma_source())

        result = self.deliver(
            source.metadata["id"],
            {"expectedCount": 1, "qa": True},
        )

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["error"]["code"], "invalid_delivery")
        self.assertIn("expectedCount requires grid", result["error"]["message"])

    def test_committed_delivery_does_not_depend_on_artifact_reread(self) -> None:
        source = self.store_source(self.chroma_source())

        with mock.patch.object(
            self.runtime.ArtifactRepository,
            "get_artifact",
            side_effect=[source, FileNotFoundError("simulated post-commit reread failure")],
        ):
            result = self.deliver(
                source.metadata["id"],
                {"deliverySize": "16x16"},
            )

        self.assertTrue(result["ok"], result)
        self.assertTrue(result["deliveryReady"], result)
        self.assertEqual(len(result["artifacts"]), 1)
        committed = self.repository.get_artifact(result["artifacts"][0]["id"])
        self.assertEqual(committed.metadata["deliveryKind"], "exact-size")

    def test_edit_submission_replay_restores_the_same_inline_delivery_receipt(self) -> None:
        parent = self.store_source(make_png(7, 7), prompt="parent")
        task = self.generation_task("edit", [parent.metadata["id"]])
        task["submissionId"] = "sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        task["delivery"] = {"qa": True}
        provider_image = base64.b64encode(self.chroma_source()).decode("ascii")

        with mock.patch.object(
            self.runtime,
            "request_multipart",
            return_value={"data": [{"b64_json": provider_image}]},
        ) as request:
            first = self.run_task(task)
            delivered_id = first["deliveries"][0]["artifacts"][0]["id"]
            self.repository.store_images(
                images=[make_png(3, 3)],
                mime_type="image/png",
                provider="primary",
                model="gpt-image-2",
                operation="edit",
                prompt="later child",
                parameters={},
                parent_ids=[delivered_id],
            )
            replay = self.run_task(task)

        self.assertTrue(first["ok"], first)
        self.assertTrue(replay["ok"], replay)
        self.assertEqual(request.call_count, 1)
        self.assertEqual(
            [artifact["id"] for artifact in replay["artifacts"]],
            [artifact["id"] for artifact in first["artifacts"]],
        )
        self.assertEqual(replay["deliveries"], first["deliveries"])
        derived = [
            entry
            for entry in json.loads(self.repository.index_path.read_text(encoding="utf-8"))["artifacts"].values()
            if entry.get("derivedFrom") == first["artifacts"][0]["id"]
        ]
        self.assertEqual(len(derived), 1)

    def test_edit_submission_replay_completes_delivery_after_source_only_commit(self) -> None:
        parent = self.store_source(make_png(7, 7), prompt="parent")
        task = self.generation_task("edit", [parent.metadata["id"]])
        task["submissionId"] = "sub_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        task["delivery"] = {"qa": True}
        params = self.runtime.resolve_machine_output(task["output"], self.cfg)
        fingerprint = self.runtime.edit_submission_fingerprint(task, params)
        committed = self.repository.store_images(
            images=[self.chroma_source()],
            mime_type="image/png",
            provider="primary",
            model="gpt-image-2",
            operation="edit",
            prompt=task["prompt"],
            parameters={
                **{key: value for key, value in params.items() if key != "timeout"},
                "transparency": self.saved_chroma_plan(),
                "submissionId": task["submissionId"],
                "submissionRequestFingerprint": fingerprint,
            },
            parent_ids=[parent.metadata["id"]],
        )[0]

        with mock.patch.object(self.runtime, "request_multipart") as request:
            replay = self.run_task(task)

        self.assertTrue(replay["ok"], replay)
        request.assert_not_called()
        self.assertEqual(replay["artifacts"][0]["id"], committed.metadata["id"])
        self.assertTrue(replay["deliveries"][0]["deliveryReady"], replay)
        self.assertEqual(len(replay["deliveries"][0]["artifacts"]), 1)

    def test_edit_submission_replay_restores_a_failed_delivery_receipt(self) -> None:
        parent = self.store_source(make_png(5, 5), prompt="parent")
        task = self.generation_task("edit", [parent.metadata["id"]])
        task["submissionId"] = "sub_cccccccccccccccccccccccccccccccc"
        task["transparency"] = {"route": "prompt-alpha"}
        task["delivery"] = {"qa": True}
        provider_image = base64.b64encode(make_png(5, 5)).decode("ascii")

        with mock.patch.object(
            self.runtime,
            "request_multipart",
            return_value={"data": [{"b64_json": provider_image}]},
        ) as request:
            first = self.run_task(task)
            replay = self.run_task(task)

        self.assertTrue(first["ok"], first)
        self.assertEqual(request.call_count, 1)
        self.assertFalse(first["deliveries"][0]["deliveryReady"], first)
        self.assertEqual(first["deliveries"], replay["deliveries"])
        self.assertEqual(first["deliveries"][0]["artifacts"], [])

    def test_batch_task_keeps_the_api_original_and_returns_a_delivery_receipt(self) -> None:
        task = self.generation_task("generate")
        task["delivery"] = {"qa": True}
        provider_image = base64.b64encode(self.chroma_source()).decode("ascii")

        with mock.patch.object(
            self.runtime,
            "request_json",
            return_value={"data": [{"b64_json": provider_image}]},
        ):
            result = self.run_task(task)

        self.assertTrue(result["ok"], result)
        self.assertEqual(len(result["artifacts"]), 1)
        self.assertEqual(result["artifacts"][0]["operation"], "generate")
        self.assertEqual(len(result["deliveries"]), 1)
        receipt = result["deliveries"][0]
        self.assertTrue(receipt["deliveryReady"], receipt)
        self.assertEqual(receipt["sourceArtifactId"], result["artifacts"][0]["id"])
        self.assertEqual(len(receipt["artifacts"]), 1)
        self.assertEqual(receipt["artifacts"][0]["operation"], "derive")


if __name__ == "__main__":
    unittest.main()
