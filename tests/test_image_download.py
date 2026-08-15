from __future__ import annotations

import ast
import base64
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from scripts import image_download


PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


class RecordingResponse:
    def __init__(self, body: bytes = PNG_BYTES) -> None:
        self.body = body
        self.headers = {"Content-Length": str(len(body))}
        self.read_sizes: list[int] = []

    def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        if not self.body:
            return b""
        if size < 0:
            body, self.body = self.body, b""
            return body
        body, self.body = self.body[:size], self.body[size:]
        return body

    def __enter__(self) -> "RecordingResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None


class ImageDownloadTests(unittest.TestCase):
    def test_standalone_adapter_does_not_reimplement_url_download(self) -> None:
        standalone_source = (ROOT / "scripts" / "imagegen.py").read_text(encoding="utf-8")
        standalone_tree = ast.parse(standalone_source)
        function_names = {
            node.name
            for node in ast.walk(standalone_tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }

        self.assertTrue(
            {
                "is_tls_eof_error",
                "url_download_error_reason",
                "read_downloaded_image",
                "is_complete_image_data",
            }.isdisjoint(function_names)
        )
        download_adapter = next(
            node
            for node in standalone_tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "download_image_url"
        )
        adapter_calls = {
            node.func.id
            for node in ast.walk(download_adapter)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }
        self.assertIn("_download_image_url", adapter_calls)
        adapter_names = {
            node.id for node in ast.walk(download_adapter) if isinstance(node, ast.Name)
        }
        self.assertTrue({"http", "ssl", "urllib"}.isdisjoint(adapter_names))

    def test_download_reads_in_bounded_chunks(self) -> None:
        response = RecordingResponse()
        with mock.patch.object(image_download.urllib.request, "urlopen", return_value=response):
            self.assertEqual(
                image_download.download_image_url(
                    "https://cdn.example.test/image.png",
                    "Imagegen-Test/1.0",
                    10,
                ),
                PNG_BYTES,
            )

        self.assertTrue(response.read_sizes)
        self.assertTrue(all(size > 0 for size in response.read_sizes))

    def test_download_rejects_body_over_image_response_limit(self) -> None:
        response = RecordingResponse()
        with (
            mock.patch.object(image_download, "MAX_IMAGE_RESPONSE_BYTES", 4),
            mock.patch.object(image_download.urllib.request, "urlopen", return_value=response),
        ):
            with self.assertRaisesRegex(image_download.ImageDownloadError, "exceeds 4 byte limit"):
                image_download.download_image_url(
                    "https://cdn.example.test/image.png",
                    "Imagegen-Test/1.0",
                    10,
                )

    def test_download_rejects_incomplete_content_length(self) -> None:
        response = RecordingResponse()
        response.headers["Content-Length"] = str(len(PNG_BYTES) + 1)
        with mock.patch.object(image_download.urllib.request, "urlopen", return_value=response):
            with self.assertRaisesRegex(image_download.ImageDownloadError, "was incomplete"):
                image_download.download_image_url(
                    "https://cdn.example.test/image.png",
                    "Imagegen-Test/1.0",
                    10,
                )

    def test_download_request_headers_are_isolated_for_environment_and_direct_routes(self) -> None:
        for direct in (False, True):
            with self.subTest(direct=direct):
                response = RecordingResponse()
                opener = mock.MagicMock()
                opener.open.return_value = response
                with (
                    mock.patch.object(image_download.urllib.request, "urlopen", return_value=response) as urlopen,
                    mock.patch.object(
                        image_download.urllib.request,
                        "build_opener",
                        return_value=opener,
                    ) as build_opener,
                ):
                    image_download.download_image_url(
                        "https://cdn.example.test/image.png",
                        "Imagegen-Test/1.0",
                        10,
                        direct_url_download=direct,
                    )

                request = opener.open.call_args.args[0] if direct else urlopen.call_args.args[0]
                self.assertEqual(request.get_header("Accept"), "image/*")
                self.assertEqual(request.get_header("User-agent"), "Imagegen-Test/1.0")
                self.assertIsNone(request.get_header("Authorization"))
                if direct:
                    self.assertEqual(build_opener.call_args.args[0].proxies, {})


if __name__ == "__main__":
    unittest.main()
