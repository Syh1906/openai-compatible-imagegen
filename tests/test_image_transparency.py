from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from image_png import read_png_rgba, write_png_rgba  # noqa: E402
from image_transparency import (  # noqa: E402
    TransparencyContext,
    TransparencyPlan,
    TransparencyUnavailableError,
    process_file,
    resolve_plan,
    resolve_policy,
)


class TransparencyPlanTests(unittest.TestCase):
    def context(self, **overrides: object) -> TransparencyContext:
        values: dict[str, object] = {
            "requested": True,
            "prompt": "A red enamel badge",
            "model": "gpt-image-2",
            "mode": "generate",
            "size": "1024x1024",
            "postprocess_allowed": False,
            "reference_paths": (),
            "route": None,
            "mask_path": None,
            "options": {},
        }
        values.update(overrides)
        return TransparencyContext(**values)

    def test_postprocess_takes_priority_over_prompt_only_rule(self) -> None:
        policy = resolve_policy(
            {
                "prompt_only_allow": [
                    {"model": "gpt-image-2", "mode": "generate", "size": "1024x1024"}
                ]
            }
        )

        plan = resolve_plan(self.context(postprocess_allowed=True), policy)

        self.assertEqual(plan.mode, "chroma-matting")
        self.assertIsNotNone(plan.key_hex)
        self.assertIn(str(plan.key_hex), plan.prompt)
        self.assertNotIn("background=transparent", plan.prompt)

    def test_exact_prompt_only_rule_adds_real_alpha_contract(self) -> None:
        policy = resolve_policy(
            {
                "prompt_only_allow": [
                    {"model": "gpt-image-2", "mode": "generate", "size": "1024x1024"}
                ]
            }
        )

        plan = resolve_plan(self.context(), policy)

        self.assertEqual(plan.mode, "prompt-alpha")
        self.assertIsNone(plan.key_hex)
        self.assertIn("real alpha channel", plan.prompt)

    def test_prompt_only_rule_does_not_match_other_1k_dimensions(self) -> None:
        policy = resolve_policy(
            {
                "prompt_only_allow": [
                    {"model": "gpt-image-2", "mode": "generate", "size": "1024x1024"}
                ]
            }
        )

        with self.assertRaises(TransparencyUnavailableError):
            resolve_plan(self.context(size="1536x864"), policy)

    def test_chroma_matting_selection_avoids_prompt_color_conflicts(self) -> None:
        plan = resolve_plan(
            self.context(
                postprocess_allowed=True,
                prompt="A bright green emerald badge",
            ),
            resolve_policy(None),
        )

        self.assertEqual(plan.key_hex, "#00FFFF")

    def test_explicit_route_overrides_the_configured_default(self) -> None:
        policy = resolve_policy({"default_route": "chroma-matting"})

        plan = resolve_plan(
            self.context(postprocess_allowed=True, route="emissive-alpha"),
            policy,
        )

        self.assertEqual(plan.mode, "emissive-alpha")
        self.assertIn("pure black", plan.prompt.lower())

    def test_mask_route_requires_an_explicit_transparency_mask(self) -> None:
        policy = resolve_policy(None)

        with self.assertRaisesRegex(TransparencyUnavailableError, "transparency mask"):
            resolve_plan(
                self.context(postprocess_allowed=True, route="mask-alpha"),
                policy,
            )

        mask = Path("subject-mask.png").resolve()
        plan = resolve_plan(
            self.context(
                postprocess_allowed=True,
                route="mask-alpha",
                mask_path=mask,
            ),
            policy,
        )
        self.assertEqual(plan.mask_path, mask)

    def test_llm_assisted_policy_is_explicit_and_bounded(self) -> None:
        policy = resolve_policy(
            {
                "default_route": "emissive-alpha",
                "llm_assisted": {
                    "enabled": True,
                    "max_attempts": 2,
                    "allow_parameter_tuning": True,
                    "allow_route_change": True,
                    "allow_api_retry": False,
                    "allow_generated_code": False,
                },
            }
        )

        self.assertEqual(policy.default_route, "emissive-alpha")
        self.assertTrue(policy.llm_assisted.enabled)
        self.assertEqual(policy.llm_assisted.max_attempts, 2)
        self.assertFalse(policy.llm_assisted.allow_api_retry)

    def test_llm_assisted_policy_rejects_generated_code_and_excess_attempts(self) -> None:
        with self.assertRaisesRegex(ValueError, "allow_generated_code"):
            resolve_policy({"llm_assisted": {"allow_generated_code": True}})
        with self.assertRaisesRegex(ValueError, "max_attempts"):
            resolve_policy({"llm_assisted": {"max_attempts": 4}})

    def test_route_options_are_validated_before_the_request(self) -> None:
        plan = resolve_plan(
            self.context(
                postprocess_allowed=True,
                route="emissive-alpha",
                options={"black_point": 12, "gamma": 1.25},
            ),
            resolve_policy(None),
        )

        self.assertEqual(plan.options, {"black_point": 12, "gamma": 1.25})
        with self.assertRaisesRegex(ValueError, "unsupported transparency option"):
            resolve_plan(
                self.context(
                    postprocess_allowed=True,
                    route="emissive-alpha",
                    options={"unknown": 1},
                ),
                resolve_policy(None),
            )


class TransparencyProcessingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_prompt_alpha_failure_returns_original_bytes_with_warning(self) -> None:
        source = self.root / "opaque.png"
        target = self.root / "delivery.png"
        write_png_rgba(source, 4, 4, [(220, 30, 40, 255)] * 16)
        original = source.read_bytes()
        plan = TransparencyPlan(mode="prompt-alpha", prompt="prompt")

        result = process_file(source, target, plan)

        self.assertEqual(result["status"], "unmet")
        self.assertTrue(result["warnings"])
        self.assertEqual(target.read_bytes(), original)

    def test_prompt_alpha_success_preserves_native_alpha_bytes(self) -> None:
        source = self.root / "native.png"
        target = self.root / "delivery.png"
        pixels = [(0, 0, 0, 0)] * 16
        pixels[5] = (220, 30, 40, 255)
        write_png_rgba(source, 4, 4, pixels)
        original = source.read_bytes()
        plan = TransparencyPlan(mode="prompt-alpha", prompt="prompt")

        result = process_file(source, target, plan)

        self.assertEqual(result["status"], "pass")
        self.assertEqual(target.read_bytes(), original)

    def test_native_alpha_bypasses_local_transparency_processing(self) -> None:
        source = self.root / "native-colored-transparent-pixels.png"
        target = self.root / "delivery.png"
        pixels = [(0, 255, 0, 0)] * 16
        pixels[5] = (220, 30, 40, 255)
        write_png_rgba(source, 4, 4, pixels)
        original = source.read_bytes()

        result = process_file(
            source,
            target,
            TransparencyPlan(mode="emissive-alpha", prompt="prompt"),
        )

        self.assertEqual(result["status"], "pass", result)
        self.assertFalse(result["changed"])
        self.assertEqual(target.read_bytes(), original)

    def test_transparency_processing_pixel_limit_returns_original(self) -> None:
        source = self.root / "bounded.png"
        target = self.root / "delivery.png"
        write_png_rgba(source, 4, 4, [(0, 0, 0, 255)] * 16)
        original = source.read_bytes()
        plan = TransparencyPlan(mode="emissive-alpha", prompt="prompt")

        with mock.patch("image_transparency.MAX_TRANSPARENCY_PIXELS", 15):
            result = process_file(source, target, plan)

        self.assertEqual(result["status"], "unmet")
        self.assertIn("transparency_pixel_limit", result["warnings"][0])
        self.assertEqual(target.read_bytes(), original)

    def test_chroma_matting_removes_only_edge_connected_key_pixels(self) -> None:
        source = self.root / "chroma.png"
        target = self.root / "delivery.png"
        green = (0, 255, 0, 255)
        red = (220, 30, 40, 255)
        pixels = [green] * 49
        for y in range(2, 5):
            for x in range(2, 5):
                pixels[y * 7 + x] = red
        pixels[3 * 7 + 3] = green
        write_png_rgba(source, 7, 7, pixels)
        plan = TransparencyPlan(mode="chroma-matting", prompt="prompt", key_hex="#00FF00")

        result = process_file(source, target, plan)
        output = read_png_rgba(target)

        self.assertEqual(result["status"], "pass")
        self.assertEqual(output["pixels"][0][3], 0)
        self.assertEqual(output["pixels"][3 * 7 + 3], green)

    def test_chroma_matting_quality_failure_returns_original_bytes(self) -> None:
        source = self.root / "not-solid.png"
        target = self.root / "delivery.png"
        pixels = [
            (255, 255, 255, 255) if (x + y) % 2 else (0, 0, 0, 255)
            for y in range(8)
            for x in range(8)
        ]
        write_png_rgba(source, 8, 8, pixels)
        original = source.read_bytes()
        plan = TransparencyPlan(mode="chroma-matting", prompt="prompt", key_hex="#00FF00")

        result = process_file(source, target, plan)

        self.assertEqual(result["status"], "unmet")
        self.assertIn("background_not_solid", result["warnings"][0])
        self.assertEqual(target.read_bytes(), original)

    def test_chroma_matting_removes_moderate_key_color_spill(self) -> None:
        source = self.root / "spilled.png"
        target = self.root / "delivery.png"
        key = (0, 255, 0, 255)
        subject = (220, 30, 40, 255)
        spilled_edge = (0, 150, 20, 255)
        pixels = [key] * (16 * 16)
        for y in range(5, 11):
            for x in range(5, 11):
                pixels[y * 16 + x] = subject
        for y in range(4, 12):
            pixels[y * 16 + 4] = spilled_edge
            pixels[y * 16 + 11] = spilled_edge
        for x in range(4, 12):
            pixels[4 * 16 + x] = spilled_edge
            pixels[11 * 16 + x] = spilled_edge
        write_png_rgba(source, 16, 16, pixels)
        original = source.read_bytes()
        plan = TransparencyPlan(mode="chroma-matting", prompt="prompt", key_hex="#00FF00")

        result = process_file(source, target, plan)
        output = read_png_rgba(target)

        self.assertEqual(result["status"], "pass", result)
        self.assertIn("key_contamination", result["checks"])
        self.assertEqual(result["checks"]["key_contamination"]["status"], "pass")
        self.assertNotEqual(output["pixels"][4 * 16 + 4][:3], spilled_edge[:3])

    def test_chroma_matting_handles_the_previous_132_to_160_distance_gap(self) -> None:
        source = self.root / "outer-spill.png"
        target = self.root / "delivery.png"
        key = (0, 255, 0, 255)
        subject = (220, 30, 40, 255)
        spilled_edge = (0, 115, 20, 255)
        pixels = [key] * (16 * 16)
        for y in range(5, 11):
            for x in range(5, 11):
                pixels[y * 16 + x] = subject
        for y in range(4, 12):
            pixels[y * 16 + 4] = spilled_edge
            pixels[y * 16 + 11] = spilled_edge
        for x in range(4, 12):
            pixels[4 * 16 + x] = spilled_edge
            pixels[11 * 16 + x] = spilled_edge
        write_png_rgba(source, 16, 16, pixels)
        original = source.read_bytes()
        plan = TransparencyPlan(mode="chroma-matting", prompt="prompt", key_hex="#00FF00")

        result = process_file(source, target, plan)
        output = read_png_rgba(target)
        edge_alpha = output["pixels"][4 * 16 + 4][3]

        self.assertEqual(result["status"], "pass", result)
        self.assertGreater(edge_alpha, 0)
        self.assertLess(edge_alpha, 255)
        self.assertNotEqual(target.read_bytes(), original)
        self.assertEqual(result["checks"]["key_contamination"]["status"], "pass")

    def test_chroma_matting_applies_bounded_outer_tolerance(self) -> None:
        source = self.root / "tunable-spill.png"
        default_target = self.root / "default-chroma.png"
        tuned_target = self.root / "tuned-chroma.png"
        key = (0, 255, 0, 255)
        subject = (220, 30, 40, 255)
        spilled_edge = (0, 115, 20, 255)
        pixels = [key] * (16 * 16)
        for y in range(5, 11):
            for x in range(5, 11):
                pixels[y * 16 + x] = subject
        for y in range(4, 12):
            pixels[y * 16 + 4] = spilled_edge
            pixels[y * 16 + 11] = spilled_edge
        for x in range(4, 12):
            pixels[4 * 16 + x] = spilled_edge
            pixels[11 * 16 + x] = spilled_edge
        write_png_rgba(source, 16, 16, pixels)

        default_result = process_file(
            source,
            default_target,
            TransparencyPlan(mode="chroma-matting", prompt="prompt", key_hex="#00FF00"),
        )
        tuned_result = process_file(
            source,
            tuned_target,
            TransparencyPlan(
                mode="chroma-matting",
                prompt="prompt",
                key_hex="#00FF00",
                options={"outer_tolerance": 150},
            ),
        )
        default_alpha = read_png_rgba(default_target)["pixels"][4 * 16 + 4][3]
        tuned_alpha = read_png_rgba(tuned_target)["pixels"][4 * 16 + 4][3]

        self.assertEqual(default_result["status"], "pass", default_result)
        self.assertEqual(tuned_result["status"], "pass", tuned_result)
        self.assertGreater(tuned_alpha, default_alpha)
        self.assertEqual(tuned_result["checks"]["options"]["outer_tolerance"], 150.0)

    def test_chroma_matting_tuning_cannot_weaken_contamination_qa(self) -> None:
        source = self.root / "tuned-halo.png"
        target = self.root / "delivery.png"
        key = (0, 255, 0, 255)
        subject = (220, 30, 40, 255)
        unprocessed_halo = (0, 150, 20, 255)
        pixels = [key] * (16 * 16)
        for y in range(5, 11):
            for x in range(5, 11):
                pixels[y * 16 + x] = subject
        for y in range(4, 12):
            pixels[y * 16 + 4] = unprocessed_halo
            pixels[y * 16 + 11] = unprocessed_halo
        for x in range(4, 12):
            pixels[4 * 16 + x] = unprocessed_halo
            pixels[11 * 16 + x] = unprocessed_halo
        write_png_rgba(source, 16, 16, pixels)
        original = source.read_bytes()

        result = process_file(
            source,
            target,
            TransparencyPlan(
                mode="chroma-matting",
                prompt="prompt",
                key_hex="#00FF00",
                options={"inner_tolerance": 32, "outer_tolerance": 80},
            ),
        )

        self.assertEqual(result["status"], "unmet", result)
        self.assertEqual(result["checks"]["key_contamination"]["status"], "unmet")
        self.assertEqual(
            result["checks"]["key_contamination"]["tolerance"],
            160.0,
        )
        self.assertEqual(target.read_bytes(), original)

    def test_emissive_alpha_keeps_multiple_particles_and_soft_alpha(self) -> None:
        source = self.root / "particles.png"
        target = self.root / "delivery.png"
        width = height = 16
        pixels = [(0, 0, 0, 255)] * (width * height)
        pixels[4 * width + 4] = (255, 180, 20, 255)
        pixels[4 * width + 5] = (80, 45, 5, 255)
        pixels[11 * width + 11] = (20, 210, 255, 255)
        pixels[10 * width + 11] = (5, 55, 75, 255)
        write_png_rgba(source, width, height, pixels)
        plan = TransparencyPlan(mode="emissive-alpha", prompt="prompt")

        result = process_file(source, target, plan)
        output = read_png_rgba(target)["pixels"]

        self.assertEqual(result["status"], "pass", result)
        self.assertEqual(result["checks"]["profile"], "emissive")
        self.assertEqual(result["checks"]["component_gate"], "not_applied")
        self.assertEqual(output[0][3], 0)
        self.assertGreater(output[4 * width + 4][3], output[4 * width + 5][3])
        self.assertGreater(output[11 * width + 11][3], output[10 * width + 11][3])
        self.assertTrue(any(0 < pixel[3] < 255 for pixel in output))

    def test_emissive_alpha_rejects_a_nonblack_border_and_returns_original(self) -> None:
        source = self.root / "gray-background.png"
        target = self.root / "delivery.png"
        write_png_rgba(source, 8, 8, [(80, 80, 80, 255)] * 64)
        original = source.read_bytes()
        plan = TransparencyPlan(mode="emissive-alpha", prompt="prompt")

        result = process_file(source, target, plan)

        self.assertEqual(result["status"], "unmet")
        self.assertIn("background_not_dark", result["warnings"][0])
        self.assertEqual(target.read_bytes(), original)

    def test_mask_alpha_uses_a_continuous_grayscale_mask(self) -> None:
        source = self.root / "opaque-subject.png"
        mask = self.root / "subject-mask.png"
        target = self.root / "delivery.png"
        write_png_rgba(source, 4, 4, [(220, 30, 40, 255)] * 16)
        mask_pixels = [(0, 0, 0, 255)] * 16
        mask_pixels[5] = (255, 255, 255, 255)
        mask_pixels[6] = (128, 128, 128, 255)
        write_png_rgba(mask, 4, 4, mask_pixels)
        plan = TransparencyPlan(mode="mask-alpha", prompt="prompt", mask_path=mask)

        result = process_file(source, target, plan)
        output = read_png_rgba(target)["pixels"]

        self.assertEqual(result["status"], "pass", result)
        self.assertEqual(result["checks"]["profile"], "mask")
        self.assertEqual(output[0][3], 0)
        self.assertEqual(output[5][3], 255)
        self.assertIn(output[6][3], range(127, 130))

    def test_mask_alpha_dimension_mismatch_returns_original(self) -> None:
        source = self.root / "opaque-subject.png"
        mask = self.root / "wrong-size-mask.png"
        target = self.root / "delivery.png"
        write_png_rgba(source, 4, 4, [(220, 30, 40, 255)] * 16)
        write_png_rgba(mask, 2, 2, [(255, 255, 255, 255)] * 4)
        original = source.read_bytes()
        plan = TransparencyPlan(mode="mask-alpha", prompt="prompt", mask_path=mask)

        result = process_file(source, target, plan)

        self.assertEqual(result["status"], "unmet")
        self.assertIn("mask_dimensions_mismatch", result["warnings"][0])
        self.assertEqual(target.read_bytes(), original)

    def test_emissive_alpha_applies_bounded_tuning_options(self) -> None:
        source = self.root / "tuned-particles.png"
        default_target = self.root / "default.png"
        tuned_target = self.root / "tuned.png"
        width = height = 8
        pixels = [(0, 0, 0, 255)] * (width * height)
        for y in range(3, 5):
            for x in range(3, 5):
                pixels[y * width + x] = (80, 45, 5, 255)
        write_png_rgba(source, width, height, pixels)

        default_result = process_file(
            source,
            default_target,
            TransparencyPlan(mode="emissive-alpha", prompt="prompt"),
        )
        tuned_result = process_file(
            source,
            tuned_target,
            TransparencyPlan(
                mode="emissive-alpha",
                prompt="prompt",
                options={"black_point": 40, "white_point": 200, "gamma": 1.5},
            ),
        )
        default_alpha = read_png_rgba(default_target)["pixels"][3 * width + 3][3]
        tuned_alpha = read_png_rgba(tuned_target)["pixels"][3 * width + 3][3]

        self.assertEqual(default_result["status"], "pass", default_result)
        self.assertEqual(tuned_result["status"], "pass", tuned_result)
        self.assertLess(tuned_alpha, default_alpha)
        self.assertEqual(tuned_result["checks"]["options"]["gamma"], 1.5)

    def test_mask_alpha_applies_expand_and_feather_options(self) -> None:
        source = self.root / "mask-options-source.png"
        mask = self.root / "mask-options.png"
        target = self.root / "mask-options-delivery.png"
        width = height = 8
        write_png_rgba(source, width, height, [(220, 30, 40, 255)] * (width * height))
        mask_pixels = [(0, 0, 0, 255)] * (width * height)
        mask_pixels[4 * width + 4] = (255, 255, 255, 255)
        write_png_rgba(mask, width, height, mask_pixels)
        plan = TransparencyPlan(
            mode="mask-alpha",
            prompt="prompt",
            mask_path=mask,
            options={"threshold": 128, "expand": 1, "feather": 1},
        )

        result = process_file(source, target, plan)
        output = read_png_rgba(target)["pixels"]

        self.assertEqual(result["status"], "pass", result)
        self.assertEqual(result["checks"]["options"]["expand"], 1)
        self.assertGreater(output[4 * width + 4][3], output[2 * width + 2][3])
        self.assertTrue(any(0 < pixel[3] < 255 for pixel in output))


if __name__ == "__main__":
    unittest.main()
