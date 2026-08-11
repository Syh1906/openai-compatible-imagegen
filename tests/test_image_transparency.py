from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest


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

        self.assertEqual(plan.mode, "chroma-key")
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

    def test_chroma_key_selection_avoids_prompt_color_conflicts(self) -> None:
        plan = resolve_plan(
            self.context(
                postprocess_allowed=True,
                prompt="A bright green emerald badge",
            ),
            resolve_policy(None),
        )

        self.assertEqual(plan.key_hex, "#00FFFF")


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

    def test_chroma_key_removes_only_edge_connected_key_pixels(self) -> None:
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
        plan = TransparencyPlan(mode="chroma-key", prompt="prompt", key_hex="#00FF00")

        result = process_file(source, target, plan)
        output = read_png_rgba(target)

        self.assertEqual(result["status"], "pass")
        self.assertEqual(output["pixels"][0][3], 0)
        self.assertEqual(output["pixels"][3 * 7 + 3], green)

    def test_chroma_key_quality_failure_returns_original_bytes(self) -> None:
        source = self.root / "not-solid.png"
        target = self.root / "delivery.png"
        pixels = [
            (255, 255, 255, 255) if (x + y) % 2 else (0, 0, 0, 255)
            for y in range(8)
            for x in range(8)
        ]
        write_png_rgba(source, 8, 8, pixels)
        original = source.read_bytes()
        plan = TransparencyPlan(mode="chroma-key", prompt="prompt", key_hex="#00FF00")

        result = process_file(source, target, plan)

        self.assertEqual(result["status"], "unmet")
        self.assertIn("background_not_solid", result["warnings"][0])
        self.assertEqual(target.read_bytes(), original)

    def test_chroma_key_removes_moderate_key_color_spill(self) -> None:
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
        plan = TransparencyPlan(mode="chroma-key", prompt="prompt", key_hex="#00FF00")

        result = process_file(source, target, plan)
        output = read_png_rgba(target)

        self.assertEqual(result["status"], "pass", result)
        self.assertIn("key_contamination", result["checks"])
        self.assertEqual(result["checks"]["key_contamination"]["status"], "pass")
        self.assertNotEqual(output["pixels"][4 * 16 + 4][:3], spilled_edge[:3])

    def test_chroma_key_rejects_unrecoverable_key_color_on_subject_boundary(self) -> None:
        source = self.root / "unrecoverable-spill.png"
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
        plan = TransparencyPlan(mode="chroma-key", prompt="prompt", key_hex="#00FF00")

        result = process_file(source, target, plan)

        self.assertEqual(result["status"], "unmet")
        self.assertEqual(result["checks"]["key_contamination"]["status"], "unmet")
        self.assertEqual(target.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
