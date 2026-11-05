from __future__ import annotations

from pathlib import Path
import io
import json
import tempfile
import unittest
from unittest import mock
import socket
import ssl
import urllib.error

from scripts import image_transport


class ImageTransportTests(unittest.TestCase):
    def test_http_error_retains_safe_provider_fields_and_request_id(self) -> None:
        raw = {"error": {"code": "missing_required_parameter", "type": "invalid_request_error", "param": "svg.model",
                         "message": "Missing required parameter: svg.model. credential-fixture-123 https://private.invalid/key", "raw": "discard"}}
        error = urllib.error.HTTPError("https://example.invalid/v1/images/generations", 400, "Bad Request", {"x-request-id": "req_svg_123"}, io.BytesIO(json.dumps(raw).encode()))
        with mock.patch.object(image_transport.urllib.request, "urlopen", side_effect=error) as send, mock.patch.object(image_transport, "proxy_mapping", return_value=None):
            with self.assertRaises(image_transport.TransportError) as caught:
                image_transport.request_json(base_url="https://example.invalid/v1", api_key="credential-fixture-123", user_agent="test", path="images/generations", payload={}, timeout=10)
        detail = caught.exception.provider_error
        self.assertEqual(detail["code"], "missing_required_parameter")
        self.assertEqual(detail["param"], "svg.model")
        self.assertEqual(detail["type"], "invalid_request_error")
        self.assertEqual(detail["requestId"], "req_svg_123")
        self.assertIn("Missing required parameter: svg.model", detail["message"])
        self.assertNotIn("credential-fixture-123", str(caught.exception) + json.dumps(detail))
        self.assertNotIn("private.invalid", json.dumps(detail))
        self.assertNotIn("raw", detail)
        self.assertEqual(send.call_count, 1)

    def test_non_json_provider_error_does_not_publish_raw_body(self) -> None:
        error = urllib.error.HTTPError("https://example.invalid", 400, "Bad Request", {"x-request-id": "req_only_header"}, io.BytesIO(b"<html>private failure</html>"))
        with mock.patch.object(image_transport.urllib.request, "urlopen", side_effect=error), mock.patch.object(image_transport, "proxy_mapping", return_value=None):
            with self.assertRaises(image_transport.TransportError) as caught:
                image_transport.request_json(base_url="https://example.invalid/v1", api_key="", user_agent="test", path="images/generations", payload={}, timeout=10)
        self.assertEqual(caught.exception.provider_error, {"requestId": "req_only_header"})

    def test_provider_error_fields_are_bounded_and_secret_identifiers_removed(self) -> None:
        detail = json.dumps({"error": {"code": "credential-fixture-123", "type": None, "param": "svg.model", "message": "Missing svg.model. " + "detail " * 500}})
        error = urllib.error.HTTPError("https://example.invalid", 400, "Bad Request", {"x-request-id": "credential-fixture-123"}, io.BytesIO(detail.encode()))
        with mock.patch.object(image_transport.urllib.request, "urlopen", side_effect=error), mock.patch.object(image_transport, "proxy_mapping", return_value=None):
            with self.assertRaises(image_transport.TransportError) as caught:
                image_transport.request_json(base_url="https://example.invalid/v1", api_key="credential-fixture-123", user_agent="test", path="images/generations", payload={}, timeout=10)
        self.assertEqual(set(caught.exception.provider_error), {"param", "message"})
        self.assertEqual(len(caught.exception.provider_error["message"]), 1000)
        self.assertIn("Missing svg.model", caught.exception.provider_error["message"])

    def test_echoed_prompt_is_redacted_before_message_truncation(self) -> None:
        prompt = "private-prompt-fixture-" + "x" * 1100
        body = json.dumps({"error": {"message": "Rejected prompt: " + prompt, "param": "prompt"}}).encode()
        for multipart in (False, True):
            error = urllib.error.HTTPError("https://example.invalid", 400, "Bad Request", {}, io.BytesIO(body))
            with self.subTest(multipart=multipart), mock.patch.object(image_transport.urllib.request, "urlopen", side_effect=error), mock.patch.object(image_transport, "proxy_mapping", return_value=None):
                with self.assertRaises(image_transport.TransportError) as caught:
                    common = dict(base_url="https://example.invalid/v1", api_key="", user_agent="test", timeout=10)
                    if multipart:
                        image_transport.request_multipart(**common, path="images/edits", fields={"prompt": prompt}, files=[])
                    else:
                        image_transport.request_json(**common, path="images/generations", payload={"prompt": prompt})
            self.assertNotIn("private-prompt-fixture", str(caught.exception) + json.dumps(caught.exception.provider_error))
            self.assertEqual(caught.exception.provider_error["message"], "Rejected prompt: [REDACTED]")

    def test_multiline_prompt_and_json_escaped_credential_are_redacted(self) -> None:
        prompt = "private-first-line\nprivate-second-line"
        credential = 'credential-quoted"fixture'
        body = json.dumps({"error": {"message": f"Rejected {prompt} {credential}"}}).encode()
        error = urllib.error.HTTPError("https://example.invalid", 400, "Bad Request", {}, io.BytesIO(body))
        with mock.patch.object(image_transport.urllib.request, "urlopen", side_effect=error), mock.patch.object(image_transport, "proxy_mapping", return_value=None):
            with self.assertRaises(image_transport.TransportError) as caught:
                image_transport.request_json(base_url="https://example.invalid/v1", api_key=credential, user_agent="test", path="images/generations", payload={"prompt": prompt}, timeout=10)
        result = str(caught.exception) + json.dumps(caught.exception.provider_error)
        self.assertNotIn("private-first-line", result)
        self.assertNotIn("credential-quoted", result)
        self.assertIn("Rejected", result)

    def test_malformed_json_response_preserves_decode_stage_without_retry(self) -> None:
        for raw in (b"not json", b"[]"):
            with self.subTest(raw=raw), mock.patch.object(image_transport.urllib.request, "urlopen", return_value=io.BytesIO(raw)) as send, mock.patch.object(image_transport, "proxy_mapping", return_value=None):
                with self.assertRaises(image_transport.TransportError) as caught:
                    image_transport.request_json(base_url="https://example.invalid/v1", api_key="", user_agent="test", path="images/generations", payload={}, timeout=10)
                self.assertEqual(caught.exception.stage, "response_decode")
                self.assertEqual(send.call_count, 1)

    def test_atlas_generation_submits_once_and_polls_until_completed(self) -> None:
        responses = [
            {"code": 200, "data": {"id": "req_123"}},
            {"code": 200, "data": {"status": "processing"}},
            {"code": 200, "data": {"status": "completed", "outputs": ["https://cdn.example.test/image.png"]}},
        ]

        with (
            mock.patch.object(image_transport, "_send_request", side_effect=responses) as send_request,
            mock.patch.object(image_transport.time, "sleep") as sleep,
        ):
            result = image_transport.request_atlas_image(
                base_url="https://api.atlascloud.ai",
                api_key="secret",
                user_agent="test-client",
                payload={"model": "openai/gpt-image-2/text-to-image", "prompt": "test"},
                timeout=10,
                poll_interval=0.01,
                max_poll_attempts=3,
            )

        self.assertEqual(result, {"data": [{"url": "https://cdn.example.test/image.png"}]})
        self.assertEqual(send_request.call_count, 3)
        requests = [call.args[0] for call in send_request.call_args_list]
        self.assertEqual([request.get_method() for request in requests], ["POST", "GET", "GET"])
        self.assertEqual(
            [request.full_url for request in requests],
            [
                "https://api.atlascloud.ai/api/v1/model/generateImage",
                "https://api.atlascloud.ai/api/v1/model/prediction/req_123",
                "https://api.atlascloud.ai/api/v1/model/prediction/req_123",
            ],
        )
        sleep.assert_called_once_with(0.01)

    def test_atlas_generation_retries_only_transient_result_get_failures(self) -> None:
        transient = image_transport.TransportError(
            "temporarily unavailable",
            status_code=503,
            operation="atlas generation result",
        )
        responses = [
            {"code": 200, "data": {"id": "req_456"}},
            transient,
            {"code": 200, "data": {"status": "completed", "outputs": ["https://cdn.example.test/image.png"]}},
        ]

        with (
            mock.patch.object(image_transport, "_send_request", side_effect=responses) as send_request,
            mock.patch.object(image_transport.time, "sleep") as sleep,
        ):
            result = image_transport.request_atlas_image(
                base_url="https://api.atlascloud.ai",
                api_key="secret",
                user_agent="test-client",
                payload={"model": "openai/gpt-image-2/text-to-image", "prompt": "test"},
                timeout=10,
                poll_interval=0.01,
                max_poll_attempts=3,
            )

        self.assertEqual(result, {"data": [{"url": "https://cdn.example.test/image.png"}]})
        self.assertEqual(send_request.call_count, 3)
        self.assertEqual([call.args[0].get_method() for call in send_request.call_args_list], ["POST", "GET", "GET"])
        sleep.assert_called_once_with(0.01)

    def test_atlas_generation_fails_fast_on_permanent_transport_error(self) -> None:
        # A certificate/DNS/connection-refused failure arrives without a status
        # code; it must not consume the whole polling budget.
        permanent = image_transport.TransportError(
            "API request failed: certificate verify failed",
            operation="atlas generation result",
        )
        responses = [{"code": 200, "data": {"id": "req_permanent"}}, permanent]

        with (
            mock.patch.object(image_transport, "_send_request", side_effect=responses) as send_request,
            mock.patch.object(image_transport.time, "sleep") as sleep,
        ):
            with self.assertRaises(image_transport.TransportError) as caught:
                image_transport.request_atlas_image(
                    base_url="https://api.atlascloud.ai",
                    api_key="secret",
                    user_agent="test-client",
                    payload={"model": "openai/gpt-image-2/text-to-image", "prompt": "test"},
                    timeout=10,
                    poll_interval=0.01,
                    max_poll_attempts=300,
                )

        self.assertIn("certificate verify failed", str(caught.exception))
        self.assertEqual(send_request.call_count, 2)
        sleep.assert_not_called()

    def test_atlas_generation_retries_transient_transport_error(self) -> None:
        transient = image_transport.TransportError(
            "API request failed: timed out",
            operation="atlas generation result",
            transient=True,
        )
        responses = [
            {"code": 200, "data": {"id": "req_transient"}},
            transient,
            {"code": 200, "data": {"status": "completed", "outputs": ["https://cdn.example.test/image.png"]}},
        ]

        with (
            mock.patch.object(image_transport, "_send_request", side_effect=responses) as send_request,
            mock.patch.object(image_transport.time, "sleep") as sleep,
        ):
            result = image_transport.request_atlas_image(
                base_url="https://api.atlascloud.ai",
                api_key="secret",
                user_agent="test-client",
                payload={"model": "openai/gpt-image-2/text-to-image", "prompt": "test"},
                timeout=10,
                poll_interval=0.01,
                max_poll_attempts=5,
            )

        self.assertEqual(result, {"data": [{"url": "https://cdn.example.test/image.png"}]})
        self.assertEqual(send_request.call_count, 3)
        sleep.assert_called_once_with(0.01)

    def test_url_error_reasons_are_classified(self) -> None:
        permanent_reasons = [
            ssl.SSLCertVerificationError("certificate verify failed"),
            socket.gaierror("Name or service not known"),
            ConnectionRefusedError("connection refused"),
        ]
        for reason in permanent_reasons:
            with self.subTest(reason=type(reason).__name__):
                self.assertFalse(
                    image_transport._is_transient_url_error(urllib.error.URLError(reason))
                )
        transient_reasons = [TimeoutError("timed out"), ConnectionResetError("reset by peer")]
        for reason in transient_reasons:
            with self.subTest(reason=type(reason).__name__):
                self.assertTrue(
                    image_transport._is_transient_url_error(urllib.error.URLError(reason))
                )

    def test_atlas_generation_stops_at_the_polling_deadline(self) -> None:
        # Enough readings for the added budget checks: the per-GET timeout clamp
        # and _sleep_within each read the clock. Values stay past the 1.0s
        # deadline so the second iteration still trips it.
        clock = iter([0.0, 0.0, 0.1, 0.2, 5.0, 5.0, 5.0, 5.0])

        with (
            mock.patch.object(
                image_transport,
                "_send_request",
                side_effect=[{"code": 200, "data": {"id": "req_deadline"}}, {"code": 200, "data": {"status": "processing"}}],
            ) as send_request,
            mock.patch.object(image_transport.time, "sleep"),
            mock.patch.object(image_transport.time, "monotonic", side_effect=lambda: next(clock)),
        ):
            with self.assertRaises(image_transport.TransportError) as caught:
                image_transport.request_atlas_image(
                    base_url="https://api.atlascloud.ai",
                    api_key="secret",
                    user_agent="test-client",
                    payload={"model": "openai/gpt-image-2/text-to-image", "prompt": "test"},
                    timeout=10,
                    poll_interval=0.01,
                    max_poll_attempts=300,
                    max_poll_seconds=1.0,
                )

        self.assertIn("polling deadline", str(caught.exception))
        self.assertEqual(send_request.call_count, 2)

    def test_atlas_poll_get_timeout_is_clamped_to_remaining_budget(self) -> None:
        """A slow GET must not overshoot max_poll_seconds by a whole timeout."""
        # Advance slowly then jump near the deadline; unbounded so the test
        # does not break when the implementation reads the clock more often.
        ticks = [0.0, 0.0, 0.0, 9.5]
        state = {"i": 0}

        def fake_monotonic() -> float:
            i = state["i"]
            state["i"] += 1
            return ticks[i] if i < len(ticks) else 9.5

        seen_timeouts: list[float] = []

        def record(request, timeout, operation, limit, proxy, *, sensitive_values=()):  # noqa: ANN001
            seen_timeouts.append(timeout)
            if operation == "atlas generation submit":
                return {"code": 200, "data": {"id": "req_clamp"}}
            return {"code": 200, "data": {"status": "processing"}}

        with (
            mock.patch.object(image_transport, "_send_request", side_effect=record),
            mock.patch.object(image_transport.time, "sleep"),
            mock.patch.object(image_transport.time, "monotonic", side_effect=fake_monotonic),
        ):
            with self.assertRaises(image_transport.TransportError):
                image_transport.request_atlas_image(
                    base_url="https://api.atlascloud.ai",
                    api_key="secret",
                    user_agent="test-client",
                    payload={"model": "openai/gpt-image-2/text-to-image", "prompt": "test"},
                    timeout=600,
                    poll_interval=0.01,
                    max_poll_attempts=300,
                    max_poll_seconds=10.0,
                )

        # The polling GET must not be handed the full 600s request timeout.
        self.assertLess(seen_timeouts[1], 600)

    def test_atlas_generation_does_not_retry_submit_failures(self) -> None:
        failure = image_transport.TransportError("submit failed", operation="atlas generation submit")

        with mock.patch.object(image_transport, "_send_request", side_effect=failure) as send_request:
            with self.assertRaisesRegex(image_transport.TransportError, "submit failed"):
                image_transport.request_atlas_image(
                    base_url="https://api.atlascloud.ai",
                    api_key="secret",
                    user_agent="test-client",
                    payload={"model": "openai/gpt-image-2/text-to-image", "prompt": "test"},
                    timeout=10,
                )

        send_request.assert_called_once()

    def test_atlas_generation_rejects_unsupported_options_before_submit(self) -> None:
        invalid_payloads = (
            {"model": "openai/gpt-image-2/text-to-image", "prompt": "test", "quality": "auto"},
            {"model": "openai/gpt-image-2/text-to-image", "prompt": "test", "output_format": "webp"},
        )

        with mock.patch.object(image_transport, "_send_request") as send_request:
            for payload in invalid_payloads:
                with self.subTest(payload=payload):
                    with self.assertRaisesRegex(ValueError, "Atlas"):
                        image_transport.request_atlas_image(
                            base_url="https://api.atlascloud.ai",
                            api_key="secret",
                            user_agent="test-client",
                            payload=payload,
                            timeout=10,
                        )

        send_request.assert_not_called()

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
