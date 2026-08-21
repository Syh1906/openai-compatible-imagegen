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
