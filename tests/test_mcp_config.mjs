import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  projectConfigPath,
  resolveV2ConfigPath,
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

async function withConfigRoots(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-v2-config-"));
  const projectRoot = path.join(root, "project");
  const userHome = path.join(root, "home");
  await Promise.all([mkdir(projectRoot), mkdir(userHome)]);
  try {
    await callback({ projectRoot, userHome });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value), "utf8");
}
