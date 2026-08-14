import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  projectConfigPath,
  resolveV2ConfigPath,
  resolveV2StorageBinding,
  userConfigPath,
} from "../mcp/config-resolution.mjs";


test("user V2 config overrides the project config", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const projectConfig = projectConfigPath(projectRoot);
    const userConfig = userConfigPath(userHome);
    await writeJson(projectConfig, { source: "project" });
    await writeJson(userConfig, { source: "user" });

    assert.equal(await resolveV2ConfigPath({ projectRoot, userHome }), userConfig);
  });
});

test("project V2 config is used when user config is absent", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const projectConfig = projectConfigPath(projectRoot);
    await writeJson(projectConfig, { source: "project" });

    assert.equal(await resolveV2ConfigPath({ projectRoot, userHome }), projectConfig);
  });
});

test("unreadable user V2 config reports a safe stable error without project fallback", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const userConfig = userConfigPath(userHome);
    const projectConfig = projectConfigPath(projectRoot);
    await writeJson(userConfig, v2Config());
    await writeJson(projectConfig, v2Config());

    for (const errno of ["EACCES", "EPERM"]) {
      const visited = [];
      await assert.rejects(
        resolveV2ConfigPath({
          projectRoot,
          userHome,
          accessFile: async (candidate) => {
            visited.push(candidate);
            if (candidate === userConfig) throw Object.assign(new Error("permission denied"), { code: errno });
          },
        }),
        (error) => {
          assert.equal(error.code, "v2_config_invalid");
          assert.equal(error.message.includes(userConfig), false);
          assert.equal(error.message.includes(projectConfig), false);
          assert.equal(error.message.includes(userHome), false);
          assert.equal(error.message.includes(projectRoot), false);
          return true;
        },
      );
      assert.deepEqual(visited, [userConfig]);
    }
  });
});

test("missing V2 config reports safe setup locations", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    await assert.rejects(
      resolveV2ConfigPath({ projectRoot, userHome }),
      (error) => {
        assert.equal(error.code, "v2_config_missing");
        assert.match(error.message, /~\/.codex\/openai-compatible-imagegen-v2\/config\.json/);
        assert.match(error.message, /<项目根>\/\.codex\/openai-compatible-imagegen-v2\/config\.json/);
        assert.equal(error.message.includes(projectRoot), false);
        assert.equal(error.message.includes(userHome), false);
        return true;
      },
    );
  });
});

test("V1 auth locations are never considered", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    await writeJson(path.join(userHome, ".codex", "skills", "openai-compatible-imagegen", "auth.json"), { source: "v1" });

    await assert.rejects(resolveV2ConfigPath({ projectRoot, userHome }), { code: "v2_config_missing" });
  });
});


test("storage binding resolves the default output root from the selected config", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const configPath = projectConfigPath(projectRoot);
    await writeJson(configPath, v2Config());

    const binding = await resolveV2StorageBinding({ projectRoot, userHome });

    assert.equal(binding.configPath, configPath);
    assert.equal(binding.artifactRoot, path.join(projectRoot, "output", "imagegen"));
    assert.match(binding.configSha256, /^[a-f0-9]{64}$/);
  });
});


test("user storage config wins as a whole and relative output is project based", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const projectConfig = projectConfigPath(projectRoot);
    const userConfig = userConfigPath(userHome);
    await writeJson(projectConfig, v2Config({ outputDirectory: "project-output" }));
    await writeJson(userConfig, v2Config({ outputDirectory: "user-output" }));

    const binding = await resolveV2StorageBinding({ projectRoot, userHome });

    assert.equal(binding.configPath, userConfig);
    assert.equal(binding.artifactRoot, path.join(projectRoot, "user-output"));
  });
});


test("invalid user storage config fails without falling back to the project config", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    await writeJson(projectConfigPath(projectRoot), v2Config({ outputDirectory: "project-output" }));
    await writeJson(userConfigPath(userHome), {
      ...v2Config(),
      storage: { output_directory: "" },
    });

    await assert.rejects(
      resolveV2StorageBinding({ projectRoot, userHome }),
      { code: "output_directory_invalid" },
    );
  });
});


test("storage binding rejects incomplete or unsupported V2 provider and model configuration", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const cases = [
      { api_key_env: "IMAGE_API_KEY", base_url: "https://example.test/v1" },
      { providers: [], models: v2Config().models },
      { providers: v2Config().providers, models: [] },
      { providers: v2Config().providers, models: {} },
      {
        providers: v2Config().providers,
        models: { "primary/gpt-image-2": { provider: "missing", model: "gpt-image-2" } },
      },
      {
        providers: { primary: { protocol: "other", base_url: "https://example.test/v1" } },
        models: v2Config().models,
      },
      {
        providers: { primary: { protocol: "openai-compatible", base_url: "" } },
        models: v2Config().models,
      },
      {
        providers: v2Config().providers,
        models: { "primary/gpt-image-2": { provider: "primary", model: "other-image-model" } },
      },
    ];

    for (const config of cases) {
      await writeJson(projectConfigPath(projectRoot), config);
      await assert.rejects(
        resolveV2StorageBinding({ projectRoot, userHome }),
        (error) => {
          assert.equal(error.code, "v2_config_invalid");
          assert.equal(error.message.includes(projectRoot), false);
          assert.equal(error.message.includes(userHome), false);
          return true;
        },
      );
    }
  });
});


test("storage binding rejects provider fields that the Python V2 runtime would reject", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const cases = [
      { base_url: "/" },
      { base_url: "\u0085" },
      { base_url: "ftp://example.test/v1" },
      { base_url: "https:///v1" },
      { base_url: "https://" },
      { url_download: [] },
      { url_download: { proxy_mode: "automatic" } },
      { url_download: { proxy_mode: null } },
      { user_agent: "invalid\r\nheader" },
      { user_agent: "\ufeff\r\nheader" },
    ];

    for (const providerOverrides of cases) {
      const config = v2Config();
      Object.assign(config.providers.primary, providerOverrides);
      await writeJson(projectConfigPath(projectRoot), config);

      await assert.rejects(
        resolveV2StorageBinding({ projectRoot, userHome }),
        (error) => {
          assert.equal(error.code, "v2_config_invalid");
          assert.equal(error.message.includes(projectRoot), false);
          assert.equal(error.message.includes(userHome), false);
          return true;
        },
      );
    }
  });
});


test("storage binding accepts one leading UTF-8 BOM and rejects invalid UTF-8", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const configPath = projectConfigPath(projectRoot);
    await mkdir(path.dirname(configPath), { recursive: true });
    const encoded = Buffer.from(JSON.stringify(v2Config()), "utf8");
    await writeFile(configPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded]));

    assert.equal(
      (await resolveV2StorageBinding({ projectRoot, userHome })).artifactRoot,
      path.join(projectRoot, "output", "imagegen"),
    );

    await writeFile(configPath, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]),
      encoded,
    ]));
    await assert.rejects(
      resolveV2StorageBinding({ projectRoot, userHome }),
      { code: "v2_config_invalid" },
    );

    await writeFile(configPath, Buffer.concat([encoded.subarray(0, 1), Buffer.from([0xff]), encoded.subarray(1)]));
    await assert.rejects(
      resolveV2StorageBinding({ projectRoot, userHome }),
      { code: "v2_config_invalid" },
    );
  });
});


test("storage binding requires an explicit model provider", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const config = v2Config();
    delete config.models["primary/gpt-image-2"].provider;
    await writeJson(projectConfigPath(projectRoot), config);

    await assert.rejects(
      resolveV2StorageBinding({ projectRoot, userHome }),
      { code: "v2_config_invalid" },
    );
  });
});


test("storage binding normalizes the model provider id before looking it up", async () => {
  await withConfigRoots(async ({ projectRoot, userHome }) => {
    const config = v2Config();
    config.providers = { " primary ": config.providers.primary };
    config.models["primary/gpt-image-2"].provider = " primary ";
    await writeJson(projectConfigPath(projectRoot), config);

    await assert.rejects(
      resolveV2StorageBinding({ projectRoot, userHome }),
      (error) => {
        assert.equal(error.code, "v2_config_invalid");
        assert.equal(error.message.includes(projectRoot), false);
        assert.equal(error.message.includes(userHome), false);
        return true;
      },
    );
  });
});


test("storage output rejects project escape, project root, files, and linked segments", async () => {
  await withConfigRoots(async ({ root, projectRoot, userHome }) => {
    const fileTarget = path.join(projectRoot, "output-file");
    const externalRoot = path.join(root, "external");
    const linkedRoot = path.join(projectRoot, "linked-output");
    await Promise.all([writeFile(fileTarget, "not a directory"), mkdir(externalRoot)]);
    await symlink(externalRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    const cases = ["..", ".", fileTarget, linkedRoot];

    for (const outputDirectory of cases) {
      await writeJson(projectConfigPath(projectRoot), v2Config({ outputDirectory }));
      await assert.rejects(
        resolveV2StorageBinding({ projectRoot, userHome }),
        { code: "output_directory_invalid" },
      );
    }
  });
});


test("storage output accepts an absolute directory only when it stays inside the project", async () => {
  await withConfigRoots(async ({ root, projectRoot, userHome }) => {
    const internalRoot = path.join(projectRoot, "custom", "imagegen");
    await writeJson(projectConfigPath(projectRoot), v2Config({ outputDirectory: internalRoot }));
    assert.equal(
      (await resolveV2StorageBinding({ projectRoot, userHome })).artifactRoot,
      internalRoot,
    );

    await writeJson(projectConfigPath(projectRoot), v2Config({ outputDirectory: path.join(root, "outside") }));
    await assert.rejects(
      resolveV2StorageBinding({ projectRoot, userHome }),
      { code: "output_directory_invalid" },
    );
  });
});

async function withConfigRoots(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-v2-config-"));
  const projectRoot = path.join(root, "project");
  const userHome = path.join(root, "home");
  await Promise.all([mkdir(projectRoot), mkdir(userHome)]);
  try {
    await callback({ root, projectRoot, userHome });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function v2Config({ outputDirectory } = {}) {
  const config = {
    providers: {
      primary: {
        protocol: "openai-compatible",
        base_url: "https://example.test/v1",
        api_key_env: "IMAGE_API_KEY",
      },
    },
    models: {
      "primary/gpt-image-2": {
        provider: "primary",
        model: "gpt-image-2",
        capabilities: { generate: true, edit: true, mask: true },
      },
    },
  };
  if (outputDirectory !== undefined) {
    config.storage = { output_directory: outputDirectory };
  }
  return config;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value), "utf8");
}
