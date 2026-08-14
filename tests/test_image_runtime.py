from __future__ import annotations

import base64
import concurrent.futures
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
import zlib


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "image_runtime.py"


def load_imagegen():
    spec = importlib.util.spec_from_file_location("imagegen_runtime_under_test", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load image_runtime.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def make_png(width: int, height: int, alpha: int = 255) -> bytes:
    raw = bytearray()
    for _ in range(height):
        raw.append(0)
        raw.extend((0, 128, 255, alpha) * width)

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


class ImageRuntimeStructureTests(unittest.TestCase):
    def test_machine_adapter_does_not_expose_standalone_commands(self) -> None:
        runtime = load_imagegen()
        for name in ("generate", "edit", "batch", "init_auth", "apply_postprocess"):
            with self.subTest(name=name):
                self.assertFalse(hasattr(runtime, name))


class ImageRuntimeTransportContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.imagegen = load_imagegen()
        self.cfg = self.imagegen.Config(
            base_url="https://images.example.test/v1",
            api_key="runtime-secret",
            api_key_source="test",
            model="gpt-image-2",
            defaults={},
            capabilities={"generate": True, "edit": True},
            postprocess={"enabled": False},
            user_agent="Imagegen-Test/1.0",
        )

    def test_machine_json_and_multipart_requests_use_bounded_response_limit(self) -> None:
        with (
            mock.patch.object(self.imagegen.image_transport, "request_json", return_value={}) as request_json,
            mock.patch.object(self.imagegen.image_transport, "request_multipart", return_value={}) as request_multipart,
        ):
            self.imagegen.request_json(self.cfg, "images/generations", {"prompt": "test"}, 10)
            self.imagegen.request_multipart(self.cfg, "images/edits", {}, [], 10)

        self.assertEqual(
            request_json.call_args.kwargs["response_limit"],
            self.imagegen.MAX_JSON_RESPONSE_BYTES,
        )
        self.assertEqual(
            request_multipart.call_args.kwargs["response_limit"],
            self.imagegen.MAX_JSON_RESPONSE_BYTES,
        )

    def test_base64_data_url_uses_bounded_decoder(self) -> None:
        encoded = "c25hcHNob3Q="
        with mock.patch.object(self.imagegen, "decode_base64_image", return_value=b"snapshot") as decoder:
            result = self.imagegen.decode_image_item(
                {"b64_json": f"data:image/png;base64,{encoded}"},
                self.cfg.user_agent,
            )

        self.assertEqual(result, b"snapshot")
        decoder.assert_called_once_with(encoded, self.imagegen.MAX_IMAGE_RESPONSE_BYTES)

    def test_response_item_limit_rejects_before_url_download(self) -> None:
        response = {
            "data": [
                {"url": "https://cdn.example.test/one.png"},
                {"url": "https://cdn.example.test/two.png"},
            ]
        }
        with mock.patch.object(self.imagegen, "decode_image_item") as decoder:
            with self.assertRaisesRegex(self.imagegen.ImagegenError, "too many image items"):
                self.imagegen.decode_response_images(response, self.cfg.user_agent, max_items=1)
        decoder.assert_not_called()

    def test_response_total_image_limit_stops_after_bounded_decode(self) -> None:
        response = {
            "data": [
                {"b64_json": "first"},
                {"b64_json": "second"},
            ]
        }
        with mock.patch.object(
            self.imagegen,
            "decode_image_item",
            side_effect=[b"1234", b"5678"],
        ) as decoder:
            with self.assertRaisesRegex(self.imagegen.ImagegenError, "total image response"):
                self.imagegen.decode_response_images(
                    response,
                    self.cfg.user_agent,
                    max_items=2,
                    total_limit=6,
                )
        self.assertEqual(decoder.call_count, 2)


class CountingEditProvider:
    def __init__(self, response_images: list[bytes], *, block_first: bool = False) -> None:
        self.response_images = response_images
        self.block_first = block_first
        self.first_request = threading.Event()
        self.release_first = threading.Event()
        self._calls = 0
        self._lock = threading.Lock()
        provider = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                content_length = int(self.headers.get("Content-Length", "0"))
                self.rfile.read(content_length)
                with provider._lock:
                    provider._calls += 1
                    call_number = provider._calls
                provider.first_request.set()
                if provider.block_first and call_number == 1:
                    provider.release_first.wait(5)
                payload = json.dumps(
                    {
                        "data": [
                            {"b64_json": base64.b64encode(image).decode("ascii")}
                            for image in provider.response_images
                        ]
                    }
                ).encode("utf-8")
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, _format: str, *_args) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address
        return f"http://{host}:{port}/v1"

    @property
    def calls(self) -> int:
        with self._lock:
            return self._calls

    def __enter__(self) -> "CountingEditProvider":
        self.thread.start()
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.release_first.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class ImageRuntimeMachineModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.imagegen = load_imagegen()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.project_root = Path(self.temp_dir.name)
        self.artifact_root = self.project_root / "output" / "imagegen"
        self.cfg = self.imagegen.Config(
            base_url="https://images.example.test/v1",
            api_key="runtime-secret",
            api_key_source="test",
            model="gpt-image-2",
            defaults={},
            capabilities={
                "generate": True,
                "edit": True,
                "mask": False,
                "multi_reference": True,
                "transparent_background": True,
            },
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

    def test_generate_requests_ordered_candidates_one_at_a_time(self) -> None:
        responses = [
            {"data": [{"b64_json": base64.b64encode(make_png(3, 2)).decode("ascii")}]},
            {"data": [{"b64_json": base64.b64encode(make_png(4, 3)).decode("ascii")}]},
            {"data": [{"b64_json": base64.b64encode(make_png(5, 4)).decode("ascii")}]},
        ]
        task = self.task(output={**self.task()["output"], "count": 3})
        with mock.patch.object(self.imagegen, "request_json", side_effect=responses) as request:
            result = self.imagegen.run_machine_task(task, self.project_root, self.artifact_root, self.cfg)

        self.assertTrue(result["ok"])
        self.assertEqual(len(result["artifacts"]), 3)
        self.assertEqual(result["artifacts"][0]["width"], 3)
        self.assertEqual(result["artifacts"][1]["height"], 3)
        self.assertEqual(result["artifacts"][2]["width"], 5)
        self.assertEqual(request.call_count, 3)
        payloads = [call.args[2] for call in request.call_args_list]
        self.assertEqual([payload["n"] for payload in payloads], [1, 1, 1])
        self.assertTrue(all(payload["model"] == "gpt-image-2" for payload in payloads))
        self.assertTrue(all(payload["prompt"] == "two candidates" for payload in payloads))

    def test_generate_uses_only_the_explicit_artifact_root(self) -> None:
        artifact_root = self.project_root / ".project-data" / "image-artifacts"
        response = {"data": [{"b64_json": base64.b64encode(make_png(2, 2)).decode("ascii")}]}

        with mock.patch.object(self.imagegen, "request_json", return_value=response):
            result = self.imagegen.run_machine_task(
                self.task(output={**self.task()["output"], "count": 1}),
                self.project_root,
                artifact_root,
                self.cfg,
            )

        self.assertTrue(result["ok"])
        artifact_id = result["artifacts"][0]["id"]
        self.assertTrue((artifact_root / "artifacts" / artifact_id / "image.png").is_file())
        self.assertFalse((self.project_root / "output" / "imagegen").exists())

    def test_generate_candidate_group_stops_and_stores_nothing_after_request_failure(self) -> None:
        first_response = {
            "data": [{"b64_json": base64.b64encode(make_png(3, 2)).decode("ascii")}]
        }
        task = self.task(output={**self.task()["output"], "count": 3})

        with mock.patch.object(
            self.imagegen,
            "request_json",
            side_effect=[first_response, self.imagegen.ImagegenError("second candidate failed")],
        ) as request:
            result = self.imagegen.run_machine_task(task, self.project_root, self.artifact_root, self.cfg)

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "image_task_failed")
        self.assertEqual(request.call_count, 2)
        self.assertFalse((self.project_root / "output" / "imagegen").exists())

    def test_generate_rejects_multiple_images_for_a_single_candidate_request(self) -> None:
        response = {
            "data": [
                {"b64_json": base64.b64encode(make_png(3, 2)).decode("ascii")},
                {"b64_json": base64.b64encode(make_png(4, 3)).decode("ascii")},
            ]
        }
        task = self.task(output={**self.task()["output"], "count": 3})

        with mock.patch.object(self.imagegen, "request_json", return_value=response) as request:
            result = self.imagegen.run_machine_task(task, self.project_root, self.artifact_root, self.cfg)

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "image_task_failed")
        self.assertEqual(request.call_count, 1)
        self.assertEqual(request.call_args.args[2]["n"], 1)
        self.assertFalse((self.project_root / "output" / "imagegen" / "index.json").exists())

    def test_edit_creates_child_version_without_overwriting_parent(self) -> None:
        generated = {"data": [{"b64_json": base64.b64encode(make_png(2, 2)).decode("ascii")}]}
        with mock.patch.object(self.imagegen, "request_json", return_value=generated):
            parent_result = self.imagegen.run_machine_task(
                self.task(output={**self.task()["output"], "count": 1}),
                self.project_root,
                self.artifact_root,
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
        def request_side_effect(_cfg, _path, _fields, files, _timeout):
            parent_upload = next(upload for upload in files if upload[0] == "image[]")
            self.assertEqual(len(parent_upload), 3)
            self.assertEqual(parent_upload[2], parent_bytes)
            with mock.patch.object(
                Path,
                "read_bytes",
                side_effect=AssertionError("multipart reopened the parent path"),
            ):
                body = self.imagegen.build_multipart_body("snapshot-boundary", {}, files)
            self.assertIn(parent_bytes, body)
            return edited

        with mock.patch.object(
            self.imagegen,
            "request_multipart",
            side_effect=request_side_effect,
        ):
            child_result = self.imagegen.run_machine_task(edit_task, self.project_root, self.artifact_root, self.cfg)

        self.assertTrue(child_result["ok"])
        self.assertEqual(child_result["artifacts"][0]["parentIds"], [parent_id])
        self.assertEqual(parent_path.read_bytes(), parent_bytes)

    def test_edit_submission_replay_returns_the_committed_child_without_a_second_provider_request(self) -> None:
        generated = {"data": [{"b64_json": base64.b64encode(make_png(2, 2)).decode("ascii")}]}
        with mock.patch.object(self.imagegen, "request_json", return_value=generated):
            parent_result = self.imagegen.run_machine_task(
                self.task(output={**self.task()["output"], "count": 1}),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )
        parent_id = parent_result["artifacts"][0]["id"]
        submission_id = "sub_11111111111111111111111111111111"
        edit_task = self.task(
            operation="edit",
            prompt="make it larger",
            inputArtifactIds=[parent_id],
            submissionId=submission_id,
            output={**self.task()["output"], "count": 1},
        )
        edited = {"data": [{"b64_json": base64.b64encode(make_png(5, 4)).decode("ascii")}]}

        with mock.patch.object(self.imagegen, "request_multipart", return_value=edited) as request:
            first = self.imagegen.run_machine_task(edit_task, self.project_root, self.artifact_root, self.cfg)
            with mock.patch.object(
                self.imagegen.ArtifactRepository,
                "get_image_snapshot",
                side_effect=AssertionError("replay reopened the parent artifact"),
            ) as parent_read:
                replay = self.imagegen.run_machine_task(edit_task, self.project_root, self.artifact_root, self.cfg)

        self.assertTrue(first["ok"])
        self.assertTrue(replay["ok"])
        parent_read.assert_not_called()
        self.assertEqual(request.call_count, 1)
        self.assertEqual(replay["artifacts"][0]["id"], first["artifacts"][0]["id"])
        artifact = self.imagegen.ArtifactRepository(self.project_root, self.artifact_root).get_artifact(
            first["artifacts"][0]["id"]
        )
        self.assertEqual(artifact.metadata["parameters"]["submissionId"], submission_id)

    def test_concurrent_edit_submission_calls_provider_and_commits_only_once(self) -> None:
        generated = {"data": [{"b64_json": base64.b64encode(make_png(2, 2)).decode("ascii")}]}
        with mock.patch.object(self.imagegen, "request_json", return_value=generated):
            parent = self.imagegen.run_machine_task(
                self.task(output={**self.task()["output"], "count": 1}),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )
        edit_task = self.task(
            operation="edit",
            prompt="one logical edit",
            inputArtifactIds=[parent["artifacts"][0]["id"]],
            submissionId="sub_33333333333333333333333333333333",
            output={**self.task()["output"], "count": 1},
        )
        edited = {"data": [{"b64_json": base64.b64encode(make_png(5, 4)).decode("ascii")}]}
        first_provider_call = threading.Event()
        release_provider = threading.Event()
        provider_calls = 0
        provider_calls_lock = threading.Lock()

        def request_side_effect(*_args):
            nonlocal provider_calls
            with provider_calls_lock:
                provider_calls += 1
            first_provider_call.set()
            self.assertTrue(release_provider.wait(5))
            return edited

        with mock.patch.object(self.imagegen, "request_multipart", side_effect=request_side_effect):
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(
                    self.imagegen.run_machine_task,
                    edit_task,
                    self.project_root,
                    self.artifact_root,
                    self.cfg,
                )
                self.assertTrue(first_provider_call.wait(5))
                second = executor.submit(
                    self.imagegen.run_machine_task,
                    edit_task,
                    self.project_root,
                    self.artifact_root,
                    self.cfg,
                )
                time.sleep(0.1)
                with provider_calls_lock:
                    calls_while_first_is_in_flight = provider_calls
                release_provider.set()
                first_result = first.result(timeout=5)
                second_result = second.result(timeout=5)

        self.assertEqual(calls_while_first_is_in_flight, 1)
        self.assertEqual(provider_calls, 1)
        self.assertTrue(first_result["ok"])
        self.assertTrue(second_result["ok"])
        self.assertEqual(first_result["artifacts"][0]["id"], second_result["artifacts"][0]["id"])
        index = json.loads((self.artifact_root / "index.json").read_text(encoding="utf-8"))
        committed = [
            entry
            for entry in index["artifacts"].values()
            if entry.get("parameters", {}).get("submissionId") == edit_task["submissionId"]
        ]
        self.assertEqual(len(committed), 1)

    def test_concurrent_processes_run_one_edit_and_replay_the_same_ordered_artifacts(self) -> None:
        parent_id = self._create_parent_artifact()
        edit_task = self.task(
            operation="edit",
            prompt="one cross-process edit",
            inputArtifactIds=[parent_id],
            submissionId="sub_88888888888888888888888888888888",
            output={**self.task()["output"], "count": 2},
        )
        with CountingEditProvider([make_png(5, 4), make_png(7, 6)], block_first=True) as provider:
            first = self._start_runtime_process(edit_task, provider.base_url)
            self.assertTrue(provider.first_request.wait(5))
            second = self._start_runtime_process(edit_task, provider.base_url)
            time.sleep(0.1)
            self.assertEqual(provider.calls, 1)
            provider.release_first.set()
            first_result = self._finish_runtime_process(first)
            second_result = self._finish_runtime_process(second)

        self.assertEqual(provider.calls, 1)
        self.assertTrue(first_result["ok"])
        self.assertTrue(second_result["ok"])
        self.assertEqual(
            [artifact["id"] for artifact in first_result["artifacts"]],
            [artifact["id"] for artifact in second_result["artifacts"]],
        )
        self.assertEqual(
            [(artifact["width"], artifact["height"]) for artifact in first_result["artifacts"]],
            [(5, 4), (7, 6)],
        )
        self.assertEqual(len(self._submission_artifacts(edit_task["submissionId"])), 2)

    def test_runtime_process_continues_after_the_lock_holder_exits_abnormally(self) -> None:
        parent_id = self._create_parent_artifact()
        edit_task = self.task(
            operation="edit",
            prompt="recover after process exit",
            inputArtifactIds=[parent_id],
            submissionId="sub_99999999999999999999999999999999",
            output={**self.task()["output"], "count": 1},
        )
        with CountingEditProvider([make_png(5, 4)], block_first=True) as provider:
            first = self._start_runtime_process(edit_task, provider.base_url)
            self.assertTrue(provider.first_request.wait(5))
            first.kill()
            first.communicate(timeout=5)
            second = self._start_runtime_process(edit_task, provider.base_url)
            second_result = self._finish_runtime_process(second)

        self.assertEqual(provider.calls, 2)
        self.assertTrue(second_result["ok"])
        self.assertEqual(len(self._submission_artifacts(edit_task["submissionId"])), 1)

    def test_failed_edit_submission_can_be_retried(self) -> None:
        generated = {"data": [{"b64_json": base64.b64encode(make_png(2, 2)).decode("ascii")}]}
        with mock.patch.object(self.imagegen, "request_json", return_value=generated):
            parent = self.imagegen.run_machine_task(
                self.task(output={**self.task()["output"], "count": 1}),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )
        edit_task = self.task(
            operation="edit",
            prompt="retryable edit",
            inputArtifactIds=[parent["artifacts"][0]["id"]],
            submissionId="sub_44444444444444444444444444444444",
            output={**self.task()["output"], "count": 1},
        )
        edited = {"data": [{"b64_json": base64.b64encode(make_png(5, 4)).decode("ascii")}]}

        with mock.patch.object(
            self.imagegen,
            "request_multipart",
            side_effect=[self.imagegen.ImagegenError("temporary provider failure"), edited],
        ) as request:
            failed = self.imagegen.run_machine_task(edit_task, self.project_root, self.artifact_root, self.cfg)
            retried = self.imagegen.run_machine_task(edit_task, self.project_root, self.artifact_root, self.cfg)

        self.assertFalse(failed["ok"])
        self.assertTrue(retried["ok"])
        self.assertEqual(request.call_count, 2)

    def test_edit_submission_replay_rejects_changed_request_before_provider_call(self) -> None:
        generated = {"data": [{"b64_json": base64.b64encode(make_png(2, 2)).decode("ascii")}]}
        with mock.patch.object(self.imagegen, "request_json", return_value=generated):
            parent = self.imagegen.run_machine_task(
                self.task(output={**self.task()["output"], "count": 1}),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )
        submission_id = "sub_55555555555555555555555555555555"
        edit_task = self.task(
            operation="edit",
            prompt="original edit",
            inputArtifactIds=[parent["artifacts"][0]["id"]],
            submissionId=submission_id,
            output={**self.task()["output"], "count": 1},
        )
        edited = {"data": [{"b64_json": base64.b64encode(make_png(5, 4)).decode("ascii")}]}
        with mock.patch.object(self.imagegen, "request_multipart", return_value=edited):
            committed = self.imagegen.run_machine_task(edit_task, self.project_root, self.artifact_root, self.cfg)
        self.assertTrue(committed["ok"])

        changed_task = {
            **edit_task,
            "prompt": "different edit",
            "output": {**edit_task["output"], "count": 2},
        }
        with mock.patch.object(self.imagegen, "request_multipart") as request:
            replay = self.imagegen.run_machine_task(
                changed_task,
                self.project_root,
                self.artifact_root,
                self.cfg,
            )

        self.assertFalse(replay["ok"])
        self.assertEqual(replay["error"]["code"], "edit_submission_mismatch")
        request.assert_not_called()

    def _create_parent_artifact(self) -> str:
        generated = {
            "data": [{"b64_json": base64.b64encode(make_png(2, 2)).decode("ascii")}]
        }
        with mock.patch.object(self.imagegen, "request_json", return_value=generated):
            result = self.imagegen.run_machine_task(
                self.task(output={**self.task()["output"], "count": 1}),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )
        self.assertTrue(result["ok"])
        return result["artifacts"][0]["id"]

    def _start_runtime_process(self, task: dict, base_url: str) -> subprocess.Popen[str]:
        program = "\n".join(
            [
                "import json",
                "from pathlib import Path",
                "import sys",
                "from scripts.image_runtime import Config, run_machine_task",
                "cfg = Config(base_url=sys.argv[4], api_key='test-key', api_key_source='test', model='gpt-image-2', defaults={}, capabilities={'generate': True, 'edit': True, 'multi_reference': True}, postprocess={'enabled': False}, user_agent='Process-Test/1.0')",
                "result = run_machine_task(json.loads(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), cfg)",
                "print(json.dumps(result, separators=(',', ':')), flush=True)",
            ]
        )
        environment = os.environ.copy()
        environment["PYTHONPATH"] = str(ROOT)
        return subprocess.Popen(
            [
                sys.executable,
                "-c",
                program,
                json.dumps(task, separators=(",", ":")),
                str(self.project_root),
                str(self.artifact_root),
                base_url,
            ],
            cwd=ROOT,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def _finish_runtime_process(self, process: subprocess.Popen[str]) -> dict:
        stdout, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 0, stderr)
        return json.loads(stdout)

    def _submission_artifacts(self, submission_id: str) -> list[dict]:
        index = json.loads((self.artifact_root / "index.json").read_text(encoding="utf-8"))
        return [
            entry
            for entry in index["artifacts"].values()
            if entry.get("parameters", {}).get("submissionId") == submission_id
        ]

    def test_edit_submission_fingerprint_covers_stable_edit_semantics(self) -> None:
        task = self.task(
            operation="edit",
            prompt="semantic edit",
            inputArtifactIds=["img_01J00000000000000000000000"],
            annotationId="ann_01J00000000000000000000000",
            submissionId="sub_66666666666666666666666666666666",
            mask="C:/ignored/as/derived/path/mask.png",
            maskPolicy={
                "policyVersion": 2,
                "maskSha256": "a" * 64,
                "strategy": "edit-region",
            },
            output={**self.task()["output"], "count": 1},
        )
        params = self.imagegen.resolve_machine_output(task["output"], self.cfg)
        baseline = self.imagegen.edit_submission_fingerprint(task, params)
        equivalent = {
            **task,
            "submissionId": "sub_77777777777777777777777777777777",
            "mask": "D:/another/derived/path/mask.png",
        }
        self.assertEqual(
            self.imagegen.edit_submission_fingerprint(equivalent, params),
            baseline,
        )

        semantic_changes = [
            ({**task, "prompt": "changed prompt"}, params),
            ({**task, "inputArtifactIds": ["img_01J00000000000000000000001"]}, params),
            ({**task, "annotationId": "ann_01J00000000000000000000001"}, params),
            ({**task, "maskPolicy": {**task["maskPolicy"], "maskSha256": "b" * 64}}, params),
            (task, {**params, "count": 2}),
            (task, {**params, "quality": "low"}),
        ]
        for changed_task, changed_params in semantic_changes:
            with self.subTest(task=changed_task, params=changed_params):
                self.assertNotEqual(
                    self.imagegen.edit_submission_fingerprint(changed_task, changed_params),
                    baseline,
                )

    def test_edit_submission_replay_returns_all_committed_children_in_provider_order(self) -> None:
        generated = {"data": [{"b64_json": base64.b64encode(make_png(2, 2)).decode("ascii")}]}
        with mock.patch.object(self.imagegen, "request_json", return_value=generated):
            parent_result = self.imagegen.run_machine_task(
                self.task(output={**self.task()["output"], "count": 1}),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )
        parent_id = parent_result["artifacts"][0]["id"]
        submission_id = "sub_22222222222222222222222222222222"
        edit_task = self.task(
            operation="edit",
            prompt="return two ordered options",
            inputArtifactIds=[parent_id],
            submissionId=submission_id,
            output={**self.task()["output"], "count": 2},
        )
        edited = {
            "data": [
                {"b64_json": base64.b64encode(make_png(5, 4)).decode("ascii")},
                {"b64_json": base64.b64encode(make_png(7, 6)).decode("ascii")},
            ]
        }

        with mock.patch.object(self.imagegen, "request_multipart", return_value=edited) as request:
            first = self.imagegen.run_machine_task(edit_task, self.project_root, self.artifact_root, self.cfg)
            replay = self.imagegen.run_machine_task(edit_task, self.project_root, self.artifact_root, self.cfg)

        self.assertTrue(first["ok"])
        self.assertTrue(replay["ok"])
        self.assertEqual(request.call_count, 1)
        self.assertEqual(
            [artifact["id"] for artifact in replay["artifacts"]],
            [artifact["id"] for artifact in first["artifacts"]],
        )
        self.assertEqual(
            [(artifact["width"], artifact["height"]) for artifact in replay["artifacts"]],
            [(5, 4), (7, 6)],
        )

    def test_edit_uploads_the_explicit_mask_when_the_model_supports_it(self) -> None:
        cfg = self.imagegen.Config(
            **{**self.cfg.__dict__, "capabilities": {**self.cfg.capabilities, "mask": True}}
        )
        generated = {"data": [{"b64_json": base64.b64encode(make_png(2, 2)).decode("ascii")}]}
        with mock.patch.object(self.imagegen, "request_json", return_value=generated):
            parent_result = self.imagegen.run_machine_task(
                self.task(output={**self.task()["output"], "count": 1}),
                self.project_root,
                self.artifact_root,
                cfg,
            )
        parent_id = parent_result["artifacts"][0]["id"]
        annotation_id = "ann_01J00000000000000000000000"
        mask_path = self.project_root / "output" / "imagegen" / "annotations" / annotation_id / "mask.png"
        mask_path.parent.mkdir(parents=True)
        mask_bytes = make_png(2, 2, alpha=0)
        mask_path.write_bytes(mask_bytes)
        mask_policy_body = {
            "policyVersion": "mask-policy-v2",
            "modelProfileId": "primary/gpt-image-2",
            "requiredCapabilities": {"mask": True},
            "strategy": "protect-only",
            "parentImageId": parent_id,
            "annotationId": annotation_id,
            "width": 2,
            "height": 2,
            "masks": [{"id": "protect-1", "mode": "protect", "operation": "paint", "radiusPx": 0.5}],
            "hardBoundary": {"source": "none", "postprocess": "none"},
            "semanticProtection": {
                "enabled": True,
                "source": "protect-strokes",
                "preserve": ["identity", "geometry", "text", "texture"],
                "allowAdaptation": ["lighting", "shadow", "tone"],
            },
            "transitionBand": {
                "kind": "outer-feather",
                "featherRatio": 0.35,
                "minimumWidthPx": 1,
            },
            "maskSha256": hashlib.sha256(mask_bytes).hexdigest(),
        }
        policy_json = json.dumps(mask_policy_body, sort_keys=True, separators=(",", ":"))
        edit_task = self.task(
            operation="edit",
            prompt="replace the marked region",
            inputArtifactIds=[parent_id],
            annotationId=annotation_id,
            submissionId="sub_00000000000000000000000000000000",
            mask=str(mask_path),
            maskPolicy={
                **mask_policy_body,
                "policySha256": hashlib.sha256(policy_json.encode("utf-8")).hexdigest(),
            },
            output={**self.task()["output"], "size": "2x2", "count": 1},
        )

        with mock.patch.object(self.imagegen, "request_multipart", return_value=generated) as request:
            result = self.imagegen.run_machine_task(edit_task, self.project_root, self.artifact_root, cfg)

        self.assertTrue(result["ok"])
        mask_upload = next(upload for upload in request.call_args.args[3] if upload[0] == "mask")
        self.assertEqual(mask_upload, ("mask", mask_path, mask_bytes))

    def test_edit_with_mask_stops_before_request_when_capability_is_missing(self) -> None:
        generated = {"data": [{"b64_json": base64.b64encode(make_png(2, 2)).decode("ascii")}]}
        with mock.patch.object(self.imagegen, "request_json", return_value=generated):
            parent_result = self.imagegen.run_machine_task(
                self.task(output={**self.task()["output"], "count": 1}),
                self.project_root,
                self.artifact_root,
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
            result = self.imagegen.run_machine_task(edit_task, self.project_root, self.artifact_root, self.cfg)

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "unsupported_capability")
        request.assert_not_called()

    def test_unsupported_model_profile_stops_before_provider_request(self) -> None:
        task = self.task(modelProfileId="other/gpt-image-2")
        with mock.patch.object(self.imagegen, "request_json") as request:
            result = self.imagegen.run_machine_task(task, self.project_root, self.artifact_root, self.cfg)

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "unsupported_model_profile")
        request.assert_not_called()

    def test_disabled_generate_capability_stops_before_provider_or_repository_use(self) -> None:
        cfg = self.imagegen.Config(
            **{
                **self.cfg.__dict__,
                "capabilities": {**self.cfg.capabilities, "generate": False},
            }
        )
        response = {"data": [{"b64_json": base64.b64encode(make_png(2, 2)).decode("ascii")}]}

        with mock.patch.object(self.imagegen, "request_json", return_value=response) as request:
            result = self.imagegen.run_machine_task(
                self.task(output={**self.task()["output"], "count": 1}),
                self.project_root,
                self.artifact_root,
                cfg,
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "unsupported_capability")
        request.assert_not_called()
        self.assertFalse(self.artifact_root.exists())

    def test_disabled_edit_capability_stops_before_provider_or_repository_write(self) -> None:
        generated = {"data": [{"b64_json": base64.b64encode(make_png(2, 2)).decode("ascii")}]}
        with mock.patch.object(self.imagegen, "request_json", return_value=generated):
            parent = self.imagegen.run_machine_task(
                self.task(output={**self.task()["output"], "count": 1}),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )
        parent_id = parent["artifacts"][0]["id"]
        index_path = self.artifact_root / "index.json"
        index_before = index_path.read_bytes()
        cfg = self.imagegen.Config(
            **{
                **self.cfg.__dict__,
                "capabilities": {**self.cfg.capabilities, "edit": False},
            }
        )
        edit_task = self.task(
            operation="edit",
            inputArtifactIds=[parent_id],
            output={**self.task()["output"], "count": 1},
        )

        with mock.patch.object(self.imagegen, "request_multipart") as request:
            result = self.imagegen.run_machine_task(
                edit_task,
                self.project_root,
                self.artifact_root,
                cfg,
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "unsupported_capability")
        request.assert_not_called()
        self.assertEqual(index_path.read_bytes(), index_before)

    def test_disabled_multi_reference_stops_before_provider_or_repository_write(self) -> None:
        generated = {"data": [{"b64_json": base64.b64encode(make_png(2, 2)).decode("ascii")}]}
        with mock.patch.object(self.imagegen, "request_json", return_value=generated):
            parents = self.imagegen.run_machine_task(
                self.task(output={**self.task()["output"], "count": 2}),
                self.project_root,
                self.artifact_root,
                self.cfg,
            )
        parent_ids = [artifact["id"] for artifact in parents["artifacts"]]
        index_path = self.artifact_root / "index.json"
        index_before = index_path.read_bytes()
        cfg = self.imagegen.Config(
            **{
                **self.cfg.__dict__,
                "capabilities": {**self.cfg.capabilities, "multi_reference": False},
            }
        )
        edit_task = self.task(
            operation="edit",
            inputArtifactIds=parent_ids,
            output={**self.task()["output"], "count": 1},
        )

        with mock.patch.object(self.imagegen, "request_multipart") as request:
            result = self.imagegen.run_machine_task(
                edit_task,
                self.project_root,
                self.artifact_root,
                cfg,
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "unsupported_capability")
        request.assert_not_called()
        self.assertEqual(index_path.read_bytes(), index_before)

    def test_failure_is_redacted_and_does_not_update_index(self) -> None:
        message = f"provider rejected runtime-secret at {self.project_root}"
        with mock.patch.object(
            self.imagegen,
            "request_json",
            side_effect=self.imagegen.ImagegenError(message),
        ):
            result = self.imagegen.run_machine_task(self.task(), self.project_root, self.artifact_root, self.cfg)

        encoded = json.dumps(result)
        self.assertFalse(result["ok"])
        self.assertNotIn("runtime-secret", encoded)
        self.assertNotIn(str(self.project_root), encoded)
        index_path = self.project_root / "output" / "imagegen" / "index.json"
        self.assertFalse(index_path.exists())

    def test_unsupported_transparent_background_stops_before_request(self) -> None:
        task = self.task(output={**self.task()["output"], "background": "transparent"})

        for unsupported_value in (False, "false", 1):
            with self.subTest(transparent_background=unsupported_value):
                cfg = self.imagegen.Config(
                    **{
                        **self.cfg.__dict__,
                        "capabilities": {
                            **self.cfg.capabilities,
                            "transparent_background": unsupported_value,
                        },
                    }
                )
                with mock.patch.object(self.imagegen, "request_json") as request:
                    result = self.imagegen.run_machine_task(task, self.project_root, self.artifact_root, cfg)

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

    def test_url_image_download_uses_direct_connection_when_explicitly_configured(self) -> None:
        image_bytes = make_png(1, 1)
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
        self.assertEqual(build_opener.call_args.args[0].proxies, {})
        opener.open.assert_called_once()

    def test_url_image_download_retries_direct_tls_eof_once_without_switching_route(self) -> None:
        tls_eof = self.imagegen.urllib.error.URLError(
            ssl.SSLEOFError(8, "UNEXPECTED_EOF_WHILE_READING")
        )
        image_bytes = make_png(1, 1)
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
            ),
        ):
            result = self.imagegen.decode_image_item(
                {"url": "https://cdn.example.test/image.png"},
                self.cfg.user_agent,
                direct_url_download=True,
            )

        self.assertEqual(result, image_bytes)
        urlopen.assert_not_called()
        self.assertEqual(opener.open.call_count, 2)

    def test_url_image_download_guides_user_after_repeated_environment_tls_eof(self) -> None:
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

        message = str(raised.exception)
        self.assertEqual(urlopen.call_count, 2)
        self.assertIn("TLS connection closed unexpectedly", message)
        self.assertIn("approve setting the provider's url_download.proxy_mode=direct", message)
        self.assertNotIn("signed-image", message)
        self.assertNotIn("secret=value", message)
        self.assertNotIn(str(self.project_root), message)
        self.assertNotIn("runtime-secret", message)
        self.assertNotIn("--allow-direct-url-download", message)

    def test_url_image_download_does_not_suggest_route_change_after_repeated_direct_tls_eof(self) -> None:
        tls_eof = self.imagegen.urllib.error.URLError(
            ssl.SSLEOFError(8, "UNEXPECTED_EOF_WHILE_READING")
        )
        opener = mock.MagicMock()
        opener.open.side_effect = tls_eof

        with (
            mock.patch.object(self.imagegen.urllib.request, "urlopen") as urlopen,
            mock.patch.object(
                self.imagegen.urllib.request,
                "build_opener",
                return_value=opener,
            ),
        ):
            with self.assertRaises(self.imagegen.ImagegenError) as raised:
                self.imagegen.decode_image_item(
                    {"url": "https://cdn.example.test/signed-image.png?secret=value"},
                    self.cfg.user_agent,
                    direct_url_download=True,
                )

        self.assertEqual(
            str(raised.exception),
            "image URL download failed: TLS connection closed unexpectedly",
        )
        self.assertEqual(opener.open.call_count, 2)
        urlopen.assert_not_called()

    def test_url_image_download_does_not_retry_non_tls_network_errors(self) -> None:
        network_error = self.imagegen.urllib.error.URLError("connection refused")

        with mock.patch.object(
            self.imagegen.urllib.request,
            "urlopen",
            side_effect=network_error,
        ) as urlopen:
            with self.assertRaisesRegex(
                self.imagegen.ImagegenError,
                "^image URL download failed: network error$",
            ):
                self.imagegen.decode_image_item(
                    {"url": "https://cdn.example.test/signed-image.png?secret=value"},
                    self.cfg.user_agent,
                )

        urlopen.assert_called_once()

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
                            "provider": "primary",
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

    def test_v2_provider_config_rejects_invalid_base_urls(self) -> None:
        for base_url in ["/", "ftp://example.test/v1", "https:///v1", "https://"]:
            with self.subTest(base_url=base_url):
                raw = {
                    "providers": {
                        "primary": {
                            "protocol": "openai-compatible",
                            "base_url": base_url,
                            "api_key": "provider-secret",
                        }
                    },
                    "models": {
                        "primary/gpt-image-2": {
                            "provider": "primary",
                            "model": "gpt-image-2",
                        }
                    },
                }
                with self.assertRaises(self.imagegen.ProviderConfigError):
                    self.imagegen.parse_config(
                        raw,
                        require_api_key=True,
                        model_profile_id="primary/gpt-image-2",
                        require_v2=True,
                    )

    def test_v2_provider_config_requires_an_explicit_model_provider(self) -> None:
        raw = {
            "providers": {
                "primary": {
                    "protocol": "openai-compatible",
                    "base_url": "https://provider.example.test/v1",
                    "api_key": "provider-secret",
                }
            },
            "models": {
                "primary/gpt-image-2": {
                    "model": "gpt-image-2",
                }
            },
        }

        with self.assertRaisesRegex(self.imagegen.ProviderConfigError, "missing provider"):
            self.imagegen.parse_config(
                raw,
                require_api_key=True,
                model_profile_id="primary/gpt-image-2",
                require_v2=True,
            )

    def test_v2_config_bytes_allow_one_leading_bom_and_reject_invalid_utf8(self) -> None:
        config_path = self.project_root / "v2-config.json"
        encoded = json.dumps({
            "providers": {
                "primary": {
                    "protocol": "openai-compatible",
                    "base_url": "https://provider.example.test/v1",
                    "api_key": "provider-secret",
                }
            },
            "models": {
                "primary/gpt-image-2": {
                    "provider": "primary",
                    "model": "gpt-image-2",
                }
            },
        }).encode("utf-8")
        config_path.write_bytes(b"\xef\xbb\xbf" + encoded)

        cfg = self.imagegen.load_config(
            config_path=config_path,
            model_profile_id="primary/gpt-image-2",
        )
        self.assertEqual(cfg.base_url, "https://provider.example.test/v1")

        config_path.write_bytes(b"\xef\xbb\xbf\xef\xbb\xbf" + encoded)
        with self.assertRaisesRegex(self.imagegen.ImagegenError, "not valid JSON"):
            self.imagegen.load_config(
                config_path=config_path,
                model_profile_id="primary/gpt-image-2",
            )

        config_path.write_bytes(encoded[:1] + b"\xff" + encoded[1:])
        with self.assertRaisesRegex(self.imagegen.ImagegenError, "not valid JSON"):
            self.imagegen.load_config(
                config_path=config_path,
                model_profile_id="primary/gpt-image-2",
            )

    def test_explicit_v2_config_path_rejects_legacy_flat_config(self) -> None:
        config_path = self.project_root / "v2-config.json"
        config_path.write_text(
            json.dumps(
                {
                    "base_url": "https://provider.example.test/v1",
                    "api_key": "legacy-secret",
                    "model": "gpt-image-2",
                }
            ),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(
            self.imagegen.ImagegenError,
            "V2 config requires providers and models objects",
        ):
            self.imagegen.load_config(
                config_path=config_path,
                model_profile_id="primary/gpt-image-2",
            )

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
            self.artifact_root,
            config_path=config_path,
            config_sha256=hashlib.sha256(config_path.read_bytes()).hexdigest(),
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

    def test_list_models_rejects_unknown_or_non_boolean_capabilities_without_exposing_values(self) -> None:
        for capabilities in ({"api_key": "SENTINEL"}, {"mask": "SENTINEL"}):
            with self.subTest(capabilities=tuple(capabilities)):
                config_path = self.project_root / "v2-config.json"
                config_path.write_text(
                    json.dumps(
                        {
                            "providers": {
                                "primary": {
                                    "protocol": "openai-compatible",
                                    "base_url": "https://images.example.test/v1",
                                }
                            },
                            "models": {
                                "primary/gpt-image-2": {
                                    "provider": "primary",
                                    "model": "gpt-image-2",
                                    "capabilities": capabilities,
                                }
                            },
                        }
                    ),
                    encoding="utf-8",
                )

                result = self.imagegen.run_machine_task(
                    {"operation": "list_models", "modelProfileId": "primary/gpt-image-2"},
                    self.project_root,
                    self.artifact_root,
                    config_path=config_path,
                    config_sha256=hashlib.sha256(config_path.read_bytes()).hexdigest(),
                )

                self.assertFalse(result["ok"])
                self.assertEqual(result["error"]["code"], "image_task_failed")
                self.assertNotIn("SENTINEL", json.dumps(result))
                self.assertFalse(self.artifact_root.exists())

    def test_machine_config_snapshot_mismatch_fails_before_provider_or_repository_use(self) -> None:
        config_path = self.project_root / "v2-config.json"
        config_path.write_text(
            json.dumps({
                "providers": {
                    "primary": {
                        "protocol": "openai-compatible",
                        "base_url": "https://example.test/v1",
                        "api_key": "snapshot-secret",
                    }
                },
                "models": {
                    "primary/gpt-image-2": {
                        "provider": "primary",
                        "model": "gpt-image-2",
                        "capabilities": {"generate": True, "edit": True},
                    }
                },
            }),
            encoding="utf-8",
        )

        with mock.patch.object(self.imagegen, "request_json") as request:
            result = self.imagegen.run_machine_task(
                self.task(),
                self.project_root,
                self.artifact_root,
                config_path=config_path,
                config_sha256="0" * 64,
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "v2_config_changed")
        request.assert_not_called()
        self.assertFalse(self.artifact_root.exists())

    def test_machine_hash_and_parse_use_the_same_config_byte_snapshot(self) -> None:
        config_path = self.project_root / "v2-config.json"
        original = json.dumps({
            "providers": {
                "primary": {
                    "protocol": "openai-compatible",
                    "base_url": "https://original.example.test/v1",
                    "api_key": "snapshot-secret",
                }
            },
            "models": {
                "primary/gpt-image-2": {
                    "provider": "primary",
                    "model": "gpt-image-2",
                    "capabilities": {"mask": True},
                }
            },
        }).encode("utf-8")
        replacement = json.dumps({
            "providers": {
                "primary": {
                    "protocol": "openai-compatible",
                    "base_url": "https://replacement.example.test/v1",
                    "api_key": "replacement-secret",
                }
            },
            "models": {
                "primary/gpt-image-2": {
                    "provider": "primary",
                    "model": "gpt-image-2",
                    "capabilities": {"mask": False},
                }
            },
        }).encode("utf-8")
        config_path.write_bytes(original)
        original_read_bytes = Path.read_bytes
        reads = 0

        def replace_after_first_read(path: Path) -> bytes:
            nonlocal reads
            snapshot = original_read_bytes(path)
            if path == config_path:
                reads += 1
                if reads == 1:
                    config_path.write_bytes(replacement)
            return snapshot

        with mock.patch.object(Path, "read_bytes", replace_after_first_read):
            result = self.imagegen.run_machine_task(
                {"operation": "list_models", "modelProfileId": "primary/gpt-image-2"},
                self.project_root,
                self.artifact_root,
                config_path=config_path,
                config_sha256=hashlib.sha256(original).hexdigest(),
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["models"][0]["capabilities"], {"mask": True})
        self.assertEqual(reads, 1)


if __name__ == "__main__":
    unittest.main()
