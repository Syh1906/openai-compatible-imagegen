from __future__ import annotations

from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import migrate_image_config
if os.name == "nt":
    import windows_repository_fs as repository_fs_adapter
else:
    import posix_repository_fs as repository_fs_adapter


class ImageConfigMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.source = self.root / "source.json"
        self.user_target = self.root / "user" / "config.json"
        self.project_target = self.root / "project" / "config.json"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_standalone_env_key_migrates_to_the_user_config_only(self) -> None:
        self.write_source(standalone_config(api_key_env="IMAGEGEN_KEY", api_key="source-secret"))
        source_before = self.source.read_bytes()

        plan = migrate_image_config.plan_migration(
            source_path=self.source,
            source_kind="standalone",
            user_target=self.user_target,
        )
        public = plan.public_summary()

        self.assertTrue(plan.ready_to_write)
        self.assertNotIn("api_key", plan.user_config["providers"]["primary"])
        self.assertEqual(plan.user_config["providers"]["primary"]["api_key_env"], "IMAGEGEN_KEY")
        self.assertEqual(plan.user_config["config_version"], 1)
        self.assertEqual(plan.user_config["active_profile"], "primary/gpt-image-2")
        self.assertIsNone(plan.project_config)
        self.assertNotIn("source-secret", json.dumps(public))
        self.assertEqual(self.source.read_bytes(), source_before)

        migrate_image_config.write_migration(plan)
        self.assertEqual(json.loads(self.user_target.read_text(encoding="utf-8")), plan.user_config)
        self.assertEqual((self.user_target.parent / ".gitignore").read_text(encoding="utf-8"), "*\n")
        self.assertEqual(self.source.read_bytes(), source_before)

    def test_development_plugin_config_splits_only_explicit_project_overrides(self) -> None:
        self.write_source(development_plugin_config())

        plan = migrate_image_config.plan_migration(
            source_path=self.source,
            source_kind="development-plugin",
            user_target=self.user_target,
            project_target=self.project_target,
        )

        self.assertEqual(
            plan.project_config,
            {
                "config_version": 1,
                "defaults": {
                    "size": "1536x1024",
                    "quality": "high",
                    "output_format": "png",
                },
                "storage": {"output_directory": "artifacts/images"},
            },
        )
        self.assertEqual(plan.user_config["defaults"], {"timeout_seconds": 120, "concurrency": 4})
        self.assertNotIn("storage", plan.user_config)

        migrate_image_config.write_migration(plan)
        self.assertEqual(json.loads(self.project_target.read_text(encoding="utf-8")), plan.project_config)
        self.assertEqual((self.user_target.parent / ".gitignore").read_text(encoding="utf-8"), "*\n")
        self.assertEqual((self.project_target.parent / ".gitignore").read_text(encoding="utf-8"), "*\n")

    def test_migration_rejects_an_incompatible_local_ignore_guard(self) -> None:
        self.write_source(standalone_config(api_key_env="IMAGEGEN_KEY"))
        plan = migrate_image_config.plan_migration(
            source_path=self.source,
            source_kind="standalone",
            user_target=self.user_target,
        )
        self.user_target.parent.mkdir(parents=True)
        ignore_path = self.user_target.parent / ".gitignore"
        ignore_path.write_text("config.json\n", encoding="utf-8")

        with self.assertRaisesRegex(
            migrate_image_config.ConfigMigrationError,
            "migration_write_failed",
        ):
            migrate_image_config.write_migration(plan)

        self.assertFalse(self.user_target.exists())
        self.assertEqual(ignore_path.read_text(encoding="utf-8"), "config.json\n")

    def test_plaintext_key_requires_a_second_authorization_and_dry_run_is_redacted(self) -> None:
        self.write_source(standalone_config(api_key="plaintext-secret"))
        source_before = self.source.read_bytes()

        dry_run = migrate_image_config.plan_migration(
            source_path=self.source,
            source_kind="standalone",
            user_target=self.user_target,
        )
        self.assertFalse(dry_run.ready_to_write)
        self.assertTrue(dry_run.requires_plaintext_api_key)
        self.assertNotIn("plaintext-secret", json.dumps(dry_run.public_summary()))
        with self.assertRaisesRegex(
            migrate_image_config.ConfigMigrationError,
            "migration_plaintext_key_authorization_required",
        ):
            migrate_image_config.write_migration(dry_run)
        self.assertFalse(self.user_target.exists())

        authorized = migrate_image_config.plan_migration(
            source_path=self.source,
            source_kind="standalone",
            user_target=self.user_target,
            allow_plaintext_api_key=True,
        )
        self.assertTrue(authorized.ready_to_write)
        self.assertNotIn("plaintext-secret", repr(authorized))
        migrate_image_config.write_migration(authorized)
        self.assertEqual(
            json.loads(self.user_target.read_text(encoding="utf-8"))["providers"]["primary"]["api_key"],
            "plaintext-secret",
        )
        self.assertEqual(self.source.read_bytes(), source_before)

    def test_existing_target_stops_without_overwrite_or_source_changes(self) -> None:
        self.write_source(standalone_config(api_key_env="IMAGEGEN_KEY"))
        source_before = self.source.read_bytes()
        self.user_target.parent.mkdir(parents=True)
        self.user_target.write_text('{"existing":true}', encoding="utf-8")
        target_before = self.user_target.read_bytes()

        with self.assertRaisesRegex(
            migrate_image_config.ConfigMigrationError,
            "migration_target_exists",
        ):
            migrate_image_config.plan_migration(
                source_path=self.source,
                source_kind="standalone",
                user_target=self.user_target,
            )

        self.assertEqual(self.user_target.read_bytes(), target_before)
        self.assertEqual(self.source.read_bytes(), source_before)

    def test_removed_transparent_background_field_stops_migration(self) -> None:
        raw = standalone_config(api_key_env="IMAGEGEN_KEY")
        raw["capabilities"] = {"transparent_background": False}
        self.write_source(raw)

        with self.assertRaisesRegex(
            migrate_image_config.ConfigMigrationError,
            "migration_transparent_background_removed",
        ):
            migrate_image_config.plan_migration(
                source_path=self.source,
                source_kind="standalone",
                user_target=self.user_target,
            )
        self.assertFalse(self.user_target.exists())

    def test_unknown_model_stops_without_switching_models(self) -> None:
        self.write_source(standalone_config(api_key_env="IMAGEGEN_KEY", model="other-image-model"))
        source_before = self.source.read_bytes()

        with self.assertRaisesRegex(
            migrate_image_config.ConfigMigrationError,
            "migration_model_unsupported",
        ):
            migrate_image_config.plan_migration(
                source_path=self.source,
                source_kind="standalone",
                user_target=self.user_target,
            )
        self.assertEqual(self.source.read_bytes(), source_before)
        self.assertFalse(self.user_target.exists())

    def test_cli_defaults_to_redacted_dry_run_and_writes_only_with_write_flag(self) -> None:
        self.write_source(standalone_config(api_key_env="IMAGEGEN_KEY"))
        user_home = self.root / "home"
        output = io.StringIO()

        with redirect_stdout(output):
            status = migrate_image_config.main([
                "--source", str(self.source),
                "--source-kind", "standalone",
                "--user-home", str(user_home),
            ])
        dry_run = json.loads(output.getvalue())
        target = user_home / ".codex" / "openai-compatible-imagegen" / "config.json"
        self.assertEqual(status, 0)
        self.assertEqual(dry_run["mode"], "dry-run")
        self.assertFalse(target.exists())

        output = io.StringIO()
        with redirect_stdout(output):
            status = migrate_image_config.main([
                "--source", str(self.source),
                "--source-kind", "standalone",
                "--user-home", str(user_home),
                "--write",
            ])
        rejected = json.loads(output.getvalue())
        self.assertEqual(status, 2)
        self.assertEqual(rejected["error"]["code"], "migration_expected_source_sha256_required")
        self.assertFalse(target.exists())

        output = io.StringIO()
        with redirect_stdout(output):
            status = migrate_image_config.main([
                "--source", str(self.source),
                "--source-kind", "standalone",
                "--user-home", str(user_home),
                "--write",
                "--expected-source-sha256", dry_run["sourceSha256"],
            ])
        written = json.loads(output.getvalue())
        self.assertEqual(status, 0)
        self.assertEqual(written["mode"], "write")
        self.assertTrue(target.is_file())

    def test_cli_write_rejects_a_source_digest_that_does_not_match_the_dry_run(self) -> None:
        self.write_source(standalone_config(api_key_env="IMAGEGEN_KEY"))
        user_home = self.root / "home"
        output = io.StringIO()

        with redirect_stdout(output):
            status = migrate_image_config.main([
                "--source", str(self.source),
                "--source-kind", "standalone",
                "--user-home", str(user_home),
                "--write",
                "--expected-source-sha256", "0" * 64,
            ])

        result = json.loads(output.getvalue())
        self.assertEqual(status, 1)
        self.assertEqual(result["error"]["code"], "migration_source_changed")
        self.assertFalse((user_home / ".codex" / "openai-compatible-imagegen" / "config.json").exists())

    def test_source_symlink_and_target_parent_reparse_point_are_rejected_without_resolution(self) -> None:
        real_source = self.root / "real-source.json"
        real_source.write_text(json.dumps(standalone_config(api_key_env="IMAGEGEN_KEY")), encoding="utf-8")
        source_link = self.root / "source-link.json"
        outside = self.root / "outside"
        outside.mkdir()
        target_parent_link = self.root / "target-parent-link"
        try:
            os.symlink(real_source, source_link)
            os.symlink(outside, target_parent_link, target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"symbolic links are unavailable: {exc}")

        with self.assertRaisesRegex(
            migrate_image_config.ConfigMigrationError,
            "migration_source_invalid",
        ):
            migrate_image_config.plan_migration(
                source_path=source_link,
                source_kind="standalone",
                user_target=self.user_target,
            )

        with self.assertRaisesRegex(
            migrate_image_config.ConfigMigrationError,
            "migration_target_invalid",
        ):
            migrate_image_config.plan_migration(
                source_path=real_source,
                source_kind="standalone",
                user_target=target_parent_link / "config.json",
            )
        self.assertFalse((outside / "config.json").exists())

    def test_interrupted_safe_write_does_not_leave_a_final_or_temporary_file(self) -> None:
        self.write_source(standalone_config(api_key_env="IMAGEGEN_KEY"))
        plan = migrate_image_config.plan_migration(
            source_path=self.source,
            source_kind="standalone",
            user_target=self.user_target,
        )

        with mock.patch.object(repository_fs_adapter, "_write_all", side_effect=OSError("interrupted")):
            with self.assertRaisesRegex(
                migrate_image_config.ConfigMigrationError,
                "migration_write_failed",
            ):
                migrate_image_config.write_migration(plan)

        self.assertFalse(self.user_target.exists())
        self.assertEqual(list(self.user_target.parent.glob("*.tmp")), [])

    def test_failed_rollback_reports_the_residual_target_explicitly(self) -> None:
        self.write_source(development_plugin_config())
        plan = migrate_image_config.plan_migration(
            source_path=self.source,
            source_kind="development-plugin",
            user_target=self.user_target,
            project_target=self.project_target,
        )

        def publish(target: Path, value: dict, _lease) -> None:
            if target == self.project_target:
                raise OSError("second publish failed")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(value), encoding="utf-8")

        with (
            mock.patch.object(migrate_image_config, "publish_json_new", side_effect=publish, create=True),
            mock.patch.object(
                migrate_image_config,
                "rollback_published_target",
                side_effect=OSError("rollback failed"),
            ),
        ):
            with self.assertRaises(migrate_image_config.ConfigMigrationError) as raised:
                migrate_image_config.write_migration(plan)

        self.assertEqual(raised.exception.code, "migration_rollback_failed")
        self.assertIn(self.user_target.as_posix(), str(raised.exception))
        self.assertTrue(self.user_target.exists())

    def test_migration_rejects_values_outside_the_runtime_schema(self) -> None:
        invalid_cases = []
        invalid_quality = development_plugin_config()
        invalid_quality["defaults"]["quality"] = "ultra"
        invalid_cases.append(invalid_quality)
        invalid_timeout = development_plugin_config()
        invalid_timeout["defaults"]["timeout_seconds"] = 601
        invalid_cases.append(invalid_timeout)
        invalid_size = development_plugin_config()
        invalid_size["defaults"]["size"] = "１２x1024"
        invalid_cases.append(invalid_size)
        invalid_storage = development_plugin_config()
        invalid_storage["storage"]["unexpected"] = True
        invalid_cases.append(invalid_storage)
        escaping_storage = development_plugin_config()
        escaping_storage["storage"]["output_directory"] = "../outside"
        invalid_cases.append(escaping_storage)
        invalid_postprocess = development_plugin_config()
        invalid_postprocess["postprocess"]["enabled"] = "yes"
        invalid_cases.append(invalid_postprocess)

        for raw in invalid_cases:
            with self.subTest(raw=raw):
                self.write_source(raw)
                with self.assertRaisesRegex(
                    migrate_image_config.ConfigMigrationError,
                    "migration_source_invalid",
                ):
                    migrate_image_config.plan_migration(
                        source_path=self.source,
                        source_kind="development-plugin",
                        user_target=self.user_target,
                    )

    def test_project_output_contains_only_the_runtime_override_whitelist(self) -> None:
        raw = development_plugin_config()
        raw["storage"] = {"output_directory": "artifacts/images", "unexpected": True}
        self.write_source(raw)

        with self.assertRaisesRegex(
            migrate_image_config.ConfigMigrationError,
            "migration_source_invalid",
        ):
            migrate_image_config.plan_migration(
                source_path=self.source,
                source_kind="development-plugin",
                user_target=self.user_target,
                project_target=self.project_target,
            )

    def write_source(self, value: dict) -> None:
        self.source.write_text(json.dumps(value), encoding="utf-8")


def standalone_config(
    *,
    api_key: str | None = None,
    api_key_env: str | None = None,
    model: str = "gpt-image-2",
) -> dict:
    raw = {
        "base_url": "https://images.example.test/v1",
        "model": model,
        "defaults": {"quality": "high", "concurrency": 3},
        "postprocess": {"enabled": True},
        "transparency": {"default_route": "chroma-matting"},
    }
    if api_key is not None:
        raw["api_key"] = api_key
    if api_key_env is not None:
        raw["api_key_env"] = api_key_env
    return raw


def development_plugin_config() -> dict:
    return {
        "providers": {
            "primary": {
                "protocol": "openai-compatible",
                "base_url": "https://images.example.test/v1",
                "api_key_env": "IMAGEGEN_KEY",
                "user_agent": "Imagegen-Migration/1.0",
            }
        },
        "models": {
            "primary/gpt-image-2": {
                "provider": "primary",
                "model": "gpt-image-2",
                "capabilities": {"generate": True, "edit": True, "mask": True},
            }
        },
        "defaults": {
            "size": "1536x1024",
            "quality": "high",
            "output_format": "png",
            "timeout_seconds": 120,
            "concurrency": 4,
        },
        "postprocess": {"enabled": True},
        "transparency": {"default_route": "chroma-matting"},
        "storage": {"output_directory": "artifacts/images"},
    }


if __name__ == "__main__":
    unittest.main()
