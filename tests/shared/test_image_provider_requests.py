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
    def test_legacy_auto_size_remains_service_selected_with_pixel_limits(self):
        for protocol in ("openai-compatible", "atlas"):
            cfg = self.config(protocol=protocol, limits={"output_size": {"multiple_of": 16, "max_aspect_ratio": 3}})
            with self.subTest(protocol=protocol):
                self.assertEqual(imagegen.resolve_common_params(argparse.Namespace(size="auto"), cfg)["size"], "auto")
        cfg = self.config(limits={"output_size": {"max_aspect_ratio": 3}})
        with mock.patch.object(requests.image_transport, "request_json", return_value={"data": []}) as send:
            imagegen.request_json(cfg, "images/generations", {"size": "auto"}, 30)
            self.assertEqual(send.call_args.kwargs["payload"]["size"], "auto")
        with mock.patch.object(requests.image_transport, "request_multipart", return_value={"data": []}) as send:
            imagegen.request_multipart(cfg, "images/edits", {"size": "auto"}, [], 30)
            self.assertEqual(send.call_args.kwargs["fields"]["size"], "auto")

    def test_legacy_model_override_does_not_inherit_another_models_size_limits(self):
        cfg = self.config(limits={"output_size": {"max_aspect_ratio": 3}})
        args = argparse.Namespace(model="another-model", size="3072x704")
        selected = imagegen.request_config(cfg, args, {})
        self.assertEqual(selected.model, "another-model")
        self.assertEqual(selected.limits, {})
        self.assertEqual(imagegen.resolve_common_params(args, selected)["size"], "3072x704")
        self.assertEqual(cfg.limits, {"output_size": {"max_aspect_ratio": 3}})

    def test_both_adapters_reject_declared_size_before_transport(self):
        for version in (1, 2):
            cfg = self.config(config_version=version, limits={"output_size": {"max_aspect_ratio": 3}})
            for adapter in (imagegen, image_runtime):
                with self.subTest(version=version, adapter=adapter.__name__):
                    with self.assertRaises(Exception) as caught:
                        if adapter is imagegen:
                            adapter.resolve_common_params(argparse.Namespace(size="3072x704"), cfg)
                        else:
                            adapter.resolve_machine_output({"size": "3072x704"}, cfg)
                    self.assertIn("3072x704", str(caught.exception))
                    self.assertIn("3", str(caught.exception))
                    with mock.patch.object(requests.image_transport, "request_json") as generate, mock.patch.object(requests.image_transport, "request_multipart") as edit:
                        with self.assertRaises(Exception):
                            adapter.request_json(cfg, "images/generations", {"size": "3072x704"}, 30)
                        with self.assertRaises(Exception):
                            adapter.request_multipart(cfg, "images/edits", {"size": "704x3072"}, [], 30)
                        generate.assert_not_called()
                        edit.assert_not_called()

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
