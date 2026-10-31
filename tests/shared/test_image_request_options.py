from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from image_request_options import resolve_request_options


class ImageRequestOptionTests(unittest.TestCase):
    def cfg(self, protocol="xai-images", defaults=None, version=2, limits=None):
        return SimpleNamespace(protocol=protocol, model="custom", defaults=defaults or {}, config_version=version, limits=limits or {})

    def test_declared_size_limits_reject_invalid_dimensions(self):
        cfg = self.cfg("openai-compatible", limits={"output_size": {"multiple_of": 16, "max_aspect_ratio": 3}})
        for size in ("3072x704", "704x3072", "1537x1024"):
            with self.subTest(size=size), self.assertRaises(ValueError):
                resolve_request_options(cfg, {"size": size})
        for size in ("3072x1024", "1024x3072", "1536x1024"):
            self.assertEqual(resolve_request_options(cfg, {"size": size})["size"], size)

    def test_only_final_merged_size_is_checked_without_rewriting_it(self):
        cfg = self.cfg("openai-compatible", defaults={"size": "3072x704"}, limits={"output_size": {"max_aspect_ratio": 3}})
        with self.assertRaises(ValueError):
            resolve_request_options(cfg, {})
        self.assertEqual(resolve_request_options(cfg, {"size": "1536x1024"})["size"], "1536x1024")
        self.assertEqual(cfg.defaults["size"], "3072x704")

    def test_unknown_limits_do_not_infer_model_constraints(self):
        cfg = self.cfg("openai-compatible")
        cfg.model = "gpt-image-2"
        self.assertEqual(resolve_request_options(cfg, {"size": "3072x704"})["size"], "3072x704")

    def test_fixed_sizes_edges_and_pixel_bounds_are_inclusive(self):
        for limits, accepted, rejected in (
            ({"allowed_sizes": ["1024x1024", "1536x1024"]}, "1536x1024", "1024x1536"),
            ({"min_edge": 512, "max_edge": 2048}, "512x2048", "511x2048"),
            ({"min_edge": 512, "max_edge": 2048}, "2048x512", "512x2049"),
            ({"min_pixels": 1048576, "max_pixels": 2097152}, "1024x1024", "1024x1023"),
            ({"min_pixels": 1048576, "max_pixels": 2097152}, "2048x1024", "2048x1025"),
        ):
            cfg = self.cfg("openai-compatible", limits={"output_size": limits})
            with self.subTest(limits=limits):
                self.assertEqual(resolve_request_options(cfg, {"size": accepted})["size"], accepted)
                with self.assertRaises(ValueError):
                    resolve_request_options(cfg, {"size": rejected})

    def test_native_protocols_have_no_openai_output_defaults(self):
        for protocol in ("xai-images", "gemini-interactions", "gemini-generate-content"):
            result = resolve_request_options(self.cfg(protocol), {})
            self.assertIsNone(result["size"])
            self.assertIsNone(result["format"])
            self.assertIsNone(result["quality"])

    def test_explicit_dimensions_replace_profile_dimension_intent(self):
        result = resolve_request_options(self.cfg(defaults={"size": "1024x1024"}), {"aspectRatio": "16:9", "resolution": "2K"})
        self.assertEqual(result["aspectRatio"], "16:9")
        self.assertIsNone(result["size"])

    def test_same_layer_conflict_is_rejected(self):
        with self.assertRaises(ValueError):
            resolve_request_options(self.cfg(), {"size": "1024x1024", "resolution": "1K"})

    def test_profile_parameter_values_are_preserved_for_provider_validation(self):
        options = resolve_request_options(self.cfg(defaults={"quality": "future-tier"}), {})
        self.assertEqual(options["quality"], "future-tier")

    def test_legacy_openai_defaults_are_preserved(self):
        result = resolve_request_options(self.cfg("openai-compatible", version=1), {})
        self.assertEqual(result["size"], "1024x1024")
        self.assertEqual(result["format"], "png")
