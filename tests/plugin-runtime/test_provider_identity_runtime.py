from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "image_runtime.py"
PNG_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEElEQVR4nGNgaPj/"
    "H4xhDABS0gn5PEa22gAAAABJRU5ErkJggg=="
)


def load_runtime():
    module_name = "image_runtime_provider_identity_under_test"
    spec = importlib.util.spec_from_file_location(module_name, SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load image_runtime.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


class ProviderIdentityRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime = load_runtime()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.project_root = Path(self.temp_dir.name)
        self.artifact_root = self.project_root / "output" / "imagegen"
        self.cfg = self.runtime.parse_plugin_config(
            {
                "config_version": 1,
                "active_profile": "primary/gpt-image-2",
                "providers": {
                    "corp": {
                        "protocol": "openai-compatible",
                        "base_url": "https://images.example.test/v1",
                        "api_key": "runtime-secret",
                    }
                },
                "models": {
                    "primary/gpt-image-2": {
                        "provider": "corp",
                        "model": "gpt-image-2",
                        "capabilities": {"generate": True},
                    }
                },
            },
            require_api_key=True,
            model_profile_id="primary/gpt-image-2",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_model_catalog_reports_the_configured_provider_id(self) -> None:
        result = self.runtime.run_machine_task(
            {"operation": "list_models", "modelProfileId": "primary/gpt-image-2"},
            self.project_root,
            self.artifact_root,
            self.cfg,
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["models"][0]["provider"], "corp")

    def test_ordinary_generation_records_the_configured_provider_id(self) -> None:
        result = self._run_generate(execution_mode=None)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["artifacts"][0]["provider"], "corp")

    def test_batch_item_records_the_configured_provider_id(self) -> None:
        result = self._run_generate(execution_mode="batch-item")

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["artifacts"][0]["provider"], "corp")

    def _run_generate(self, *, execution_mode: str | None) -> dict:
        task = {
            "operation": "generate",
            "modelProfileId": "primary/gpt-image-2",
            "prompt": "provider identity test",
            "inputArtifactIds": [],
            "annotationId": None,
            "output": {
                "size": "1024x1024",
                "quality": "high",
                "format": "png",
                "count": 1,
                "background": "opaque",
            },
        }
        if execution_mode is not None:
            task["executionMode"] = execution_mode
        response = {"data": [{"b64_json": PNG_BASE64}]}
        with mock.patch.object(self.runtime, "request_json", return_value=response):
            return self.runtime.run_machine_task(
                task,
                self.project_root,
                self.artifact_root,
                self.cfg,
            )


if __name__ == "__main__":
    unittest.main()
