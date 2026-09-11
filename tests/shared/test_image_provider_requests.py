from __future__ import annotations

from pathlib import Path
import argparse
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

import image_provider_requests as requests
import imagegen
import image_runtime
from provider_config import EffectiveImageConfig


class ProviderRequestTests(unittest.TestCase):
    def test_both_adapters_preserve_native_refusal_error_kind(self):
        cfg = self.config(protocol="gemini-generate-content", config_version=2)
        for adapter in (imagegen, image_runtime):
            with self.subTest(adapter=adapter.__name__), mock.patch.object(requests.image_transport, "request_json", return_value={"promptFeedback": {"blockReason": "SAFETY"}}), self.assertRaises(Exception) as caught:
                adapter.request_json(cfg, "images/generations", {"prompt": "cube"}, 30)
            self.assertEqual(getattr(caught.exception, "error_kind", None), "image_content_blocked")

    def test_adapters_do_not_inject_openai_defaults_into_native_intent(self):
        cfg = self.config(protocol="gemini-generate-content", config_version=2)
        params = image_runtime.resolve_machine_output({"aspectRatio": "5:7", "resolution": "8K"}, cfg)
        self.assertIsNone(params["size"])
        self.assertIsNone(params["format"])
        self.assertIsNone(params["quality"])
        self.assertEqual(params["aspectRatio"], "5:7")
        params = imagegen.resolve_common_params(argparse.Namespace(aspect="5:7", resolution="8K"), cfg)
        self.assertIsNone(params["size"])
        self.assertIsNone(params["output_format"])
        self.assertIsNone(params["quality"])
        self.assertEqual(params["aspect"], "5:7")

    def config(self, **values):
        return EffectiveImageConfig(base_url="https://base.example.test/v1beta", api_key="test-only", api_key_source="fixture", model="custom/image", defaults={}, postprocess={}, **values)

    def test_native_transport_uses_selected_endpoint_auth_and_response_parser(self):
        cfg = self.config(protocol="gemini-generate-content", endpoints={"generate": "https://generate.example.test/{model}:generateContent"}, parameters={"generationConfig": {"seed": 7}})
        with mock.patch.object(requests.image_transport, "request_json", return_value={"candidates": [{"content": {"parts": [{"inlineData": {"data": "final"}}]}}]}) as send:
            result = requests.request_image(cfg, "generate", {"model": cfg.model, "prompt": "cube", "aspectRatio": "3:2", "n": 1}, 30)
        self.assertEqual(result, {"data": [{"b64_json": "final"}]})
        self.assertEqual(send.call_args.kwargs["endpoint"], "https://generate.example.test/custom%2Fimage:generateContent")
        self.assertEqual(send.call_args.kwargs["auth_header"], "x-goog-api-key")
        self.assertEqual(send.call_args.kwargs["payload"]["generationConfig"]["seed"], 7)
        self.assertNotIn("model", send.call_args.kwargs["payload"])

    def test_openai_custom_endpoint_and_parameters_keep_multipart_edit(self):
        cfg = self.config(endpoints={"edit": "https://edit.example.test/transform"}, parameters={"seed": 7})
        uploads = [("image", Path("not-read.png"), b"snapshot")]
        with mock.patch.object(requests.image_transport, "request_multipart", return_value={"data": []}) as send:
            requests.request_image(cfg, "edit", {"model": cfg.model, "prompt": "blue"}, 30, files=uploads)
        self.assertEqual(send.call_args.kwargs["endpoint"], cfg.endpoints["edit"])
        self.assertEqual(send.call_args.kwargs["files"], uploads)
        self.assertEqual(send.call_args.kwargs["fields"]["seed"], 7)

    def test_both_adapters_dispatch_native_requests_through_shared_protocol(self):
        cfg = self.config(protocol="xai-images")
        for adapter in (imagegen, image_runtime):
            with self.subTest(adapter=adapter.__name__), mock.patch.object(requests.image_transport, "request_json", return_value={"data": []}), mock.patch.object(requests.image_transport, "request_multipart", return_value={"data": []}), mock.patch.object(requests, "request_image", return_value={"data": []}) as send:
                adapter.request_json(cfg, "images/generations", {"prompt": "cube"}, 30)
                self.assertEqual(send.call_args.args[1], "generate")
                adapter.request_multipart(cfg, "images/edits", {"prompt": "blue"}, [], 30)
                self.assertEqual(send.call_args.args[1], "edit")


if __name__ == "__main__":
    unittest.main()
