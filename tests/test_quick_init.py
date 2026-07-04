from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "quick-init.py"


def load_quick_init():
    spec = importlib.util.spec_from_file_location("quick_init_under_test", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load quick-init.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class QuickInitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.quick_init = load_quick_init()
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
                    "postprocess": {"enabled": False},
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        self.quick_init.imagegen.AUTH_PATH = self.auth_path
        self.quick_init.imagegen.EXAMPLE_AUTH_PATH = self.example_path

    def tearDown(self) -> None:
        for path in sorted(self.temp_dir.rglob("*"), reverse=True):
            if path.is_dir():
                path.rmdir()
            else:
                path.unlink()
        self.temp_dir.rmdir()

    def test_non_interactive_env_auth_writes_user_supplied_config(self) -> None:
        exit_code = self.quick_init.main(
            [
                "--non-interactive",
                "--base-url",
                "https://images.example.test/v1/",
                "--model",
                "gpt-image-2",
                "--auth-method",
                "env",
                "--api-key-env",
                "IMAGEGEN_API_KEY",
                "--no-transparent-background",
            ]
        )

        self.assertEqual(exit_code, 0)
        data = json.loads(self.auth_path.read_text(encoding="utf-8"))
        self.assertEqual(data["base_url"], "https://images.example.test/v1")
        self.assertEqual(data["model"], "gpt-image-2")
        self.assertEqual(data["api_key"], "replace-with-temporary-local-key")
        self.assertEqual(data["api_key_env"], "IMAGEGEN_API_KEY")
        self.assertFalse(data["capabilities"]["transparent_background"])

    def test_interactive_local_auth_writes_key_without_printing_it(self) -> None:
        stdout = io.StringIO()
        answers = iter(
            [
                "https://images.example.test/v1",
                "gpt-image-2",
                "local",
                "y",
            ]
        )

        with (
            mock.patch("builtins.input", lambda _prompt="": next(answers)),
            mock.patch("getpass.getpass", return_value="local-secret-key"),
            mock.patch("sys.stdout", stdout),
        ):
            exit_code = self.quick_init.main([])

        self.assertEqual(exit_code, 0)
        data = json.loads(self.auth_path.read_text(encoding="utf-8"))
        self.assertEqual(data["api_key"], "local-secret-key")
        self.assertEqual(data["api_key_env"], "")
        self.assertNotIn("local-secret-key", stdout.getvalue())
        self.assertIn("***REDACTED***", stdout.getvalue())

    def test_non_interactive_local_auth_is_rejected(self) -> None:
        stderr = io.StringIO()

        with mock.patch("sys.stderr", stderr):
            exit_code = self.quick_init.main(
                [
                    "--non-interactive",
                    "--base-url",
                    "https://images.example.test/v1",
                    "--model",
                    "gpt-image-2",
                    "--auth-method",
                    "local",
                ]
            )

        self.assertEqual(exit_code, 1)
        self.assertFalse(self.auth_path.exists())
        self.assertIn("local auth requires interactive setup", stderr.getvalue())

    def test_existing_auth_is_not_overwritten_without_force(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://existing.example.test/v1",
                    "api_key": "existing-secret",
                    "api_key_env": "",
                    "model": "existing-model",
                }
            ),
            encoding="utf-8",
        )

        exit_code = self.quick_init.main(
            [
                "--non-interactive",
                "--base-url",
                "https://new.example.test/v1",
                "--model",
                "new-model",
                "--auth-method",
                "env",
                "--api-key-env",
                "NEW_KEY",
            ]
        )

        self.assertEqual(exit_code, 0)
        data = json.loads(self.auth_path.read_text(encoding="utf-8"))
        self.assertEqual(data["base_url"], "https://existing.example.test/v1")
        self.assertEqual(data["api_key"], "existing-secret")
        self.assertEqual(data["model"], "existing-model")

    def test_force_overwrites_existing_auth(self) -> None:
        self.auth_path.write_text(
            json.dumps(
                {
                    "base_url": "https://existing.example.test/v1",
                    "api_key": "existing-secret",
                    "api_key_env": "",
                    "model": "existing-model",
                }
            ),
            encoding="utf-8",
        )

        exit_code = self.quick_init.main(
            [
                "--non-interactive",
                "--force",
                "--base-url",
                "https://new.example.test/v1",
                "--model",
                "new-model",
                "--auth-method",
                "env",
                "--api-key-env",
                "NEW_KEY",
                "--transparent-background",
            ]
        )

        self.assertEqual(exit_code, 0)
        data = json.loads(self.auth_path.read_text(encoding="utf-8"))
        self.assertEqual(data["base_url"], "https://new.example.test/v1")
        self.assertEqual(data["api_key"], "replace-with-temporary-local-key")
        self.assertEqual(data["api_key_env"], "NEW_KEY")
        self.assertEqual(data["model"], "new-model")
        self.assertTrue(data["capabilities"]["transparent_background"])

    def test_interactive_env_auth_accepts_prompted_answers(self) -> None:
        answers = iter(
            [
                "https://images.example.test/v1",
                "gpt-image-2",
                "env",
                "IMAGEGEN_API_KEY",
                "n",
            ]
        )

        with mock.patch("builtins.input", lambda _prompt="": next(answers)):
            exit_code = self.quick_init.main([])

        self.assertEqual(exit_code, 0)
        data = json.loads(self.auth_path.read_text(encoding="utf-8"))
        self.assertEqual(data["base_url"], "https://images.example.test/v1")
        self.assertEqual(data["model"], "gpt-image-2")
        self.assertEqual(data["api_key_env"], "IMAGEGEN_API_KEY")
        self.assertFalse(data["capabilities"]["transparent_background"])

    def test_non_interactive_requires_api_key_env_for_env_auth(self) -> None:
        stderr = io.StringIO()

        with mock.patch("sys.stderr", stderr):
            exit_code = self.quick_init.main(
                [
                    "--non-interactive",
                    "--base-url",
                    "https://images.example.test/v1",
                    "--model",
                    "gpt-image-2",
                    "--auth-method",
                    "env",
                ]
            )

        self.assertEqual(exit_code, 1)
        self.assertFalse(self.auth_path.exists())
        self.assertIn("--api-key-env is required", stderr.getvalue())

    def test_non_interactive_requires_transparent_background_choice(self) -> None:
        stderr = io.StringIO()

        with mock.patch("sys.stderr", stderr):
            exit_code = self.quick_init.main(
                [
                    "--non-interactive",
                    "--base-url",
                    "https://images.example.test/v1",
                    "--model",
                    "gpt-image-2",
                    "--auth-method",
                    "env",
                    "--api-key-env",
                    "IMAGEGEN_API_KEY",
                ]
            )

        self.assertEqual(exit_code, 1)
        self.assertFalse(self.auth_path.exists())
        self.assertIn("--transparent-background or --no-transparent-background is required", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
