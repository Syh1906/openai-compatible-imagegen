from __future__ import annotations

import base64
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

import native_image_protocols as native


class NativeImageProtocolTests(unittest.TestCase):
    def test_final_output_errors_distinguish_refusal_empty_pending_and_mime(self):
        cases = [
            ("gemini-generate-content", {"promptFeedback": {"blockReason": "SAFETY"}}, "image_content_blocked"),
            ("gemini-generate-content", {"candidates": []}, "image_response_empty"),
            ("gemini-interactions", {"status": "in_progress"}, "image_response_incomplete"),
            ("gemini-generate-content", {"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "audio/wav", "data": "other"}}]}}]}, "image_response_invalid_mime"),
        ]
        for protocol, response, code in cases:
            with self.subTest(code=code), self.assertRaises(native.ProtocolError) as caught:
                native.normalize_response(protocol, response)
            self.assertEqual(caught.exception.code, code)

    def test_native_parameters_extend_fields_without_replacing_request_identity(self):
        request = native.build_request("gemini-generate-content", "future/image", "red", {}, parameters={"generationConfig": {"seed": 7, "imageConfig": {"futureOption": True}}})
        self.assertEqual(request.payload["generationConfig"]["seed"], 7)
        self.assertEqual(request.payload["generationConfig"]["responseModalities"], ["IMAGE"])
        self.assertTrue(request.payload["generationConfig"]["imageConfig"]["futureOption"])
        for parameters in ({"model": "other"}, {"contents": []}, {"input": "other"}, {"n": 5}):
            with self.assertRaises(ValueError):
                native.build_request("gemini-generate-content", "future/image", "red", {}, parameters=parameters)

    def test_xai_generation_has_native_fields_and_preserves_model_id(self):
        request = native.build_request("xai-images", "vendor/custom", "red cube", {"aspectRatio": "1:1", "resolution": "1K", "quality": "low"})
        self.assertEqual(request.path, "images/generations")
        self.assertEqual(request.payload, {"model": "vendor/custom", "prompt": "red cube", "n": 1, "aspect_ratio": "1:1", "resolution": "1k", "quality": "low", "response_format": "b64_json"})
        self.assertEqual(request.auth_header, "Authorization")

    def test_xai_single_and_multi_reference_use_native_objects(self):
        with mock.patch.object(native, "inspect_response_image", return_value=mock.Mock(image_format="jpeg")):
            single = native.build_request("xai-images", "grok-imagine-image-2.0", "blue", {}, images=[b"source"])
            multi = native.build_request("xai-images", "grok-imagine-image-2.0", "blue", {}, images=[b"source", b"other"])
        self.assertEqual(single.path, "images/edits")
        self.assertEqual(single.payload["image"], {"url": "data:image/jpeg;base64," + base64.b64encode(b"source").decode(), "type": "image_url"})
        self.assertNotIn("images", single.payload)
        self.assertEqual(len(multi.payload["images"]), 2)

    def test_generate_content_encodes_model_path_and_has_no_body_model(self):
        request = native.build_request("gemini-generate-content", "models/custom/name", "red", {"aspectRatio": "1:1", "resolution": "1K"})
        self.assertEqual(request.path, "models/models%2Fcustom%2Fname:generateContent")
        self.assertEqual(request.auth_header, "x-goog-api-key")
        self.assertNotIn("model", request.payload)
        self.assertEqual(request.payload["generationConfig"], {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "1:1", "imageSize": "1K"}})

    def test_gemini_edit_snapshots_are_inline_data(self):
        with mock.patch.object(native, "inspect_response_image", return_value=mock.Mock(image_format="png")):
            request = native.build_request("gemini-generate-content", "gemini-3.1-flash-image", "blue", {}, images=[b"immutable"])
        self.assertEqual(request.payload["contents"][0]["parts"][1], {"inlineData": {"mimeType": "image/png", "data": base64.b64encode(b"immutable").decode()}})

    def test_interactions_is_separate_and_stateless(self):
        request = native.build_request("gemini-interactions", "gemini-3.1-flash-image", "red", {"resolution": "2K"})
        self.assertEqual(request.path, "interactions")
        self.assertFalse(request.payload["store"])
        self.assertEqual(request.payload["response_format"], {"type": "image", "image_size": "2K"})
        self.assertNotIn("contents", request.payload)

    def test_provider_parameter_values_are_not_limited_to_tested_combinations(self):
        request = native.build_request("xai-images", "custom-model", "red", {"quality": "future-tier", "resolution": "8K", "aspectRatio": "5:7"}, count=12)
        self.assertEqual(request.payload["quality"], "future-tier")
        self.assertEqual(request.payload["resolution"], "8k")
        self.assertEqual(request.payload["aspect_ratio"], "5:7")
        self.assertEqual(request.payload["n"], 12)

    def test_generate_content_excludes_thought_and_reports_blocked_empty(self):
        response = {"candidates": [{"content": {"parts": [{"thought": True, "inlineData": {"data": "private"}}, {"text": "description"}, {"inlineData": {"mimeType": "image/png", "data": "valid"}}]}}]}
        self.assertEqual(native.normalize_response("gemini-generate-content", response)["data"], [{"b64_json": "valid"}])
        for response in ({"promptFeedback": {"blockReason": "SAFETY"}}, {"candidates": [{"content": {"parts": [{"text": "no image"}]}}]}):
            with self.assertRaises(native.ProtocolError):
                native.normalize_response("gemini-generate-content", response)

    def test_interactions_requires_completed_final_output(self):
        response = {"status": "completed", "steps": [{"type": "input", "content": [{"type": "image", "data": "echo"}]}, {"type": "model_output", "content": [{"type": "image", "data": "ok"}]}]}
        self.assertEqual(native.normalize_response("gemini-interactions", response)["data"], [{"b64_json": "ok"}])
        response["status"] = "in_progress"
        with self.assertRaises(native.ProtocolError):
            native.normalize_response("gemini-interactions", response)


if __name__ == "__main__":
    unittest.main()
