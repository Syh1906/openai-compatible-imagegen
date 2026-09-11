import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertImageConfigBindingCurrent,
  initializeImageConfig,
  inspectImageConfig,
  updateImageConfig,
  projectConfigPath,
  resolveImageConfigBinding,
  userConfigPath,
} from "../../mcp/config-resolution.mjs";
import { withClient } from "../support/mcp-tool-client.mjs";
import { outputSchema, batchItemsSchema } from "../../mcp/image-tool-schemas.mjs";

test("canvas submission mode is a validated user preference with the existing automatic default", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    for (const config_version of [1, 2]) {
      await writeJson(userConfigPath(userHome), { config_version, auth_mode: "chatgpt" });
      assert.equal((await resolveImageConfigBinding({ projectRoot, userHome })).canvasSubmissionMode, "auto");
      for (const mode of ["composer", "message", "auto"]) {
        await updateImageConfig({ userHome, changes: { canvas_submission_mode: mode } });
        const binding = await resolveImageConfigBinding({ projectRoot, userHome });
        assert.equal(binding.canvasSubmissionMode, mode);
        assert.equal((await inspectImageConfig({ userHome })).canvasSubmissionMode, mode);
        assert.equal(binding.localRuntimeConfig.canvas_submission_mode, undefined);
      }
      for (const mode of [null, "", "other", false, {}]) {
        await assert.rejects(updateImageConfig({ userHome, changes: { canvas_submission_mode: mode } }), { code: "image_config_invalid" });
      }
    }
    await writeJson(userConfigPath(userHome), userConfig({ canvas_submission_mode: "composer" }));
    assert.equal((await resolveImageConfigBinding({ projectRoot, userHome })).apiRuntimeConfig.canvas_submission_mode, undefined);
    await writeJson(projectConfigPath(projectRoot), projectConfig());
    await assert.rejects(updateImageConfig({ projectRoot, scope: "project", changes: { canvas_submission_mode: "composer" } }), { code: "image_config_update_forbidden" });
    await writeJson(projectConfigPath(projectRoot), { ...projectConfig(), canvas_submission_mode: "message" });
    await assert.rejects(resolveImageConfigBinding({ projectRoot, userHome }), { code: "project_config_forbidden" });
  });
});


test("image quality schema accepts native values while v1 defaults keep legacy validation", async () => {
  for (const quality of ["auto", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(outputSchema.quality.parse(quality), quality);
    const items = batchItemsSchema.parse([
      { requestId: "generate", operation: "generate", prompt: "test", quality },
      { requestId: "edit", operation: "edit", parentImageId: "img_01J00000000000000000000000", prompt: "test", quality },
    ]);
    assert.deepEqual(items.map((item) => item.quality), [quality, quality]);
    await withConfigRoots(async ({ projectRoot, userHome }) => {
      await initializeImageConfig({ userHome });
      await writeJson(projectConfigPath(projectRoot), projectConfig());
      const user = await updateImageConfig({ userHome, scope: "user", changes: { defaults: { quality } } });
      const project = await updateImageConfig({ projectRoot, scope: "project", changes: { defaults: { quality } } });
      assert.equal(user.config.defaults.quality, quality);
      assert.equal(project.config.defaults.quality, quality);
      await assert.rejects(updateImageConfig({ userHome, scope: "user", changes: { defaults: { quality: "ultra" } } }));
    });
  }
  assert.equal(outputSchema.quality.safeParse("ultra").success, true);
});

test("configuration MCP tools initialize, inspect, and update without exposing credentials", async () => {
  const calls = [];
  await withClient({
    configManager: {
      async initialize(input) {
        calls.push(["initialize", input]);
        return { created: true, path: "user-config", config: { providers: { primary: { api_key_env: "IMAGE_API_KEY" } } }, gitignoreUpdated: true };
      },
      async inspect(input) {
        calls.push(["inspect", input]);
        return { user: { exists: true, config: {} }, project: { exists: false, config: null } };
      },
      async update(input) {
        calls.push(["update", input]);
        return { scope: input.scope, path: "user-config", config: input.changes };
      },
    },
    runTask: async () => { throw new Error("not used"); },
    readArtifact: async () => { throw new Error("not used"); },
  }, async (client) => {
    const initialized = await client.callTool({ name: "initialize_image_config", arguments: { authMode: "chatgpt" } });
    assert.equal(initialized.structuredContent.created, true);
    const inspected = await client.callTool({ name: "inspect_image_config", arguments: {} });
    assert.equal(inspected.structuredContent.user.exists, true);
    const updated = await client.callTool({ name: "update_image_config", arguments: { changes: { defaults: { quality: "high" } } } });
    assert.equal(updated.structuredContent.scope, "user");
  });
  assert.deepEqual(calls.map(([name]) => name), ["initialize", "inspect", "update"]);
  assert.equal(calls[0][1].authMode, "chatgpt");
  assert.equal(JSON.stringify(calls).includes('"api_key":"'), false);
});

test("configuration management initializes, redacts, and updates the fixed user file", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const initialized = await initializeImageConfig({ userHome });
    assert.equal(initialized.created, true);
    assert.equal(initialized.path, userConfigPath(userHome));
    assert.equal(initialized.gitignoreUpdated, true);
    assert.equal(
      await readFile(path.join(path.dirname(userConfigPath(userHome)), ".gitignore"), "utf8"),
      "*\n",
    );
    assert.equal(initialized.config.providers.primary.api_key, undefined);
    assert.equal(initialized.config.providers.primary.api_key_env, "IMAGE_API_KEY");
    assert.equal(initialized.config.providers.primary.proxy, undefined);
    assert.equal(initialized.guidance.modelIdIsUserConfigured, true);
    assert.equal(initialized.guidance.nativeModelIdsAreCapabilityDeclaration, true);

    const inspected = await inspectImageConfig({ userHome, projectRoot });
    assert.equal(inspected.user.exists, true);
    assert.equal(inspected.user.config.providers.primary.api_key, undefined);
    assert.equal(inspected.project.exists, false);
    assert.equal(inspected.activeProfile, "primary/gpt-image-2");
    assert.equal(inspected.transparencySummary.retryWithoutParameter, true);

    const updated = await updateImageConfig({
      userHome,
      scope: "user",
      changes: {
        providers: {
          primary: {
            base_url: "https://images.example.test/v1",
            api_key_env: "NEW_IMAGE_KEY",
            proxy: { url: "http://127.0.0.1:7890" },
          },
        },
        defaults: { quality: "high" },
      },
    });
    assert.equal(updated.config.defaults.quality, "high");
    assert.equal(updated.config.providers.primary.base_url, "https://images.example.test/v1");
    assert.equal(updated.config.providers.primary.api_key_env, "NEW_IMAGE_KEY");
    assert.equal(updated.requiresRebind, true);
    assert.deepEqual(updated.config.providers.primary.proxy, { configured: true });
    assert.equal(JSON.stringify(updated).includes("127.0.0.1:7890"), false);
    const stored = JSON.parse(await readFile(userConfigPath(userHome), "utf8"));
    assert.deepEqual(stored.providers.primary.proxy, { url: "http://127.0.0.1:7890" });
  });
});

test("configuration initialization supports an explicit ChatGPT-only template", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const initialized = await initializeImageConfig({ userHome, projectRoot, authMode: "chatgpt" });
    const stored = JSON.parse(await readFile(userConfigPath(userHome), "utf8"));

    assert.equal(initialized.config.auth_mode, "chatgpt");
    assert.equal(stored.auth_mode, "chatgpt");
    assert.equal(stored.active_profile, undefined);
    assert.equal(stored.providers, undefined);
    assert.equal(stored.models, undefined);
    assert.equal(initialized.guidance.requiresApiProvider, false);
    assert.equal(initialized.guidance.modelIdIsUserConfigured, false);
    assert.equal(
      initialized.nextSteps.some((step) => /active_profile|models\./.test(step)),
      false,
    );
  });
});

test("configuration routes preserve legacy API Key defaults and allow ChatGPT-only local settings", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    await writeJson(userConfigPath(userHome), userConfig());
    const legacyBinding = await resolveImageConfigBinding({ projectRoot, userHome });
    assert.equal(legacyBinding.defaultAuthMode, "apikey");
    assert.equal(legacyBinding.apiKeyConfigured, true);
    assert.equal(legacyBinding.chatgptRequirement, "codex_app_imagegen_handoff");
    assert.notEqual(legacyBinding.localRuntimeConfig, null);
    assert.notEqual(legacyBinding.apiRuntimeConfig, null);

    await writeJson(userConfigPath(userHome), chatgptOnlyConfig());
    const chatgptBinding = await resolveImageConfigBinding({ projectRoot, userHome });
    assert.equal(chatgptBinding.defaultAuthMode, "chatgpt");
    assert.equal(chatgptBinding.apiKeyConfigured, false);
    assert.equal(chatgptBinding.activeProfile, null);
    assert.notEqual(chatgptBinding.localRuntimeConfig, null);
    assert.equal(chatgptBinding.apiRuntimeConfig, null);

    const inspected = await inspectImageConfig({ projectRoot, userHome });
    assert.equal(inspected.defaultAuthMode, "chatgpt");
    assert.equal(inspected.apiKeyConfigured, false);
    assert.equal(inspected.chatgptRequirement, "codex_app_imagegen_handoff");
  });
});

test("ChatGPT configuration accepts a complete API route and rejects partial API declarations", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    await writeJson(userConfigPath(userHome), userConfig({ auth_mode: "chatgpt" }));
    const binding = await resolveImageConfigBinding({ projectRoot, userHome });
    assert.equal(binding.defaultAuthMode, "chatgpt");
    assert.equal(binding.apiKeyConfigured, true);
    assert.notEqual(binding.apiRuntimeConfig, null);

    for (const config of [
      { ...chatgptOnlyConfig(), providers: userConfig().providers },
      { ...chatgptOnlyConfig(), active_profile: "primary/gpt-image-2", models: userConfig().models },
    ]) {
      await writeJson(userConfigPath(userHome), config);
      await assert.rejects(resolveImageConfigBinding({ projectRoot, userHome }), { code: "image_config_invalid" });
    }
  });
});

test("API Key configuration still requires a complete provider and project config cannot select a route", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    await writeJson(userConfigPath(userHome), { ...chatgptOnlyConfig(), auth_mode: "apikey" });
    await assert.rejects(resolveImageConfigBinding({ projectRoot, userHome }), { code: "image_config_invalid" });

    await writeJson(userConfigPath(userHome), userConfig());
    await writeJson(projectConfigPath(projectRoot), { config_version: 1, auth_mode: "chatgpt" });
    await assert.rejects(resolveImageConfigBinding({ projectRoot, userHome }), { code: "project_config_forbidden" });
  });
});

test("custom profile and model IDs remain valid and are exposed by inspection", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const config = userConfig({
      active_profile: "vendor/profile",
      models: {
        "primary/gpt-image-2": undefined,
        "vendor/profile": { provider: "primary", model: "vendor-image-v7", capabilities: { generate: true } },
      },
      transparency: {
        default_route: "native-alpha",
        native: { enabled: true, model_ids: [], retry_without_parameter: false, fallback_route: "emissive-alpha" },
      },
    });
    delete config.models["primary/gpt-image-2"];
    await writeJson(userConfigPath(userHome), config);
    const binding = await resolveImageConfigBinding({ projectRoot, userHome });
    assert.equal(binding.activeProfile, "vendor/profile");
    const inspected = await inspectImageConfig({ projectRoot, userHome });
    assert.equal(inspected.modelId, "vendor-image-v7");
    assert.equal(inspected.transparencySummary.retryWithoutParameter, false);
    assert.equal(inspected.transparencySummary.fallbackRoute, "emissive-alpha");
  });
});

test("all selectable profiles validate their own provider, including inactive profiles", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const config = userConfig();
    config.providers.gemini = { ...config.providers.primary };
    config.models["gemini/image"] = { provider: "gemini", model: "gemini-3.1-flash-image", capabilities: { generate: true } };
    await writeJson(userConfigPath(userHome), config);
    const binding = await resolveImageConfigBinding({ projectRoot, userHome });
    assert.equal(binding.apiRuntimeConfig.models["gemini/image"].provider, "gemini");
    assert.equal(binding.activeProfile, "primary/gpt-image-2");
    config.providers.gemini.protocol = "unimplemented-protocol";
    await writeJson(userConfigPath(userHome), config);
    await assert.rejects(resolveImageConfigBinding({ projectRoot, userHome }), { code: "image_config_invalid" });
  });
});

test("default profile can be explicitly updated only in user configuration", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const config = userConfig();
    config.providers.grok = { ...config.providers.primary, base_url: "https://grok.example.test/v1" };
    config.models["grok/image"] = { provider: "grok", model: "grok-imagine-image-2.0" };
    await writeJson(userConfigPath(userHome), config);
    await writeJson(projectConfigPath(projectRoot), projectConfig());
    const updated = await updateImageConfig({ userHome, changes: { active_profile: "grok/image" } });
    assert.equal(updated.config.active_profile, "grok/image");
    assert.equal(updated.requiresRebind, true);
    await assert.rejects(updateImageConfig({ userHome, changes: { active_profile: "missing" } }));
    await assert.rejects(updateImageConfig({ projectRoot, scope: "project", changes: { active_profile: "grok/image" } }), { code: "image_config_update_forbidden" });
  });
});

test("v2 separates provider routing, per-profile defaults and host defaults", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const config = userConfig();
    config.config_version = 2;
    config.defaults = { timeout_seconds: 120, concurrency: 2 };
    config.host_defaults = { quality: "medium" };
    config.providers.primary.display_name = "GPT 接口";
    config.models["primary/gpt-image-2"] = {
      ...config.models["primary/gpt-image-2"], display_name: "GPT Image", aliases: ["GPT", "GPT图片"],
      defaults: { size: "1536x1024", quality: "max", output_format: "png" },
    };
    config.providers.gemini = { ...config.providers.primary, display_name: "Gemini 接口" };
    config.models["gemini/image"] = {
      provider: "gemini", model: "gemini-3.1-flash-image", aliases: ["香蕉"],
      defaults: { quality: "low" }, capabilities: { generate: true, edit: true },
    };
    await writeJson(userConfigPath(userHome), config);
    await writeJson(projectConfigPath(projectRoot), projectConfig({ defaults: { quality: "high" } }));
    const binding = await resolveImageConfigBinding({ projectRoot, userHome });
    assert.equal(binding.activeProfile, "primary/gpt-image-2");
    assert.equal(binding.apiRuntimeConfig.models["gemini/image"].defaults.quality, "high");
    assert.equal(binding.apiRuntimeConfig.models["gemini/image"].defaults.size, undefined);
    assert.equal(binding.localRuntimeConfig.defaults.quality, "high");
    assert.equal(binding.runtimeDefaults.concurrency, 2);
    assert.equal(binding.localRuntimeConfig.providers, undefined);
    assert.equal(binding.localRuntimeConfig.models, undefined);
    config.models["gemini/image"].aliases.push("ｇｐｔ");
    await writeJson(userConfigPath(userHome), config);
    await assert.rejects(resolveImageConfigBinding({ projectRoot, userHome }), { code: "image_config_invalid" });
  });
});

test("native providers and dimension intent remain separate in v2", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const config = userConfig();
    config.config_version = 2;
    config.defaults = {};
    config.providers.native = { protocol: "xai-images", base_url: "https://native.example.test/v1", api_key_env: "UNSET_NATIVE_KEY" };
    config.models["native/image"] = { provider: "native", model: "custom-native", aliases: [" 格洛克 "], defaults: { aspect_ratio: "1:1", resolution: "1K" }, limits: { max_input_images: 3 } };
    await writeJson(userConfigPath(userHome), config);
    await writeJson(projectConfigPath(projectRoot), projectConfig({ defaults: { size: "1024x1024" } }));
    const binding = await resolveImageConfigBinding({ projectRoot, userHome });
    assert.equal(binding.apiRuntimeConfig.providers.native.protocol, "xai-images");
    assert.deepEqual(binding.apiRuntimeConfig.models["native/image"].defaults, { size: "1024x1024" });
    config.models["native/image"].defaults.size = "1024x1024";
    await writeJson(userConfigPath(userHome), config);
    await assert.rejects(resolveImageConfigBinding({ projectRoot, userHome }), { code: "image_config_invalid" });
  });
});

test("v2 custom endpoints and future parameters preserve routing declarations", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const config = userConfig();
    config.config_version = 2;
    config.defaults = {};
    config.providers.primary.endpoints = { generate: "https://generate.example.test/render", edit: "https://edit.example.test/{model}" };
    config.models[config.active_profile].parameters = { seed: 42, vendor_option: { future: true } };
    config.models[config.active_profile].parameter_fields = { seed: { title: "随机种子", type: "integer", path: ["seed"], default: 7 } };
    config.models[config.active_profile].defaults = { quality: "future-tier" };
    await writeJson(userConfigPath(userHome), config);
    const binding = await resolveImageConfigBinding({ projectRoot, userHome });
    assert.deepEqual(binding.apiRuntimeConfig.providers.primary.endpoints, config.providers.primary.endpoints);
    assert.equal(binding.apiRuntimeConfig.models[config.active_profile].parameters.seed, 42);
    assert.equal(binding.apiRuntimeConfig.models[config.active_profile].parameter_fields.seed.default, 7);
    config.models[config.active_profile].parameters.model = "override";
    await writeJson(userConfigPath(userHome), config);
    await assert.rejects(resolveImageConfigBinding({ projectRoot, userHome }), { code: "image_config_invalid" });
  });
});

test("v2 inspection selects API profile transparency and keeps host policy separate", async () => {
  await withConfigRoots(async ({ userHome }) => {
    const config = userConfig();
    config.config_version = 2;
    config.defaults = {};
    config.transparency = { default_route: "emissive-alpha" };
    config.models[config.active_profile].transparency = {
      default_route: "native-alpha", native: { enabled: true, retry_without_parameter: false },
    };
    await writeJson(userConfigPath(userHome), config);
    let result = await inspectImageConfig({ userHome });
    assert.equal(result.transparencySummary.defaultRoute, "native-alpha");
    assert.equal(result.transparencySummary.retryWithoutParameter, false);
    assert.equal(result.warnings.length, 0);
    config.auth_mode = "chatgpt";
    await writeJson(userConfigPath(userHome), config);
    result = await inspectImageConfig({ userHome });
    assert.equal(result.transparencySummary.defaultRoute, "emissive-alpha");
    assert.equal(result.warnings.length, 0);
    config.auth_mode = "apikey";
    config.providers.primary.protocol = "xai-images";
    delete config.models[config.active_profile].transparency;
    await writeJson(userConfigPath(userHome), config);
    result = await inspectImageConfig({ userHome });
    assert.equal(result.transparencySummary.defaultRoute, "chroma-matting");
    assert.equal(result.warnings.length, 0);
    config.providers.primary.protocol = "openai-compatible";
    await writeJson(userConfigPath(userHome), config);
    result = await inspectImageConfig({ userHome });
    assert.ok(result.nextSteps.some((step) => step.includes(`models[${JSON.stringify(config.active_profile)}].transparency`)));
  });
});

test("inspection guides legacy transparency migration without rewriting the file", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const configPath = userConfigPath(userHome);
    await writeJson(configPath, userConfig());
    const before = await readFile(configPath, "utf8");
    const inspected = await inspectImageConfig({ projectRoot, userHome });

    assert.equal(inspected.transparencySummary.defaultRoute, "chroma-matting");
    assert.equal(inspected.transparencySummary.nativeEnabled, false);
    assert.match(inspected.warnings.join("\n"), /未声明 transparency\.native/);
    assert.match(inspected.nextSteps.join("\n"), /default_route 设置为 native-alpha/);
    assert.equal(await readFile(configPath, "utf8"), before);
  });
});

test("initialization keeps local config ignored inside its own project directory", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    await writeFile(path.join(projectRoot, ".gitignore"), "existing-rule\n", "utf8");
    await initializeImageConfig({ userHome, projectRoot });
    assert.equal(await readFile(path.join(projectRoot, ".gitignore"), "utf8"), "existing-rule\n");
    const localIgnore = path.join(projectRoot, ".codex", "openai-compatible-imagegen", ".gitignore");
    assert.equal(await readFile(localIgnore, "utf8"), "*\n");
    assert.equal(
      await readFile(path.join(path.dirname(userConfigPath(userHome)), ".gitignore"), "utf8"),
      "*\n",
    );
    await initializeImageConfig({ userHome, projectRoot }).catch((error) => assert.equal(error.code, "image_config_exists"));
    assert.equal(await readFile(localIgnore, "utf8"), "*\n");
  });
});

test("an explicit user api_key update is stored but never returned", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    await initializeImageConfig({ userHome, projectRoot });
    const updated = await updateImageConfig({
      userHome,
      scope: "user",
      changes: { providers: { primary: { api_key: "test-secret-value" } } },
    });
    assert.equal(JSON.stringify(updated).includes("test-secret-value"), false);
    const stored = JSON.parse(await readFile(userConfigPath(userHome), "utf8"));
    assert.equal(stored.providers.primary.api_key, "test-secret-value");
    const inspected = await inspectImageConfig({ userHome, projectRoot });
    assert.equal(JSON.stringify(inspected).includes("test-secret-value"), false);
    await writeJson(projectConfigPath(projectRoot), projectConfig());
    await assert.rejects(
      updateImageConfig({ projectRoot, scope: "project", changes: { api_key: "test-secret-value" } }),
      { code: "image_config_update_forbidden" },
    );
  });
});

test("configuration initialization never overwrites an existing file", async () => {
  await withConfigRoots(async ({ userHome }) => {
    const configPath = userConfigPath(userHome);
    await writeJson(configPath, { preserved: true });
    await assert.rejects(initializeImageConfig({ userHome }), { code: "image_config_exists" });
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { preserved: true });
    assert.equal(await readFile(path.join(path.dirname(configPath), ".gitignore"), "utf8"), "*\n");
  });
});

test("configuration updates backfill local ignore guards for both scopes", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const userPath = userConfigPath(userHome);
    const projectPath = projectConfigPath(projectRoot);
    await writeJson(userPath, userConfig());
    await writeJson(projectPath, projectConfig());

    await updateImageConfig({ userHome, scope: "user", changes: { defaults: { quality: "high" } } });
    await updateImageConfig({ projectRoot, scope: "project", changes: { defaults: { quality: "high" } } });

    assert.equal(await readFile(path.join(path.dirname(userPath), ".gitignore"), "utf8"), "*\n");
    assert.equal(await readFile(path.join(path.dirname(projectPath), ".gitignore"), "utf8"), "*\n");
  });
});

test("configuration writes reject an incompatible local ignore guard", async () => {
  await withConfigRoots(async ({ userHome }) => {
    const configPath = userConfigPath(userHome);
    const ignorePath = path.join(path.dirname(configPath), ".gitignore");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(ignorePath, "config.json\n", "utf8");

    await assert.rejects(initializeImageConfig({ userHome }), { code: "image_config_write_failed" });
    await assert.rejects(readFile(configPath), { code: "ENOENT" });

    await writeJson(configPath, userConfig());
    const before = await readFile(configPath, "utf8");
    await assert.rejects(
      updateImageConfig({ userHome, scope: "user", changes: { defaults: { quality: "high" } } }),
      { code: "image_config_write_failed" },
    );
    assert.equal(await readFile(configPath, "utf8"), before);
    assert.equal(await readFile(ignorePath, "utf8"), "config.json\n");
  });
});


test("final config paths use the unified technical slug", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    assert.match(userConfigPath(userHome), /\.codex[\\/]openai-compatible-imagegen[\\/]config\.json$/);
    assert.match(projectConfigPath(projectRoot), /\.codex[\\/]openai-compatible-imagegen[\\/]config\.json$/);
  });
});


test("missing user config fails without project fallback", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    await writeJson(projectConfigPath(projectRoot), projectConfig());
    await assert.rejects(
      resolveImageConfigBinding({ projectRoot, userHome }),
      (error) => {
        assert.equal(error.code, "image_config_missing");
        assert.match(error.message, /~\/.codex\/openai-compatible-imagegen\/config\.json/);
        assert.equal(error.message.includes(projectRoot), false);
        assert.equal(error.message.includes(userHome), false);
        return true;
      },
    );
  });
});


test("legacy V1 auth and development V2 paths are never considered", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    await writeJson(path.join(userHome, ".codex", "skills", "openai-compatible-imagegen", "auth.json"), { source: "v1" });
    await writeJson(path.join(userHome, ".codex", "openai-compatible-imagegen-v2", "config.json"), userConfig());

    await assert.rejects(resolveImageConfigBinding({ projectRoot, userHome }), { code: "image_config_missing" });
  });
});


test("valid user config binds with a default output root and frozen summaries", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const userPath = userConfigPath(userHome);
    await writeJson(userPath, userConfig());

    const binding = await resolveImageConfigBinding({ projectRoot, userHome });

    assert.equal(binding.userConfigPath, userPath);
    assert.equal(binding.projectConfigPath, projectConfigPath(projectRoot));
    assert.equal(binding.projectConfigSha256, null);
    assert.match(binding.userConfigSha256, /^[a-f0-9]{64}$/);
    assert.equal(binding.artifactRoot, path.join(projectRoot, "output", "imagegen"));
    assert.equal(binding.activeProfile, "primary/gpt-image-2");
    assert.deepEqual(binding.runtimeDefaults, { timeout_seconds: 600, concurrency: 3 });
    assert.match(binding.effectiveConfigSha256, /^[a-f0-9]{64}$/);
    const effective = JSON.parse(binding.effectiveConfigJson);
    assert.equal(effective.config_version, 1);
    assert.equal(effective.active_profile, "primary/gpt-image-2");
  });
});


test("project config applies only safe defaults and output directory", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    await writeJson(userConfigPath(userHome), userConfig({
      defaults: { size: "1024x1024", quality: "medium", output_format: "png" },
      storage: { output_directory: "user-output" },
    }));
    const projectPath = projectConfigPath(projectRoot);
    await writeJson(projectPath, projectConfig({
      defaults: { size: "1536x1024", quality: "high", output_format: "webp" },
      storage: { output_directory: "project-output" },
    }));

    const binding = await resolveImageConfigBinding({ projectRoot, userHome });
    const effective = JSON.parse(binding.effectiveConfigJson);

    assert.equal(binding.projectConfigPath, projectPath);
    assert.match(binding.projectConfigSha256, /^[a-f0-9]{64}$/);
    assert.equal(binding.artifactRoot, path.join(projectRoot, "project-output"));
    assert.deepEqual(effective.defaults, {
      size: "1536x1024",
      quality: "high",
      output_format: "webp",
    });
    assert.equal(effective.providers.primary.base_url, "https://example.test/v1");
    assert.equal(effective.active_profile, "primary/gpt-image-2");
  });
});


test("user config accepts an Atlas image provider", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    await writeJson(userConfigPath(userHome), mergeUserConfig({
      providers: {
        primary: {
          protocol: "atlas",
          base_url: "https://api.atlascloud.ai",
          api_key_env: "ATLASCLOUD_API_KEY",
        },
      },
      models: {
        "primary/gpt-image-2": {
          provider: "primary",
          model: "openai/gpt-image-2/text-to-image",
          capabilities: { generate: true, edit: false, mask: false, multi_reference: false },
        },
      },
    }));

    const binding = await resolveImageConfigBinding({ projectRoot, userHome });
    const effective = JSON.parse(binding.effectiveConfigJson);

    assert.equal(effective.providers.primary.protocol, "atlas");
    assert.equal(effective.providers.primary.base_url, "https://api.atlascloud.ai");
    assert.equal(effective.models["primary/gpt-image-2"].model, "openai/gpt-image-2/text-to-image");
  });
});


test("project violations fail before the user config is read", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const projectPath = projectConfigPath(projectRoot);
    const userPath = userConfigPath(userHome);
    const visited = [];

    await assert.rejects(
      resolveImageConfigBinding({
        projectRoot,
        userHome,
        readConfigFile: async (candidate, { required }) => {
          visited.push(candidate);
          if (candidate === projectPath) return Buffer.from(JSON.stringify({
            config_version: 1,
            active_profile: "other-profile",
          }));
          if (required && candidate === userPath) throw new Error("user config must not be read");
          return null;
        },
      }),
      { code: "project_config_forbidden" },
    );
    assert.deepEqual(visited, [projectPath]);
  });
});


test("project config rejects endpoint, authentication, model and resource overrides", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    await writeJson(userConfigPath(userHome), userConfig());
    const forbidden = [
      { active_profile: "other-profile" },
      { providers: {} },
      { models: {} },
      { endpoint: "https://evil.example.test/v1" },
      { api_key: "secret" },
      { api_key_env: "EVIL_KEY" },
      { proxy: { url: "http://127.0.0.1:7890" } },
      { defaults: { concurrency: 8 } },
      { defaults: { timeout_seconds: 1 } },
      { storage: { other: "value" } },
      { unknown: true },
    ];

    for (const override of forbidden) {
      await writeJson(projectConfigPath(projectRoot), { config_version: 1, ...override });
      await assert.rejects(
        resolveImageConfigBinding({ projectRoot, userHome }),
        { code: "project_config_forbidden" },
      );
    }
  });
});


test("user config validates schema, active profile and resource bounds", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const cases = [
      { config_version: 2 },
      { active_profile: "other-profile" },
      { providers: [] },
      { models: [] },
      { defaults: { timeout_seconds: 0 } },
      { defaults: { timeout_seconds: 601 } },
      { defaults: { concurrency: 0 } },
      { defaults: { concurrency: 9 } },
      { models: { "primary/gpt-image-2": { provider: "primary", model: "gpt-image-2", capabilities: { transparent_background: true } } } },
      { transparency: { default_route: "unknown-route" } },
      { transparency: { prompt_only_allow: [{ model: "gpt-image-2", mode: "bad", size: "1024x1024" }] } },
      { transparency: { prompt_only_allow: [{ model: "", mode: "generate", size: "1024x1024" }] } },
      { transparency: { prompt_only_allow: [{ model: "gpt-image-2", mode: "generate", size: "bad" }] } },
      { transparency: { llm_assisted: { enabled: "yes" } } },
      { transparency: { llm_assisted: { max_attempts: 0 } } },
      { transparency: { llm_assisted: { max_attempts: 4 } } },
      { transparency: { llm_assisted: { allow_parameter_tuning: "yes" } } },
      { transparency: { llm_assisted: { allow_route_change: 1 } } },
      { transparency: { llm_assisted: { allow_api_retry: null } } },
      { providers: { primary: { api_key_env: "BAD-NAME" } } },
      { providers: { primary: { api_key_env: "BAD NAME" } } },
      { providers: { primary: { api_key_env: "BAD\u0000NAME" } } },
      { providers: { primary: { proxy: [] } } },
      { providers: { primary: { proxy: {} } } },
      { providers: { primary: { proxy: { url: "socks5://127.0.0.1:7890" } } } },
      { providers: { primary: { proxy: { url: "http:///missing-host" } } } },
      { providers: { primary: { proxy: { url: "http://127.0.0.1:70000" } } } },
      { providers: { primary: { proxy: { url: "http://user:password@127.0.0.1:7890" } } } },
      { providers: { primary: { proxy: { url: "http://127.0.0.1:7890?mode=test" } } } },
      { providers: { primary: { proxy: { url: "http://127.0.0.1:7890#fragment" } } } },
      { providers: { primary: { proxy: { url: "http://127.0.0.1:7890\n" } } } },
    ];
    for (const override of cases) {
      await writeJson(userConfigPath(userHome), mergeUserConfig(override));
      await assert.rejects(
        resolveImageConfigBinding({ projectRoot, userHome }),
        { code: "image_config_invalid" },
        JSON.stringify(override),
      );
    }
  });
});


test("output root rejects escapes, root, absolute paths, files and reparse points", async () => {
  await withConfigRoots(async ({ root, projectRoot, userHome }) => {
    const fileTarget = path.join(projectRoot, "output-file");
    const externalRoot = path.join(root, "external");
    const linkedRoot = path.join(projectRoot, "linked-output");
    await Promise.all([writeFile(fileTarget, "not a directory"), mkdir(externalRoot)]);
    await symlink(externalRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    const cases = ["..", ".", fileTarget, linkedRoot, path.join(projectRoot, "absolute-inside")];

    for (const outputDirectory of cases) {
      await writeJson(userConfigPath(userHome), userConfig({ storage: { output_directory: outputDirectory } }));
      await assert.rejects(resolveImageConfigBinding({ projectRoot, userHome }), { code: "output_directory_invalid" });
    }
  });
});


test("binding detects user and project changes before a runtime call", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const userPath = userConfigPath(userHome);
    const projectPath = projectConfigPath(projectRoot);
    await writeJson(userPath, userConfig());
    await writeJson(projectPath, projectConfig({ storage: { output_directory: "project-output" } }));
    const binding = await resolveImageConfigBinding({ projectRoot, userHome });

    await writeJson(projectPath, projectConfig({ storage: { output_directory: "changed-output" } }));
    await assert.rejects(assertImageConfigBindingCurrent({ projectRoot, ...binding }), { code: "image_config_changed" });

    await writeJson(projectPath, projectConfig({ storage: { output_directory: "project-output" } }));
    await writeJson(userPath, userConfig({ defaults: { quality: "high" } }));
    await assert.rejects(assertImageConfigBindingCurrent({ projectRoot, ...binding }), { code: "image_config_changed" });
  });
});

test("binding preserves custom proxy and detects proxy changes", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const userPath = userConfigPath(userHome);
    await writeJson(userPath, userConfig({
      providers: { primary: { proxy: { url: "http://127.0.0.1:7890" } } },
    }));
    const binding = await resolveImageConfigBinding({ projectRoot, userHome });
    const effective = JSON.parse(binding.effectiveConfigJson);

    assert.deepEqual(effective.providers.primary.proxy, { url: "http://127.0.0.1:7890" });

    await writeJson(userPath, userConfig({
      providers: { primary: { proxy: { url: "http://127.0.0.1:7891" } } },
    }));
    await assert.rejects(
      assertImageConfigBindingCurrent({ projectRoot, ...binding }),
      { code: "image_config_changed" },
    );
  });
});


test("one UTF-8 BOM is accepted and invalid UTF-8 is rejected", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const configPath = userConfigPath(userHome);
    const encoded = Buffer.from(JSON.stringify(userConfig()), "utf8");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded]));
    assert.equal((await resolveImageConfigBinding({ projectRoot, userHome })).activeProfile, "primary/gpt-image-2");

    await writeFile(configPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), encoded]));
    await assert.rejects(resolveImageConfigBinding({ projectRoot, userHome }), { code: "image_config_invalid" });

    await writeFile(configPath, Buffer.concat([encoded.subarray(0, 1), Buffer.from([0xff]), encoded.subarray(1)]));
    await assert.rejects(resolveImageConfigBinding({ projectRoot, userHome }), { code: "image_config_invalid" });
  });
});


async function withConfigRoots(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-config-"));
  const projectRoot = path.join(root, "project");
  const userHome = path.join(root, "home");
  await Promise.all([mkdir(projectRoot), mkdir(userHome)]);
  try {
    await callback({ root, projectRoot, userHome });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}


function userConfig(overrides = {}) {
  return mergeUserConfig(overrides);
}


function chatgptOnlyConfig(overrides = {}) {
  return deepMerge({
    config_version: 1,
    auth_mode: "chatgpt",
    defaults: { size: "1024x1024", quality: "medium", output_format: "png" },
    postprocess: { enabled: true },
    transparency: { default_route: "chroma-matting", prompt_only_allow: [], llm_assisted: { enabled: false } },
    storage: { output_directory: "output/imagegen" },
  }, overrides);
}


function mergeUserConfig(overrides = {}) {
  const base = {
    config_version: 1,
    active_profile: "primary/gpt-image-2",
    providers: {
      primary: {
        protocol: "openai-compatible",
        base_url: "https://example.test/v1",
        api_key_env: "IMAGE_API_KEY",
        user_agent: "Imagegen-Test/1.0",
        url_download: { proxy_mode: "environment" },
      },
    },
    models: {
      "primary/gpt-image-2": {
        provider: "primary",
        model: "gpt-image-2",
        capabilities: { generate: true, edit: true, mask: true, multi_reference: true },
      },
    },
    defaults: { size: "1024x1024", quality: "medium", output_format: "png" },
    postprocess: { enabled: true },
    transparency: { default_route: "chroma-matting", prompt_only_allow: [], llm_assisted: { enabled: false } },
    storage: { output_directory: "output/imagegen" },
  };
  return deepMerge(base, overrides);
}


function projectConfig({ defaults, storage } = {}) {
  return {
    config_version: 1,
    ...(defaults ? { defaults } : {}),
    ...(storage ? { storage } : {}),
  };
}


function deepMerge(base, overrides) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object") {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}


async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value), "utf8");
}
