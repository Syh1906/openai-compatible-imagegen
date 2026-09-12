from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from image_request_options import resolve_request_options


class ImageRequestOptionTests(unittest.TestCase):
    def cfg(self, protocol="xai-images", defaults=None, version=2):
        return SimpleNamespace(protocol=protocol, model="custom", defaults=defaults or {}, config_version=version)

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
