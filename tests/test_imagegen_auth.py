from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "imagegen.py"


def load_imagegen():
    spec = importlib.util.spec_from_file_location("imagegen_under_test", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load imagegen.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


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
                    "capabilities": {"transparent_background": True},
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
            path.unlink()
        self.temp_dir.rmdir()

    def test_init_auth_creates_local_config_without_api_secret(self) -> None:
        args = SimpleNamespace(
            force=False,
            base_url="https://images.example.test/v1",
            model="gpt-image-2",
            api_key_env="IMAGEGEN_API_KEY",
            transparent_background=False,
        )

        exit_code = self.imagegen.init_auth(args)

        self.assertEqual(exit_code, 0)
        data = json.loads(self.auth_path.read_text(encoding="utf-8"))
        self.assertEqual(data["base_url"], "https://images.example.test/v1")
        self.assertEqual(data["api_key"], "replace-with-temporary-local-key")
        self.assertEqual(data["api_key_env"], "IMAGEGEN_API_KEY")
        self.assertEqual(data["model"], "gpt-image-2")
        self.assertFalse(data["capabilities"]["transparent_background"])

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


if __name__ == "__main__":
    unittest.main()
