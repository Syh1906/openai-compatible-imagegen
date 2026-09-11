from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import provider_config


class ProviderConfigAdapterTests(unittest.TestCase):
    def test_native_profiles_keep_provider_contracts_and_own_defaults(self) -> None:
        raw = plugin_config()
        raw["config_version"] = 2
        raw["defaults"] = {"timeout_seconds": 90}
        raw["providers"]["native"] = {"protocol": "xai-images", "base_url": "https://native.example.test/v1", "api_key_env": "IMAGEGEN_TEST_KEY"}
        raw["models"]["native/grok"] = {"provider": "native", "model": "grok-imagine-image-2.0", "aliases": [" Grok ", "ＧＲＯＫ"], "defaults": {"aspect_ratio": "1:1", "resolution": "1K"}, "capabilities": {"generate": True, "edit": True, "mask": True}, "limits": {"max_input_images": 3}}
        cfg = provider_config.parse_plugin_config(raw, require_api_key=True, model_profile_id="native/grok")
        self.assertEqual(cfg.protocol, "xai-images")
        self.assertEqual(cfg.defaults, {"timeout_seconds": 90, "aspect_ratio": "1:1", "resolution": "1K"})
        self.assertEqual(cfg.config_version, 2)
        item = provider_config.list_model_profiles(raw)[1]
        self.assertFalse(item["effectiveCapabilities"]["mask"])
        self.assertEqual(item["limits"]["max_input_images"], 3)
        self.assertEqual(item["aliases"], ["Grok"])

    def test_invalid_unselected_provider_is_rejected_without_resolving_its_key(self) -> None:
        raw = plugin_config()
        raw["providers"]["broken"] = {"protocol": "invented", "base_url": "https://example.test", "api_key_env": "MISSING_TEST_KEY"}
        with self.assertRaises(provider_config.ProviderConfigError):
            provider_config.parse_plugin_config(raw, require_api_key=True, model_profile_id="primary/gpt-image-2")

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

    def test_standalone_and_plugin_adapters_preserve_atlas_protocol(self) -> None:
        standalone = provider_config.parse_standalone_config(
            {
                "protocol": "atlas",
                "base_url": "https://api.atlascloud.ai",
                "api_key_env": "IMAGEGEN_TEST_KEY",
                "model": "openai/gpt-image-2/text-to-image",
            },
            require_api_key=True,
        )
        raw = plugin_config()
        raw["providers"]["primary"]["protocol"] = "atlas"
        raw["providers"]["primary"]["base_url"] = "https://api.atlascloud.ai"
        raw["models"]["primary/gpt-image-2"]["model"] = "openai/gpt-image-2/text-to-image"
        plugin = provider_config.parse_plugin_config(
            raw,
            require_api_key=True,
            model_profile_id="primary/gpt-image-2",
        )

        self.assertEqual(standalone.protocol, "atlas")
        self.assertEqual(plugin.protocol, "atlas")

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

    def test_plugin_adapter_accepts_custom_profile_and_model_ids(self) -> None:
        raw = plugin_config()
        raw["active_profile"] = "vendor/custom-profile"
        raw["models"] = {
            "vendor/custom-profile": {
                "provider": "primary",
                "model": "vendor-image-alpha",
                "capabilities": {"generate": True},
            }
        }

        parsed = provider_config.parse_plugin_config(
            raw,
            require_api_key=True,
            model_profile_id="vendor/custom-profile",
        )

        self.assertEqual(parsed.model, "vendor-image-alpha")

    def test_explicit_profiles_use_their_own_provider_without_changing_default(self) -> None:
        raw = plugin_config()
        for name, model in (("grok", "grok-imagine-image-2.0"), ("gemini", "gemini-3.1-flash-image")):
            raw["providers"][name] = {
                "protocol": "openai-compatible",
                "base_url": f"https://{name}.example.test/v1",
                "api_key_env": f"IMAGEGEN_{name.upper()}_KEY",
            }
            raw["models"][f"{name}/image"] = {
                "provider": name, "model": model, "capabilities": {"generate": True},
            }
        with mock.patch.dict(os.environ, {"IMAGEGEN_GROK_KEY": "fixture-grok", "IMAGEGEN_GEMINI_KEY": "fixture-gemini"}):
            for name in ("grok", "gemini"):
                cfg = provider_config.parse_plugin_config(raw, require_api_key=True, model_profile_id=f"{name}/image")
                self.assertEqual(cfg.profile_id, f"{name}/image")
                self.assertEqual(cfg.provider_id, name)
                self.assertEqual(cfg.base_url, f"https://{name}.example.test/v1")
                self.assertEqual(cfg.api_key, f"fixture-{name}")
        self.assertEqual(raw["active_profile"], "primary/gpt-image-2")

    def test_independent_providers_can_share_address_and_key_reference(self) -> None:
        raw = plugin_config()
        raw["providers"]["gemini"] = dict(raw["providers"]["primary"])
        raw["models"]["gemini/image"] = {"provider": "gemini", "model": "gemini-3.1-flash-image"}
        cfg = provider_config.parse_plugin_config(raw, require_api_key=True, model_profile_id="gemini/image")
        self.assertEqual(cfg.provider_id, "gemini")
        self.assertEqual(cfg.model, "gemini-3.1-flash-image")
        self.assertEqual(cfg.base_url, "https://images.example.test/v1")

    def test_v2_profile_defaults_do_not_leak_to_other_models_or_local_delivery(self) -> None:
        raw = plugin_config()
        raw.update(config_version=2, defaults={"timeout_seconds": 120}, host_defaults={"quality": "medium"})
        raw["models"]["primary/gpt-image-2"]["defaults"] = {"quality": "max", "size": "1536x1024"}
        raw["providers"]["grok"] = dict(raw["providers"]["primary"])
        raw["models"]["grok/image"] = {"provider": "grok", "model": "grok-imagine-image-2.0", "defaults": {"quality": "low"}}
        selected = provider_config.parse_plugin_config(raw, require_api_key=True, model_profile_id="grok/image")
        self.assertEqual(selected.defaults, {"timeout_seconds": 120, "quality": "low"})
        gpt = provider_config.parse_plugin_config(raw, require_api_key=True, model_profile_id="primary/gpt-image-2")
        self.assertEqual(gpt.defaults["quality"], "max")
        local = provider_config.parse_plugin_local_config(raw)
        self.assertEqual(local.defaults, {"timeout_seconds": 120, "quality": "medium"})

    def test_standalone_accepts_same_v2_profile_selection_without_changing_legacy_model(self) -> None:
        raw = plugin_config()
        raw.update(config_version=2, defaults={})
        raw["models"]["primary/gpt-image-2"]["defaults"] = {"quality": "xhigh"}
        cfg = provider_config.parse_standalone_config(raw, require_api_key=True, model_profile_id="primary/gpt-image-2")
        self.assertEqual(cfg.defaults["quality"], "xhigh")
        self.assertEqual(cfg.provider_id, "primary")

    def test_catalog_lists_all_profiles_with_safe_metadata_and_explicit_selection(self) -> None:
        raw = plugin_config()
        raw.update(config_version=2, defaults={})
        raw["models"]["primary/gpt-image-2"].update(display_name="GPT Image", aliases=["GPT", "ｇｐｔ"])
        raw["providers"]["gemini"] = {**raw["providers"]["primary"], "display_name": "Gemini 接口", "api_key_env": "UNSET_FIXTURE_KEY"}
        raw["models"]["gemini/image"] = {"provider": "gemini", "model": "gemini-3.1-flash-image", "aliases": ["香蕉"], "capabilities": {"generate": True, "edit": True}}
        catalog = provider_config.list_model_profiles(raw)
        self.assertEqual([m["id"] for m in catalog], ["primary/gpt-image-2", "gemini/image"])
        self.assertEqual(catalog[0]["aliases"], ["GPT"])
        self.assertTrue(catalog[0]["isDefault"])
        self.assertEqual(catalog[1]["providerDisplayName"], "Gemini 接口")
        self.assertEqual(catalog[1]["availability"], "missing_credentials")
        self.assertEqual(len(catalog[1]["selectionFingerprint"]), 64)
        self.assertNotIn("base_url", str(catalog))
        self.assertNotIn("UNSET_FIXTURE_KEY", str(catalog))

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

    def test_standalone_and_plugin_adapters_preserve_custom_proxy_url(self) -> None:
        proxy = {"url": "http://127.0.0.1:7890"}
        standalone = provider_config.parse_standalone_config(
            {
                "base_url": "https://images.example.test/v1",
                "api_key_env": "IMAGEGEN_TEST_KEY",
                "model": "gpt-image-2",
                "proxy": proxy,
            },
            require_api_key=True,
        )
        raw = plugin_config()
        raw["providers"]["primary"]["proxy"] = proxy
        plugin = provider_config.parse_plugin_config(
            raw,
            require_api_key=True,
            model_profile_id="primary/gpt-image-2",
        )

        self.assertEqual(standalone.proxy, proxy)
        self.assertEqual(plugin.proxy, proxy)

    def test_adapters_reject_invalid_custom_proxy_urls(self) -> None:
        invalid_urls = (
            "socks5://127.0.0.1:7890",
            "http:///missing-host",
            "http://127.0.0.1:70000",
            "http://user:password@127.0.0.1:7890",
            "http://127.0.0.1:7890?mode=test",
            "http://127.0.0.1:7890#fragment",
            "http://127.0.0.1:7890\n",
        )
        for proxy_url in invalid_urls:
            with self.subTest(proxy_url=proxy_url):
                standalone = {
                    "base_url": "https://images.example.test/v1",
                    "api_key_env": "IMAGEGEN_TEST_KEY",
                    "model": "gpt-image-2",
                    "proxy": {"url": proxy_url},
                }
                with self.assertRaisesRegex(provider_config.ProviderConfigError, "proxy.url"):
                    provider_config.parse_standalone_config(standalone, require_api_key=True)

                raw = plugin_config()
                raw["providers"]["primary"]["proxy"] = {"url": proxy_url}
                with self.assertRaisesRegex(provider_config.ProviderConfigError, "proxy.url"):
                    provider_config.parse_plugin_config(
                        raw,
                        require_api_key=True,
                        model_profile_id="primary/gpt-image-2",
                    )


class ExtensibleProfileTests(unittest.TestCase):
    def test_provider_endpoints_and_model_parameters_are_independent(self):
        raw = plugin_config()
        raw.update(config_version=2, defaults={})
        raw["providers"]["primary"]["endpoints"] = {"generate": "https://generate.example.test/render", "edit": "https://edit.example.test/transform/{model}"}
        raw["models"][raw["active_profile"]]["parameters"] = {"seed": 42, "vendor_option": {"future": True}}
        cfg = provider_config.parse_plugin_config(raw, require_api_key=False, model_profile_id=raw["active_profile"])
        self.assertEqual(cfg.endpoints, raw["providers"]["primary"]["endpoints"])
        self.assertEqual(cfg.parameters, {"seed": 42, "vendor_option": {"future": True}})
        raw["models"][raw["active_profile"]]["parameters"] = {"model": "override"}
        with self.assertRaises(provider_config.ProviderConfigError):
            provider_config.parse_plugin_config(raw, require_api_key=False, model_profile_id=raw["active_profile"])


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
