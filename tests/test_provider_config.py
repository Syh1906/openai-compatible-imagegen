from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import provider_config


class ProviderConfigAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = mock.patch.dict(
            os.environ,
            {"IMAGEGEN_TEST_KEY": "adapter-secret"},
            clear=False,
        )
        self.environment.start()

    def tearDown(self) -> None:
        self.environment.stop()

    def test_standalone_and_plugin_adapters_return_one_effective_type(self) -> None:
        standalone = provider_config.parse_standalone_config(
            {
                "base_url": "https://images.example.test/v1",
                "api_key_env": "IMAGEGEN_TEST_KEY",
                "model": "gpt-image-2",
                "defaults": {"quality": "high"},
            },
            require_api_key=True,
        )
        plugin = provider_config.parse_plugin_config(
            plugin_config(),
            require_api_key=True,
            model_profile_id="primary/gpt-image-2",
        )

        self.assertIsInstance(standalone, provider_config.EffectiveImageConfig)
        self.assertIsInstance(plugin, provider_config.EffectiveImageConfig)
        self.assertEqual(standalone.model, plugin.model)
        self.assertEqual(standalone.api_key_source, "env:IMAGEGEN_TEST_KEY")

    def test_plugin_adapter_requires_final_schema_identity(self) -> None:
        for update in (
            {"config_version": None},
            {"config_version": 2},
            {"active_profile": None},
            {"active_profile": "secondary/gpt-image-2"},
        ):
            with self.subTest(update=update):
                raw = plugin_config()
                raw.update(update)
                with self.assertRaises(provider_config.ProviderConfigError):
                    provider_config.parse_plugin_config(
                        raw,
                        require_api_key=True,
                        model_profile_id="primary/gpt-image-2",
                    )

    def test_plugin_adapter_rejects_removed_transparent_background_capability(self) -> None:
        raw = plugin_config()
        raw["models"]["primary/gpt-image-2"]["capabilities"]["transparent_background"] = True

        with self.assertRaisesRegex(
            provider_config.ProviderConfigError,
            "unsupported model capability: transparent_background",
        ):
            provider_config.parse_plugin_config(
                raw,
                require_api_key=True,
                model_profile_id="primary/gpt-image-2",
            )

    def test_plugin_adapter_rejects_invalid_api_key_env_names(self) -> None:
        for api_key_env in ("BAD-NAME", "BAD NAME", "BAD\x00NAME"):
            with self.subTest(api_key_env=api_key_env):
                raw = plugin_config()
                raw["providers"]["primary"]["api_key_env"] = api_key_env
                with self.assertRaisesRegex(provider_config.ProviderConfigError, "api_key_env must be a valid environment variable name"):
                    provider_config.parse_plugin_config(
                        raw,
                        require_api_key=False,
                        model_profile_id="primary/gpt-image-2",
                    )

    def test_plugin_adapter_preserves_the_configured_provider_id(self) -> None:
        raw = plugin_config()
        raw["providers"]["corp"] = raw["providers"].pop("primary")
        raw["models"]["primary/gpt-image-2"]["provider"] = "corp"

        plugin = provider_config.parse_plugin_config(
            raw,
            require_api_key=True,
            model_profile_id="primary/gpt-image-2",
        )

        self.assertEqual(plugin.provider_id, "corp")


def plugin_config() -> dict:
    return {
        "config_version": 1,
        "active_profile": "primary/gpt-image-2",
        "providers": {
            "primary": {
                "protocol": "openai-compatible",
                "base_url": "https://images.example.test/v1",
                "api_key_env": "IMAGEGEN_TEST_KEY",
            }
        },
        "models": {
            "primary/gpt-image-2": {
                "provider": "primary",
                "model": "gpt-image-2",
                "capabilities": {"generate": True, "edit": True, "mask": True},
            }
        },
        "defaults": {"quality": "high"},
    }


if __name__ == "__main__":
    unittest.main()
