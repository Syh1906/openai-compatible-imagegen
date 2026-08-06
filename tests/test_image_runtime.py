from __future__ import annotations

import base64
import importlib.util
import json
from pathlib import Path
import ssl
import sys
import tempfile
import unittest
from unittest import mock
import zlib


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "imagegen.py"


def load_imagegen():
    spec = importlib.util.spec_from_file_location("imagegen_runtime_under_test", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load imagegen.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def make_png(width: int, height: int) -> bytes:
    raw = bytearray()
    for _ in range(height):
        raw.append(0)
        raw.extend((0, 128, 255, 255) * width)

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


class ImageRuntimeMachineModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.imagegen = load_imagegen()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.project_root = Path(self.temp_dir.name)
        self.cfg = self.imagegen.Config(
            base_url="https://images.example.test/v1",
            api_key="runtime-secret",
            api_key_source="test",
            model="gpt-image-2",
            defaults={},
            capabilities={"transparent_background": True},
            postprocess={"enabled": False},
            user_agent="Imagegen-Test/1.0",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def task(self, **updates):
        task = {
            "operation": "generate",
            "modelProfileId": "primary/gpt-image-2",
            "prompt": "two candidates",
            "inputArtifactIds": [],
            "annotationId": None,
            "output": {
                "size": "1024x1024",
                "quality": "high",
                "format": "png",
                "count": 2,
                "background": "opaque",
            },
        }
        task.update(updates)
        return task

    def test_generate_returns_multiple_safe_artifacts(self) -> None:
        response = {
            "data": [
                {"b64_json": base64.b64encode(make_png(3, 2)).decode("ascii")},
                {"b64_json": base64.b64encode(make_png(4, 3)).decode("ascii")},
            ]
        }
        with mock.patch.object(self.imagegen, "request_json", return_value=response) as request:
            result = self.imagegen.run_machine_task(self.task(), self.project_root, self.cfg)

        self.assertTrue(result["ok"])
        self.assertEqual(len(result["artifacts"]), 2)
        self.assertEqual(result["artifacts"][0]["width"], 3)
        self.assertEqual(result["artifacts"][1]["height"], 3)
        encoded = json.dumps(result)
        self.assertNotIn("runtime-secret", encoded)
        self.assertNotIn(str(self.project_root), encoded)
        payload = request.call_args.args[2]
        self.assertEqual(payload["n"], 2)
        self.assertEqual(payload["model"], "gpt-image-2")

    def test_edit_creates_child_version_without_overwriting_parent(self) -> None:
        generated = {"data": [{"b64_json": base64.b64encode(make_png(2, 2)).decode("ascii")}]}
        with mock.patch.object(self.imagegen, "request_json", return_value=generated):
            parent_result = self.imagegen.run_machine_task(
                self.task(output={**self.task()["output"], "count": 1}),
                self.project_root,
                self.cfg,
            )
        parent_id = parent_result["artifacts"][0]["id"]
        parent_path = self.project_root / "output" / "imagegen" / "artifacts" / parent_id / "image.png"
        parent_bytes = parent_path.read_bytes()

        edited = {"data": [{"b64_json": base64.b64encode(make_png(5, 4)).decode("ascii")}]}
        edit_task = self.task(
            operation="edit",
            prompt="make it larger",
            inputArtifactIds=[parent_id],
            output={**self.task()["output"], "count": 1},
        )
        with mock.patch.object(self.imagegen, "request_multipart", return_value=edited):
            child_result = self.imagegen.run_machine_task(edit_task, self.project_root, self.cfg)

        self.assertTrue(child_result["ok"])
        self.assertEqual(child_result["artifacts"][0]["parentIds"], [parent_id])
        self.assertEqual(parent_path.read_bytes(), parent_bytes)

    def test_edit_uploads_the_explicit_mask_when_the_model_supports_it(self) -> None:
        cfg = self.imagegen.Config(
            **{**self.cfg.__dict__, "capabilities": {"mask": True}}
        )
        generated = {"data": [{"b64_json": base64.b64encode(make_png(2, 2)).decode("ascii")}]}
        with mock.patch.object(self.imagegen, "request_json", return_value=generated):
            parent_result = self.imagegen.run_machine_task(
                self.task(output={**self.task()["output"], "count": 1}),
                self.project_root,
                cfg,
            )
        parent_id = parent_result["artifacts"][0]["id"]
        mask_path = self.project_root / "output" / "imagegen" / "annotations" / "ann_fixture" / "mask.png"
        mask_path.parent.mkdir(parents=True)
        mask_path.write_bytes(make_png(2, 2))
        edit_task = self.task(
            operation="edit",
            prompt="replace the marked region",
            inputArtifactIds=[parent_id],
            mask=str(mask_path),
            output={**self.task()["output"], "count": 1},
        )

        with mock.patch.object(self.imagegen, "request_multipart", return_value=generated) as request:
            result = self.imagegen.run_machine_task(edit_task, self.project_root, cfg)

        self.assertTrue(result["ok"])
        self.assertIn(("mask", mask_path), request.call_args.args[3])

    def test_edit_with_mask_stops_before_request_when_capability_is_missing(self) -> None:
        generated = {"data": [{"b64_json": base64.b64encode(make_png(2, 2)).decode("ascii")}]}
        with mock.patch.object(self.imagegen, "request_json", return_value=generated):
            parent_result = self.imagegen.run_machine_task(
                self.task(output={**self.task()["output"], "count": 1}),
                self.project_root,
                self.cfg,
            )
        parent_id = parent_result["artifacts"][0]["id"]
        mask_path = self.project_root / "mask.png"
        mask_path.write_bytes(make_png(2, 2))
        edit_task = self.task(
            operation="edit",
            prompt="replace the marked region",
            inputArtifactIds=[parent_id],
            mask=str(mask_path),
            output={**self.task()["output"], "count": 1},
        )

        with mock.patch.object(self.imagegen, "request_multipart") as request:
            result = self.imagegen.run_machine_task(edit_task, self.project_root, self.cfg)

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "unsupported_capability")
        request.assert_not_called()

    def test_unsupported_model_profile_stops_before_provider_request(self) -> None:
        task = self.task(modelProfileId="other/gpt-image-2")
        with mock.patch.object(self.imagegen, "request_json") as request:
            result = self.imagegen.run_machine_task(task, self.project_root, self.cfg)

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "unsupported_model_profile")
        request.assert_not_called()

    def test_failure_is_redacted_and_does_not_update_index(self) -> None:
        message = f"provider rejected runtime-secret at {self.project_root}"
        with mock.patch.object(
            self.imagegen,
            "request_json",
            side_effect=self.imagegen.ImagegenError(message),
        ):
            result = self.imagegen.run_machine_task(self.task(), self.project_root, self.cfg)

        encoded = json.dumps(result)
        self.assertFalse(result["ok"])
        self.assertNotIn("runtime-secret", encoded)
        self.assertNotIn(str(self.project_root), encoded)
        index_path = self.project_root / "output" / "imagegen" / "index.json"
        self.assertFalse(index_path.exists())

    def test_unsupported_transparent_background_stops_before_request(self) -> None:
        cfg = self.imagegen.Config(
            **{**self.cfg.__dict__, "capabilities": {"transparent_background": False}}
        )
        task = self.task(output={**self.task()["output"], "background": "transparent"})

        with mock.patch.object(self.imagegen, "request_json") as request:
            result = self.imagegen.run_machine_task(task, self.project_root, cfg)

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "unsupported_capability")
        request.assert_not_called()

    def test_url_image_download_retries_tls_eof_once_without_switching_route(self) -> None:
        tls_eof = self.imagegen.urllib.error.URLError(
            ssl.SSLEOFError(8, "UNEXPECTED_EOF_WHILE_READING")
        )
        image_bytes = make_png(1, 1)
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = image_bytes

        with mock.patch.object(
            self.imagegen.urllib.request,
            "urlopen",
            side_effect=[tls_eof, response],
        ) as urlopen:
            result = self.imagegen.decode_image_item(
                {"url": "https://cdn.example.test/signed-image.png?secret=value"},
                self.cfg.user_agent,
            )

        self.assertEqual(result, image_bytes)
        self.assertEqual(urlopen.call_count, 2)

    def test_url_image_download_uses_direct_connection_when_explicitly_configured(self) -> None:
        image_bytes = make_png(1, 1)
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = image_bytes
        opener = mock.MagicMock()
        opener.open.return_value = response

        with (
            mock.patch.object(self.imagegen.urllib.request, "urlopen") as urlopen,
            mock.patch.object(
                self.imagegen.urllib.request,
                "build_opener",
                return_value=opener,
            ) as build_opener,
        ):
            result = self.imagegen.decode_image_item(
                {"url": "https://cdn.example.test/image.png"},
                self.cfg.user_agent,
                direct_url_download=True,
            )

        self.assertEqual(result, image_bytes)
        urlopen.assert_not_called()
        self.assertEqual(build_opener.call_args.args[0].proxies, {})
        opener.open.assert_called_once()

    def test_v2_provider_config_resolves_the_requested_model_profile(self) -> None:
        config_path = self.project_root / "v2-config.json"
        config_path.write_text(
            json.dumps(
                {
                    "providers": {
                        "primary": {
                            "protocol": "openai-compatible",
                            "base_url": "https://provider.example.test/v1",
                            "user_agent": "V2-Provider/1.0",
                            "api_key": "provider-secret",
                            "url_download": {"proxy_mode": "direct"},
                        }
                    },
                    "models": {
                        "primary/gpt-image-2": {
                            "model": "gpt-image-2",
                            "capabilities": {"generate": True, "edit": True},
                        }
                    },
                    "defaults": {"quality": "high"},
                }
            ),
            encoding="utf-8",
        )

        cfg = self.imagegen.load_config(
            config_path=config_path,
            model_profile_id="primary/gpt-image-2",
        )

        self.assertEqual(cfg.base_url, "https://provider.example.test/v1")
        self.assertEqual(cfg.user_agent, "V2-Provider/1.0")
        self.assertEqual(cfg.api_key, "provider-secret")
        self.assertEqual(cfg.model, "gpt-image-2")
        self.assertEqual(cfg.defaults["quality"], "high")
        self.assertEqual(cfg.url_download["proxy_mode"], "direct")

    def test_list_models_returns_safe_capabilities_without_api_key(self) -> None:
        config_path = self.project_root / "v2-config.json"
        config_path.write_text(
            json.dumps(
                {
                    "providers": {
                        "primary": {
                            "protocol": "openai-compatible",
                            "base_url": "https://images.example.test/v1",
                            "api_key_env": "PRIVATE_IMAGE_KEY",
                        }
                    },
                    "models": {
                        "primary/gpt-image-2": {
                            "provider": "primary",
                            "model": "gpt-image-2",
                            "capabilities": {"generate": True, "edit": True, "mask": True},
                        }
                    },
                }
            ),
            encoding="utf-8",
        )

        result = self.imagegen.run_machine_task(
            {"operation": "list_models", "modelProfileId": "primary/gpt-image-2"},
            self.project_root,
            config_path=config_path,
        )

        self.assertTrue(result["ok"])
        self.assertEqual(
            result["models"],
            [
                {
                    "id": "primary/gpt-image-2",
                    "provider": "primary",
                    "model": "gpt-image-2",
                    "capabilities": {"generate": True, "edit": True, "mask": True},
                }
            ],
        )
        encoded = json.dumps(result)
        self.assertNotIn("base_url", encoded)
        self.assertNotIn("api_key", encoded)
        self.assertNotIn("PRIVATE_IMAGE_KEY", encoded)


if __name__ == "__main__":
    unittest.main()
