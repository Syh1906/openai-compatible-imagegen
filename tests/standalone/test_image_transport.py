from __future__ import annotations

from pathlib import Path
import tempfile
import unittest
from unittest import mock
import urllib.error

from scripts import image_transport


class ImageTransportTests(unittest.TestCase):
    def test_custom_proxy_failure_does_not_fall_back_or_expose_the_proxy_url(self) -> None:
        proxy_url = "http://127.0.0.1:7890"
        opener = mock.MagicMock()
        opener.open.side_effect = urllib.error.URLError(f"connection to {proxy_url} failed")

        with (
            mock.patch.object(image_transport.urllib.request, "urlopen") as urlopen,
            mock.patch.object(
                image_transport.urllib.request,
                "build_opener",
                return_value=opener,
            ),
        ):
            with self.assertRaises(image_transport.TransportError) as raised:
                image_transport.request_json(
                    base_url="https://example.test/v1",
                    api_key="secret",
                    user_agent="test-client",
                    path="images/generations",
                    payload={"prompt": "test"},
                    timeout=10,
                    proxy_url=proxy_url,
                )

        urlopen.assert_not_called()
        opener.open.assert_called_once()
        self.assertNotIn(proxy_url, str(raised.exception))
        self.assertIn("[configured proxy]", str(raised.exception))

    def test_json_and_multipart_requests_use_the_custom_proxy(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value = response
        opener = mock.MagicMock()
        opener.open.return_value = response
        calls = (
            lambda: image_transport.request_json(
                base_url="https://example.test/v1",
                api_key="secret",
                user_agent="test-client",
                path="images/generations",
                payload={"prompt": "test"},
                timeout=10,
                proxy_url="http://127.0.0.1:7890",
            ),
            lambda: image_transport.request_multipart(
                base_url="https://example.test/v1",
                api_key="secret",
                user_agent="test-client",
                path="images/edits",
                fields={"prompt": "test"},
                files=[],
                timeout=10,
                proxy_url="http://127.0.0.1:7890",
            ),
        )

        with (
            mock.patch.object(image_transport.urllib.request, "urlopen") as urlopen,
            mock.patch.object(
                image_transport.urllib.request,
                "build_opener",
                return_value=opener,
            ) as build_opener,
            mock.patch.object(image_transport, "read_json_response", return_value={}),
        ):
            for call in calls:
                with self.subTest(call=call):
                    call()

        urlopen.assert_not_called()
        self.assertEqual(build_opener.call_count, 2)
        for call in build_opener.call_args_list:
            self.assertEqual(
                call.args[0].proxies,
                {
                    "http": "http://127.0.0.1:7890",
                    "https": "http://127.0.0.1:7890",
                },
            )
        self.assertEqual(opener.open.call_count, 2)

    def test_request_response_limit_defaults_to_bounded_for_standalone_calls(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value = response

        calls = (
            lambda: image_transport.request_json(
                base_url="https://example.test/v1",
                api_key="secret",
                user_agent="test-client",
                path="images/generations",
                payload={"prompt": "test"},
                timeout=10,
            ),
            lambda: image_transport.request_multipart(
                base_url="https://example.test/v1",
                api_key="secret",
                user_agent="test-client",
                path="images/edits",
                fields={"prompt": "test"},
                files=[],
                timeout=10,
            ),
        )

        with (
            mock.patch.object(image_transport.urllib.request, "urlopen", return_value=response),
            mock.patch.object(image_transport, "read_json_response", return_value={}) as read_response,
        ):
            for call in calls:
                with self.subTest(call=call):
                    call()

        self.assertEqual(
            read_response.call_args_list,
            [
                mock.call(response, image_transport.MAX_JSON_RESPONSE_BYTES),
                mock.call(response, image_transport.MAX_JSON_RESPONSE_BYTES),
            ],
        )

    def test_request_response_limit_allows_explicit_unbounded_machine_calls(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b'{"data": []}'

        with mock.patch.object(
            image_transport.urllib.request,
            "urlopen",
            return_value=response,
        ):
            result = image_transport.request_json(
                base_url="https://example.test/v1",
                api_key="secret",
                user_agent="test-client",
                path="images/generations",
                payload={"prompt": "test"},
                timeout=10,
                response_limit=None,
            )

        self.assertEqual(result, {"data": []})
        response.read.assert_called_once_with()

    def test_multipart_body_uses_bytes_snapshot_without_reopening_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "parent.png"
            path.write_bytes(b"path-content")
            snapshot = b"snapshot-content"

            body = image_transport.build_multipart_body(
                "test-boundary",
                {"prompt": "keep this"},
                [("image[]", path, snapshot)],
            )

            path.write_bytes(b"changed-after-snapshot")
            self.assertIn(snapshot, body)
            self.assertNotIn(b"changed-after-snapshot", body)

    def test_multipart_body_rejects_missing_input_path(self) -> None:
        missing = Path(tempfile.gettempdir()) / "image-transport-missing-input.png"
        with self.assertRaisesRegex(ValueError, "input file not found"):
            image_transport.build_multipart_body("test-boundary", {}, [("image[]", missing)])

    def test_multipart_body_uses_snapshot_after_source_path_is_removed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "parent.png"
            path.write_bytes(b"path-content")
            snapshot = b"snapshot-content"
            path.unlink()

            body = image_transport.build_multipart_body(
                "test-boundary",
                {},
                [("image[]", path, snapshot)],
            )

            self.assertIn(snapshot, body)


if __name__ == "__main__":
    unittest.main()
