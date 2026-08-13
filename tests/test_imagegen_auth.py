from __future__ import annotations

import importlib.util
import http.client
import io
import json
import os
from pathlib import Path
import ssl
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import zlib


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "imagegen.py"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def load_imagegen():
    spec = importlib.util.spec_from_file_location("imagegen_under_test", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load imagegen.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def rgba_png_bytes(width: int, height: int, pixels: list[tuple[int, int, int, int]]) -> bytes:
    if len(pixels) != width * height:
        raise ValueError("pixel count does not match dimensions")
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw.extend(pixels[y * width + x])
    chunks = [
        png_chunk(b"IHDR", width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00"),
        png_chunk(b"IDAT", zlib.compress(bytes(raw))),
        png_chunk(b"IEND", b""),
    ]
    return PNG_SIGNATURE + b"".join(chunks)


def make_rgba_png(path: Path, width: int, height: int, pixels: list[tuple[int, int, int, int]]) -> None:
    path.write_bytes(rgba_png_bytes(width, height, pixels))


def png_chunk(kind: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(kind + data) & 0xFFFFFFFF
    return len(data).to_bytes(4, "big") + kind + data + crc.to_bytes(4, "big")


class AuthConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.imagegen = load_imagegen()
        self.temp_dir = Path(self._testMethodName)
        self.temp_dir.mkdir(exist_ok=True)
        self.auth_path = self.temp_dir / "auth.json"
        self.example_path = self.temp_dir / "auth.example.json"
        self.example_path.write_text(
            json.dumps(
                {
                    "base_url": "https://example.com/v1",
                    "api_key": "replace-with-temporary-local-key",
                    "api_key_env": "OPENAI_API_KEY",
                    "model": "gpt-image-2",
                    "defaults": {
                        "size": "2048x2048",
                        "quality": "auto",
                        "output_format": "png",
                    },
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        self.imagegen.AUTH_PATH = self.auth_path
        self.imagegen.EXAMPLE_AUTH_PATH = self.example_path

    def tearDown(self) -> None:
        for path in sorted(self.temp_dir.rglob("*"), reverse=True):
            if path.is_dir():
                path.rmdir()
            else:
                path.unlink()
        self.temp_dir.rmdir()

    def test_init_auth_creates_local_config_without_api_secret(self) -> None:
        args = SimpleNamespace(
            force=False,
            base_url="https://images.example.test/v1",
            model="gpt-image-2",
            api_key_env="IMAGEGEN_API_KEY",
            postprocess=False,
        )

        exit_code = self.imagegen.init_auth(args)

        self.assertEqual(exit_code, 0)
        data = json.loads(self.auth_path.read_text(encoding="utf-8"))
        self.assertEqual(data["base_url"], "https://images.example.test/v1")
        self.assertEqual(data["api_key"], "replace-with-temporary-local-key")
        self.assertEqual(data["api_key_env"], "IMAGEGEN_API_KEY")
        self.assertEqual(data["model"], "gpt-image-2")
        self.assertNotIn("capabilities", data)

    def test_load_config_uses_api_key_env_when_file_key_is_placeholder(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://images.example.test/v1",
                    "api_key": "replace-with-temporary-local-key",
                    "api_key_env": "IMAGEGEN_TEST_KEY",
                    "model": "gpt-image-2",
                }
            ),
            encoding="utf-8",
        )
        old_value = os.environ.get("IMAGEGEN_TEST_KEY")
        os.environ["IMAGEGEN_TEST_KEY"] = "env-secret"
        try:
            cfg = self.imagegen.load_config()
        finally:
            if old_value is None:
                os.environ.pop("IMAGEGEN_TEST_KEY", None)
            else:
                os.environ["IMAGEGEN_TEST_KEY"] = old_value

        self.assertEqual(cfg.api_key, "env-secret")
        self.assertEqual(cfg.api_key_source, "env:IMAGEGEN_TEST_KEY")

    def test_load_config_prefers_direct_api_key_over_env(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://images.example.test/v1",
                    "api_key": "file-secret",
                    "api_key_env": "IMAGEGEN_TEST_KEY",
                    "model": "gpt-image-2",
                }
            ),
            encoding="utf-8",
        )
        old_value = os.environ.get("IMAGEGEN_TEST_KEY")
        os.environ["IMAGEGEN_TEST_KEY"] = "env-secret"
        try:
            cfg = self.imagegen.load_config()
        finally:
            if old_value is None:
                os.environ.pop("IMAGEGEN_TEST_KEY", None)
            else:
                os.environ["IMAGEGEN_TEST_KEY"] = old_value

        self.assertEqual(cfg.api_key, "file-secret")
        self.assertEqual(cfg.api_key_source, "auth.json api_key")

    def test_info_mode_allows_unconfigured_api_key(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://images.example.test/v1",
                    "api_key": "replace-with-temporary-local-key",
                    "api_key_env": "IMAGEGEN_TEST_KEY",
                    "model": "gpt-image-2",
                }
            ),
            encoding="utf-8",
        )

        cfg = self.imagegen.load_config(require_api_key=False)

        self.assertEqual(cfg.api_key, "")
        self.assertEqual(cfg.api_key_source, "missing")

    def test_missing_auth_message_points_to_quick_init(self) -> None:
        with self.assertRaises(self.imagegen.ImagegenError) as ctx:
            self.imagegen.load_config(require_api_key=False)

        self.assertIn("quick-init.py", str(ctx.exception))

    def test_postprocess_config_defaults_to_disabled_when_missing(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://images.example.test/v1",
                    "api_key": "file-secret",
                    "model": "gpt-image-2",
                }
            ),
            encoding="utf-8",
        )

        cfg = self.imagegen.load_config()

        self.assertFalse(cfg.postprocess["enabled"])

    def test_load_config_rejects_obsolete_transparent_background_capability(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://images.example.test/v1",
                    "api_key": "file-secret",
                    "model": "gpt-image-2",
                    "capabilities": {"transparent_background": True},
                }
            ),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(
            self.imagegen.ImagegenError,
            "capabilities.transparent_background is obsolete",
        ):
            self.imagegen.load_config()

    def test_load_config_reads_exact_prompt_only_rules(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://images.example.test/v1",
                    "api_key": "file-secret",
                    "model": "gpt-image-2",
                    "transparency": {
                        "prompt_only_allow": [
                            {"model": "gpt-image-2", "mode": "generate", "size": "1024x1024"}
                        ]
                    },
                }
            ),
            encoding="utf-8",
        )

        cfg = self.imagegen.load_config()

        self.assertEqual(len(cfg.transparency.prompt_only_allow), 1)
        self.assertEqual(cfg.transparency.prompt_only_allow[0].size, "1024x1024")

    def test_load_config_reads_llm_assisted_transparency_policy(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://images.example.test/v1",
                    "api_key": "file-secret",
                    "model": "gpt-image-2",
                    "transparency": {
                        "default_route": "emissive-alpha",
                        "llm_assisted": {
                            "enabled": True,
                            "max_attempts": 2,
                            "allow_parameter_tuning": True,
                            "allow_route_change": True,
                            "allow_api_retry": False,
                        },
                    },
                }
            ),
            encoding="utf-8",
        )

        cfg = self.imagegen.load_config()

        self.assertEqual(cfg.transparency.default_route, "emissive-alpha")
        self.assertTrue(cfg.transparency.llm_assisted.enabled)

    def test_url_download_proxy_mode_defaults_to_environment(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://images.example.test/v1",
                    "api_key": "file-secret",
                    "model": "gpt-image-2",
                }
            ),
            encoding="utf-8",
        )

        cfg = self.imagegen.load_config()

        self.assertEqual(cfg.url_download["proxy_mode"], "environment")

    def test_load_config_enables_direct_url_download_mode(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://images.example.test/v1",
                    "api_key": "file-secret",
                    "model": "gpt-image-2",
                    "url_download": {"proxy_mode": "direct"},
                }
            ),
            encoding="utf-8",
        )

        cfg = self.imagegen.load_config()

        self.assertEqual(cfg.url_download["proxy_mode"], "direct")

    def test_load_config_rejects_invalid_url_download_proxy_mode(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://images.example.test/v1",
                    "api_key": "file-secret",
                    "model": "gpt-image-2",
                    "url_download": {"proxy_mode": "automatic"},
                }
            ),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(
            self.imagegen.ImagegenError,
            "url_download.proxy_mode must be environment or direct",
        ):
            self.imagegen.load_config()

    def test_load_config_uses_default_user_agent_when_missing(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://images.example.test/v1",
                    "api_key": "file-secret",
                    "model": "gpt-image-2",
                }
            ),
            encoding="utf-8",
        )

        cfg = self.imagegen.load_config()

        self.assertEqual(cfg.user_agent, self.imagegen.DEFAULT_USER_AGENT)
        self.assertTrue(cfg.user_agent.startswith("Mozilla/5.0"))

    def test_load_config_uses_custom_user_agent(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://images.example.test/v1",
                    "api_key": "file-secret",
                    "model": "gpt-image-2",
                    "user_agent": "Micu-Compatible-Client/1.0",
                }
            ),
            encoding="utf-8",
        )

        cfg = self.imagegen.load_config()

        self.assertEqual(cfg.user_agent, "Micu-Compatible-Client/1.0")

    def test_load_config_rejects_user_agent_with_control_characters(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://images.example.test/v1",
                    "api_key": "file-secret",
                    "model": "gpt-image-2",
                    "user_agent": "allowed\r\nX-Injected: true",
                }
            ),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(self.imagegen.ImagegenError, "user_agent"):
            self.imagegen.load_config()


class RequestHeaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.imagegen = load_imagegen()
        self.cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="gpt-image-2",
            defaults={},
            postprocess={"enabled": False},
            user_agent="Micu-Compatible-Client/1.0",
        )

    def mock_json_response(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.side_effect = [b'{"data": []}', b""]
        return response

    def test_request_json_sends_configured_user_agent(self) -> None:
        with mock.patch.object(
            self.imagegen.urllib.request,
            "urlopen",
            return_value=self.mock_json_response(),
        ) as urlopen:
            self.imagegen.request_json(self.cfg, "images/generations", {"prompt": "test"}, 10)

        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header("User-agent"), "Micu-Compatible-Client/1.0")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")

    def test_request_json_rejects_response_over_byte_limit(self) -> None:
        response = self.mock_json_response()
        response.read.side_effect = [b'{"data":[]}', b""]

        with (
            mock.patch.object(self.imagegen, "MAX_JSON_RESPONSE_BYTES", 8, create=True),
            mock.patch.object(self.imagegen.urllib.request, "urlopen", return_value=response),
        ):
            with self.assertRaisesRegex(self.imagegen.ImagegenError, "JSON response exceeds"):
                self.imagegen.request_json(self.cfg, "images/generations", {"prompt": "test"}, 10)

        self.assertEqual(response.read.call_args.args, (9,))

    def test_safe_error_body_uses_a_bounded_read(self) -> None:
        response = mock.Mock(reason="bad request")
        response.read.return_value = b"x" * 2001

        detail = self.imagegen.safe_error_body(response)

        response.read.assert_called_once_with(2001)
        self.assertEqual(detail, "x" * 2000)

    def test_request_json_classifies_http_400_as_api_rejected(self) -> None:
        response = mock.Mock()
        response.read.return_value = b'{"error":"request rejected"}'
        error = self.imagegen.urllib.error.HTTPError(
            "https://example.test/v1/images/generations",
            400,
            "Bad Request",
            hdrs={},
            fp=response,
        )

        with mock.patch.object(self.imagegen.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(self.imagegen.ApiRequestError) as raised:
                self.imagegen.request_json(self.cfg, "images/generations", {"prompt": "test"}, 10)

        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(raised.exception.error_kind, "api_rejected")
        self.assertIn("API HTTP 400", str(raised.exception))
        response.close.assert_called_once_with()

    def test_request_multipart_closes_http_error_response(self) -> None:
        response = mock.Mock()
        response.read.return_value = b'{"error":"request rejected"}'
        error = self.imagegen.urllib.error.HTTPError(
            "https://example.test/v1/images/edits",
            400,
            "Bad Request",
            hdrs={},
            fp=response,
        )

        with mock.patch.object(self.imagegen.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(self.imagegen.ApiRequestError):
                self.imagegen.request_multipart(
                    self.cfg,
                    "images/edits",
                    {"prompt": "test"},
                    [],
                    10,
                )

        response.close.assert_called_once_with()

    def test_main_reports_http_400_classification_fields(self) -> None:
        stderr = io.StringIO()
        rejection = self.imagegen.ApiRequestError(
            "API HTTP 400: request rejected",
            400,
            "images/generations",
        )

        with (
            mock.patch.object(self.imagegen, "load_config", return_value=self.cfg),
            mock.patch.object(self.imagegen, "generate", side_effect=rejection),
            mock.patch.object(
                self.imagegen.sys,
                "argv",
                ["imagegen", "generate", "--prompt", "test"],
            ),
            mock.patch.object(self.imagegen.sys, "stderr", stderr),
        ):
            exit_code = self.imagegen.main()

        self.assertEqual(exit_code, 2)
        output = stderr.getvalue()
        self.assertIn("error_kind=api_rejected", output)
        self.assertIn("status_code=400", output)
        self.assertIn("operation=images/generations", output)

    def test_request_multipart_sends_configured_user_agent(self) -> None:
        with mock.patch.object(
            self.imagegen.urllib.request,
            "urlopen",
            return_value=self.mock_json_response(),
        ) as urlopen:
            self.imagegen.request_multipart(self.cfg, "images/edits", {"prompt": "test"}, [], 10)

        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header("User-agent"), "Micu-Compatible-Client/1.0")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")

    def test_url_image_download_sends_user_agent_without_authorization(self) -> None:
        image_bytes = rgba_png_bytes(1, 1, [(255, 0, 0, 255)])
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.side_effect = [image_bytes, b""]
        with mock.patch.object(
            self.imagegen.urllib.request,
            "urlopen",
            return_value=response,
        ) as urlopen:
            result = self.imagegen.decode_image_item(
                {"url": "https://cdn.example.test/image.png"},
                self.cfg.user_agent,
            )

        request = urlopen.call_args.args[0]
        self.assertEqual(result, image_bytes)
        self.assertEqual(request.get_header("User-agent"), "Micu-Compatible-Client/1.0")
        self.assertIsNone(request.get_header("Authorization"))

    def test_url_image_download_retries_tls_eof_once(self) -> None:
        tls_eof = self.imagegen.urllib.error.URLError(
            ssl.SSLEOFError(8, "UNEXPECTED_EOF_WHILE_READING")
        )
        image_bytes = rgba_png_bytes(1, 1, [(255, 0, 0, 255)])
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.side_effect = [image_bytes, b""]

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

    def test_url_image_download_uses_direct_connection_immediately_when_enabled(self) -> None:
        image_bytes = rgba_png_bytes(1, 1, [(255, 0, 0, 255)])
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.side_effect = [image_bytes, b""]
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
        build_opener.assert_called_once()
        self.assertEqual(build_opener.call_args.args[0].proxies, {})
        opener.open.assert_called_once()

    def test_url_image_download_retries_direct_connection_after_tls_eof(self) -> None:
        tls_eof = self.imagegen.urllib.error.URLError(
            ssl.SSLEOFError(8, "UNEXPECTED_EOF_WHILE_READING")
        )
        image_bytes = rgba_png_bytes(1, 1, [(255, 0, 0, 255)])
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.side_effect = [image_bytes, b""]
        opener = mock.MagicMock()
        opener.open.side_effect = [tls_eof, response]

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
        build_opener.assert_called_once()
        self.assertEqual(build_opener.call_args.args[0].proxies, {})
        self.assertEqual(opener.open.call_count, 2)

    def test_url_image_download_rejects_incomplete_content_length(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.headers.get.return_value = "100"
        response.read.side_effect = [PNG_SIGNATURE, b""]

        with mock.patch.object(
            self.imagegen.urllib.request,
            "urlopen",
            return_value=response,
        ):
            with self.assertRaisesRegex(
                self.imagegen.ImagegenError,
                "image URL download was incomplete",
            ):
                self.imagegen.decode_image_item(
                    {"url": "https://cdn.example.test/image.png"},
                    self.cfg.user_agent,
                )

    def test_url_image_download_wraps_incomplete_read(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.side_effect = http.client.IncompleteRead(b"partial", 100)

        with mock.patch.object(
            self.imagegen.urllib.request,
            "urlopen",
            return_value=response,
        ):
            with self.assertRaisesRegex(
                self.imagegen.ImagegenError,
                "image URL download was incomplete",
            ):
                self.imagegen.decode_image_item(
                    {"url": "https://cdn.example.test/image.png"},
                    self.cfg.user_agent,
                )

    def test_url_image_download_wraps_repeated_tls_eof_without_url(self) -> None:
        tls_eof = self.imagegen.urllib.error.URLError(
            ssl.SSLEOFError(8, "UNEXPECTED_EOF_WHILE_READING")
        )

        with mock.patch.object(
            self.imagegen.urllib.request,
            "urlopen",
            side_effect=tls_eof,
        ) as urlopen:
            with self.assertRaises(self.imagegen.ImagegenError) as raised:
                self.imagegen.decode_image_item(
                    {"url": "https://cdn.example.test/signed-image.png?secret=value"},
                    self.cfg.user_agent,
                )

        self.assertEqual(urlopen.call_count, 2)
        self.assertIn("image URL download failed", str(raised.exception))
        self.assertIn("--allow-direct-url-download", str(raised.exception))
        self.assertNotIn("signed-image", str(raised.exception))
        self.assertNotIn("secret=value", str(raised.exception))

    def test_url_image_download_does_not_retry_other_network_errors(self) -> None:
        network_error = self.imagegen.urllib.error.URLError("connection refused")

        with mock.patch.object(
            self.imagegen.urllib.request,
            "urlopen",
            side_effect=network_error,
        ) as urlopen:
            with self.assertRaisesRegex(
                self.imagegen.ImagegenError,
                "image URL download failed: network error",
            ):
                self.imagegen.decode_image_item(
                    {"url": "https://cdn.example.test/image.png"},
                    self.cfg.user_agent,
                )

        urlopen.assert_called_once()

    def test_url_image_download_rejects_non_http_scheme(self) -> None:
        with mock.patch.object(self.imagegen.urllib.request, "urlopen") as urlopen:
            with self.assertRaisesRegex(
                self.imagegen.ImagegenError,
                "image URL must use http or https",
            ):
                self.imagegen.decode_image_item(
                    {"url": "file:///private/image.png"},
                    self.cfg.user_agent,
                )

        urlopen.assert_not_called()

    def test_url_image_download_closes_http_error_response(self) -> None:
        response = mock.Mock()
        error = self.imagegen.urllib.error.HTTPError(
            "https://cdn.example.test/image.png",
            403,
            "Forbidden",
            hdrs={},
            fp=response,
        )

        with mock.patch.object(self.imagegen.urllib.request, "urlopen", side_effect=error):
            with self.assertRaisesRegex(
                self.imagegen.ImagegenError,
                "image URL download failed: HTTP 403",
            ):
                self.imagegen.download_image_url("https://cdn.example.test/image.png")

        response.close.assert_called_once_with()

    def test_info_reports_effective_user_agent(self) -> None:
        with mock.patch("builtins.print") as print_mock:
            self.imagegen.info(self.cfg)

        summary = json.loads(print_mock.call_args.args[0])
        self.assertEqual(summary["user_agent"], "Micu-Compatible-Client/1.0")
        self.assertEqual(
            summary["script_path"],
            self.imagegen.display_path(Path(self.imagegen.__file__).resolve()),
        )
        self.assertEqual(summary["api_key"], "***REDACTED***")
        self.assertEqual(summary["transparency"]["default_route"], "chroma-matting")
        self.assertFalse(summary["transparency"]["llm_assisted"]["enabled"])
        self.assertNotIn("allow_generated_code", summary["transparency"]["llm_assisted"])


class ParameterResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.imagegen = load_imagegen()
        self.cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="gpt-image-2",
            defaults={},
            postprocess={"enabled": False},
        )

    def make_args(self, **overrides: object) -> SimpleNamespace:
        values = {
            "asset": False,
            "transparent": False,
            "format": None,
            "background": None,
            "size": None,
            "aspect": None,
            "resolution": None,
            "quality": None,
            "model": None,
            "timeout": None,
            "n": None,
            "compression": None,
            "moderation": None,
            "allow_direct_url_download": False,
            "postprocess": None,
            "transparency_route": None,
            "transparency_mask": None,
            "transparency_param": None,
        }
        values.update(overrides)
        return SimpleNamespace(**values)

    def test_resolve_common_params_maps_aspect_and_resolution_to_size(self) -> None:
        cases = [
            ("1:1", "1K", "1024x1024"),
            ("16:9", "1K", "1536x864"),
            ("9:16", "1K", "864x1536"),
            ("16:9", "2K", "2048x1152"),
            ("9:16", "4K", "2160x3840"),
        ]
        for aspect, resolution, expected_size in cases:
            with self.subTest(aspect=aspect, resolution=resolution):
                args = self.make_args(aspect=aspect, resolution=resolution)

                result = self.imagegen.resolve_common_params(args, self.cfg)

                self.assertEqual(result["size"], expected_size)
                self.assertEqual(result["aspect"], aspect)
                self.assertEqual(result["resolution"], resolution)

    def test_resolve_common_params_allows_explicit_size_to_override_aspect_resolution(self) -> None:
        args = self.make_args(size="1536x1024", aspect="16:9", resolution="2K")

        result = self.imagegen.resolve_common_params(args, self.cfg)

        self.assertEqual(result["size"], "1536x1024")

    def test_resolve_common_params_allows_one_shot_direct_url_download(self) -> None:
        args = self.make_args(allow_direct_url_download=True)

        result = self.imagegen.resolve_common_params(args, self.cfg)

        self.assertTrue(result["direct_url_download"])

    def test_resolve_common_params_rejects_excessive_image_count(self) -> None:
        args = self.make_args(n=self.imagegen.MAX_IMAGES_PER_REQUEST + 1)

        with self.assertRaisesRegex(
            self.imagegen.ImagegenError,
            rf"n must be <= {self.imagegen.MAX_IMAGES_PER_REQUEST}",
        ):
            self.imagegen.resolve_common_params(args, self.cfg)

    def test_resolve_common_params_uses_persistent_direct_url_download_config(self) -> None:
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="gpt-image-2",
            defaults={},
            postprocess={"enabled": False},
            url_download={"proxy_mode": "direct"},
        )

        result = self.imagegen.resolve_common_params(self.make_args(), cfg)

        self.assertTrue(result["direct_url_download"])

    def test_batch_row_cannot_enable_direct_url_download(self) -> None:
        result = self.imagegen.resolve_common_params(
            self.make_args(),
            self.cfg,
            {"allow_direct_url_download": True},
        )

        self.assertFalse(result["direct_url_download"])

    def test_build_parser_accepts_one_shot_direct_url_download(self) -> None:
        args = self.imagegen.build_parser().parse_args(
            [
                "generate",
                "--prompt",
                "test",
                "--allow-direct-url-download",
            ]
        )

        self.assertTrue(args.allow_direct_url_download)

    def test_build_parser_rejects_transparent_as_api_background(self) -> None:
        with self.assertRaises(SystemExit):
            self.imagegen.build_parser().parse_args(
                ["generate", "--prompt", "test", "--background", "transparent"]
            )

    def test_build_parser_accepts_explicit_transparency_route_mask_and_parameters(self) -> None:
        args = self.imagegen.build_parser().parse_args(
            [
                "generate",
                "--prompt",
                "test",
                "--transparent",
                "--postprocess",
                "--transparency-route",
                "mask-alpha",
                "--transparency-mask",
                "subject-mask.png",
                "--transparency-param",
                "threshold=128",
                "--transparency-param",
                "feather=1",
            ]
        )

        self.assertEqual(args.transparency_route, "mask-alpha")
        self.assertEqual(args.transparency_mask, "subject-mask.png")
        self.assertEqual(args.transparency_param, ["threshold=128", "feather=1"])

    def test_transparent_intent_forces_png_without_setting_api_background(self) -> None:
        args = self.make_args(transparent=True, size="1024x1024")

        result = self.imagegen.resolve_common_params(args, self.cfg)

        self.assertEqual(result["output_format"], "png")
        self.assertIsNone(result["background"])

    def test_batch_background_values_are_trimmed_and_normalized(self) -> None:
        for raw, expected in ((" AUTO ", "auto"), ("Opaque", "opaque"), ("   ", None)):
            with self.subTest(raw=raw):
                result = self.imagegen.resolve_common_params(
                    self.make_args(),
                    self.cfg,
                    {"background": raw},
                )

                self.assertEqual(result["background"], expected)

    def test_batch_rejects_removed_or_invalid_background_values(self) -> None:
        for raw, message in (
            (" TRANSPARENT ", "background=transparent has been removed"),
            ("blue", "invalid background"),
            (True, "invalid background"),
        ):
            with self.subTest(raw=raw):
                with self.assertRaisesRegex(self.imagegen.ImagegenError, message):
                    self.imagegen.resolve_common_params(
                        self.make_args(),
                        self.cfg,
                        {"background": raw},
                    )

    def test_reference_metadata_reports_shape_without_semantic_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            reference = Path(temp) / "reference.png"
            make_rgba_png(reference, 12, 2, [(220, 30, 40, 255)] * 24)

            report = self.imagegen.inspect_reference_metadata([reference])

            self.assertEqual(report["status"], "not_evaluated")
            self.assertEqual(report["items"][0]["width"], 12)
            self.assertEqual(report["items"][0]["height"], 2)
            self.assertIn("reference_shape_unusual", report["warnings"])
            self.assertIn("reference_semantics_not_evaluated", report["warnings"])

    def test_generate_uses_chroma_prompt_without_transparent_api_parameter(self) -> None:
        args = self.make_args(
            transparent=True,
            size="1024x1024",
            postprocess=True,
            prompt="A red enamel badge",
            file=str(ROOT / "unused-transparent-result.png"),
            out=None,
        )

        with (
            mock.patch.object(self.imagegen, "request_json", return_value={"data": []}) as request_json,
            mock.patch.object(
                self.imagegen,
                "write_response_images",
                return_value={
                    "files": [str(ROOT / "unused-transparent-result.png")],
                    "warnings": [],
                    "api_delivery": {"status": "published", "items": []},
                },
            ),
        ):
            result = self.imagegen.generate(self.cfg, args)

        payload = self.imagegen.drop_none(request_json.call_args.args[2])
        self.assertNotIn("background", payload)
        self.assertIn("#00FF00", payload["prompt"])
        self.assertEqual(result["transparency"]["mode"], "chroma-matting")

    def test_generate_uses_explicit_emissive_route_and_tuning(self) -> None:
        args = self.make_args(
            transparent=True,
            size="1024x1024",
            postprocess=True,
            transparency_route="emissive-alpha",
            transparency_param=["black_point=12", "gamma=1.5"],
            prompt="A cyan magic particle burst",
            file=str(ROOT / "unused-emissive-result.png"),
            out=None,
        )

        with (
            mock.patch.object(self.imagegen, "request_json", return_value={"data": []}) as request_json,
            mock.patch.object(
                self.imagegen,
                "write_response_images",
                return_value={
                    "files": [str(ROOT / "unused-emissive-result.png")],
                    "warnings": [],
                    "api_delivery": {"status": "published", "items": []},
                },
            ),
        ):
            result = self.imagegen.generate(self.cfg, args)

        payload = self.imagegen.drop_none(request_json.call_args.args[2])
        self.assertIn("pure black", payload["prompt"].lower())
        self.assertEqual(result["transparency"]["mode"], "emissive-alpha")
        self.assertEqual(result["transparency"]["options"]["black_point"], 12)

    def test_invalid_transparency_parameter_is_reported_as_imagegen_error(self) -> None:
        args = self.make_args(
            transparent=True,
            size="1024x1024",
            postprocess=True,
            transparency_route="emissive-alpha",
            transparency_param=["unknown=1"],
        )
        params = self.imagegen.resolve_common_params(args, self.cfg)

        with self.assertRaisesRegex(
            self.imagegen.ImagegenError,
            "unsupported transparency option",
        ):
            self.imagegen.resolve_request_transparency(
                "A cyan magic particle burst",
                "generate",
                params,
                args,
                self.cfg,
                {},
            )

    def test_apply_transparency_invalid_parameter_uses_normal_error_exit(self) -> None:
        stderr = io.StringIO()
        with (
            mock.patch.object(
                self.imagegen.sys,
                "argv",
                [
                    "imagegen",
                    "apply-transparency",
                    "source.png",
                    "--out",
                    "result.png",
                    "--route",
                    "emissive-alpha",
                    "--transparency-param",
                    "unknown=1",
                ],
            ),
            mock.patch.object(self.imagegen.sys, "stderr", stderr),
        ):
            exit_code = self.imagegen.main()

        self.assertEqual(exit_code, 2)
        self.assertIn("unsupported transparency option", stderr.getvalue())
        self.assertNotIn("unexpected failure", stderr.getvalue())

    def test_apply_transparency_malformed_parameter_uses_normal_error_exit(self) -> None:
        stderr = io.StringIO()
        with (
            mock.patch.object(
                self.imagegen.sys,
                "argv",
                [
                    "imagegen",
                    "apply-transparency",
                    "source.png",
                    "--out",
                    "result.png",
                    "--route",
                    "emissive-alpha",
                    "--transparency-param",
                    "not-an-assignment",
                ],
            ),
            mock.patch.object(self.imagegen.sys, "stderr", stderr),
        ):
            exit_code = self.imagegen.main()

        self.assertEqual(exit_code, 2)
        self.assertIn("invalid transparency parameter", stderr.getvalue())
        self.assertNotIn("unexpected failure", stderr.getvalue())

    def test_generate_2k_with_explicit_no_postprocess_still_requests_original(self) -> None:
        args = self.make_args(
            transparent=True,
            size="2048x2048",
            postprocess=False,
            prompt="A red enamel badge",
            file=str(ROOT / "unused-transparent-result.png"),
            out=None,
        )

        with mock.patch.object(self.imagegen, "request_json") as request_json:
            with mock.patch.object(
                self.imagegen,
                "write_response_images",
                return_value={
                    "files": [str(ROOT / "unused-transparent-result.png")],
                    "warnings": [],
                    "api_delivery": {"status": "published", "items": []},
                },
            ):
                result = self.imagegen.generate(self.cfg, args)

        request_json.assert_called_once()
        self.assertEqual(result["transparency"]["mode"], "inspect-alpha")
        self.assertEqual(result["prompt"], "A red enamel badge")

    def test_generate_rejects_no_postprocess_with_explicit_local_route_before_request(self) -> None:
        args = self.make_args(
            transparent=True,
            size="2048x2048",
            postprocess=False,
            transparency_route="emissive-alpha",
            prompt="A blue lightning burst",
            file=str(ROOT / "unused-lightning-result.png"),
            out=None,
        )

        with mock.patch.object(self.imagegen, "request_json") as request_json:
            with self.assertRaisesRegex(self.imagegen.ImagegenError, "--no-postprocess conflicts"):
                self.imagegen.generate(self.cfg, args)

        request_json.assert_not_called()

    def test_generate_4k_transparency_reaches_api_without_background_parameter(self) -> None:
        args = self.make_args(
            transparent=True,
            aspect="9:16",
            resolution="4K",
            postprocess=True,
            prompt="A tall isolated industrial turbine",
            file=str(ROOT / "unused-4k-transparent-result.png"),
            out=None,
        )

        with (
            mock.patch.object(self.imagegen, "request_json", return_value={"data": []}) as request_json,
            mock.patch.object(
                self.imagegen,
                "write_response_images",
                return_value={
                    "files": [str(ROOT / "unused-4k-transparent-result.png")],
                    "warnings": [],
                    "api_delivery": {"status": "published", "items": []},
                },
            ),
        ):
            result = self.imagegen.generate(self.cfg, args)

        payload = self.imagegen.drop_none(request_json.call_args.args[2])
        self.assertEqual(payload["size"], "2160x3840")
        self.assertNotIn("background", payload)
        self.assertEqual(result["transparency"]["mode"], "chroma-matting")

    def test_transparent_edit_multipart_omits_background_parameter(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            reference = Path(temp) / "reference.png"
            make_rgba_png(reference, 1, 1, [(220, 30, 40, 255)])
            args = self.make_args(
                transparent=True,
                size="2048x2048",
                postprocess=True,
                prompt="Keep the turbine and isolate it",
                image=[str(reference)],
                mask=None,
                file=str(Path(temp) / "edited.png"),
                out=None,
            )

            with (
                mock.patch.object(
                    self.imagegen,
                    "request_multipart",
                    return_value={"data": []},
                ) as request_multipart,
                mock.patch.object(
                    self.imagegen,
                    "write_response_images",
                    return_value={
                        "files": [str(Path(temp) / "edited.png")],
                        "warnings": [],
                        "api_delivery": {"status": "published", "items": []},
                    },
                ),
            ):
                result = self.imagegen.edit(self.cfg, args)

        fields = self.imagegen.drop_none(request_multipart.call_args.args[2])
        self.assertNotIn("background", fields)
        self.assertEqual(fields["size"], "2048x2048")
        self.assertEqual(result["transparency"]["mode"], "chroma-matting")

    def test_resolve_common_params_rejects_removed_transparent_background_value(self) -> None:
        args = self.make_args(background="transparent", aspect="1:1", resolution="2K")

        with self.assertRaisesRegex(
            self.imagegen.ImagegenError,
            "background=transparent has been removed",
        ):
            self.imagegen.resolve_common_params(args, self.cfg)

    def test_resolve_common_params_rejects_removed_value_at_1k_too(self) -> None:
        args = self.make_args(background="transparent", size="1024x1024")

        with self.assertRaisesRegex(
            self.imagegen.ImagegenError,
            "background=transparent has been removed",
        ):
            self.imagegen.resolve_common_params(args, self.cfg)

    def test_resolve_common_params_rejects_removed_value_for_explicit_2k_size(self) -> None:
        args = self.make_args(background="transparent", size="2048x2048")

        with self.assertRaisesRegex(
            self.imagegen.ImagegenError,
            "background=transparent has been removed",
        ):
            self.imagegen.resolve_common_params(args, self.cfg)


class PostprocessImageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.imagegen = load_imagegen()
        self.temp_dir = Path(self._testMethodName)
        self.temp_dir.mkdir(exist_ok=True)

    def tearDown(self) -> None:
        for path in sorted(self.temp_dir.rglob("*"), reverse=True):
            if path.is_dir():
                path.rmdir()
            else:
                path.unlink()
        self.temp_dir.rmdir()

    def test_inspect_image_reports_png_size_and_alpha_bbox(self) -> None:
        path = self.temp_dir / "input.png"
        pixels = [(0, 0, 0, 0)] * 16
        pixels[5] = (255, 0, 0, 255)
        pixels[6] = (255, 0, 0, 255)
        pixels[9] = (255, 0, 0, 128)
        pixels[10] = (255, 0, 0, 128)
        make_rgba_png(path, 4, 4, pixels)

        result = self.imagegen.inspect_image_file(path)

        self.assertEqual(result["width"], 4)
        self.assertEqual(result["height"], 4)
        self.assertTrue(result["has_alpha"])
        self.assertEqual(result["alpha_bbox"], [1, 1, 2, 2])

    def test_normalize_image_resizes_to_delivery_size(self) -> None:
        source = self.temp_dir / "source.png"
        output = self.temp_dir / "normalized.png"
        pixels = [(255, 0, 0, 255)] * 16
        make_rgba_png(source, 4, 4, pixels)

        result = self.imagegen.normalize_image_file(source, output, (2, 2))

        self.assertEqual(result["output"]["width"], 2)
        self.assertEqual(result["output"]["height"], 2)
        self.assertTrue(output.is_file())

    def test_split_grid_crops_full_cells_before_resizing(self) -> None:
        source = self.temp_dir / "grid.png"
        out_dir = self.temp_dir / "split"
        pixels: list[tuple[int, int, int, int]] = []
        colors = [
            (255, 0, 0, 255),
            (0, 255, 0, 255),
            (0, 0, 255, 255),
            (255, 255, 0, 255),
        ]
        for y in range(4):
            for x in range(4):
                cell = (y // 2) * 2 + (x // 2)
                pixels.append(colors[cell])
        make_rgba_png(source, 4, 4, pixels)

        result = self.imagegen.split_grid_image(source, out_dir, rows=2, cols=2, delivery_size=(2, 2))

        self.assertEqual(len(result["outputs"]), 4)
        self.assertEqual(result["grid"], {"rows": 2, "cols": 2, "count": 4})
        for item in result["outputs"]:
            info = self.imagegen.inspect_image_file(Path(item["file"]))
            self.assertEqual((info["width"], info["height"]), (2, 2))

    def test_split_grid_allows_non_divisible_canvas_size(self) -> None:
        source = self.temp_dir / "non_divisible_grid.png"
        out_dir = self.temp_dir / "non_divisible_split"
        pixels = [(255, 0, 0, 255)] * 25
        make_rgba_png(source, 5, 5, pixels)

        result = self.imagegen.split_grid_image(source, out_dir, rows=2, cols=2, delivery_size=(2, 2))

        self.assertEqual(len(result["outputs"]), 4)
        self.assertEqual(result["outputs"][0]["source_cell"], [0, 0, 2, 2])
        self.assertEqual(result["outputs"][1]["source_cell"], [2, 0, 3, 2])
        self.assertEqual(result["outputs"][2]["source_cell"], [0, 2, 2, 3])
        self.assertEqual(result["outputs"][3]["source_cell"], [2, 2, 3, 3])

    def test_apply_postprocess_keeps_record_unchanged_when_disabled(self) -> None:
        source = self.temp_dir / "source.png"
        make_rgba_png(source, 4, 4, [(255, 0, 0, 255)] * 16)
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="gpt-image-2",
            defaults={},
            postprocess={"enabled": False},
        )
        args = SimpleNamespace(
            postprocess=False,
            delivery_size=None,
            grid=None,
            expected_count=None,
            postprocess_out_dir=None,
        )
        record = {"ok": True, "files": [str(source)]}

        result = self.imagegen.apply_postprocess(record, args, cfg)

        self.assertEqual(result, record)

    def test_apply_postprocess_ignores_config_delivery_size(self) -> None:
        source = self.temp_dir / "source.png"
        make_rgba_png(source, 4, 4, [(255, 0, 0, 255)] * 16)
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="gpt-image-2",
            defaults={},
            postprocess={"enabled": True, "delivery_size": "2x2"},
        )
        args = SimpleNamespace(
            postprocess=False,
            delivery_size=None,
            grid=None,
            expected_count=None,
            postprocess_out_dir=None,
        )
        record = {"ok": True, "files": [str(source)]}

        result = self.imagegen.apply_postprocess(record, args, cfg)

        self.assertEqual(result, record)

    def test_apply_postprocess_normalizes_when_delivery_size_is_explicit(self) -> None:
        source = self.temp_dir / "source.png"
        out_dir = self.temp_dir / "post"
        make_rgba_png(source, 4, 4, [(255, 0, 0, 255)] * 16)
        cfg = self.imagegen.Config(
            base_url="https://example.test/v1",
            api_key="secret",
            api_key_source="test",
            model="gpt-image-2",
            defaults={},
            postprocess={"enabled": False},
        )
        args = SimpleNamespace(
            postprocess=False,
            delivery_size="2x2",
            grid=None,
            expected_count=None,
            postprocess_out_dir=str(out_dir),
        )
        record = {"ok": True, "files": [str(source)]}

        result = self.imagegen.apply_postprocess(record, args, cfg)

        self.assertEqual(result["original_files"], [source.resolve().as_posix()])
        self.assertEqual(result["files"][0], source.resolve().as_posix())
        self.assertEqual(result["derived_files"], [result["files"][1]])
        self.assertTrue(result["delivery_ready"])
        info = self.imagegen.inspect_image_file(Path(result["files"][1]))
        self.assertEqual((info["width"], info["height"]), (2, 2))


if __name__ == "__main__":
    unittest.main()
