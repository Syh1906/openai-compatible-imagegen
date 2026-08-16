import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { pluginReleaseFiles } from "../scripts/plugin-file-set.mjs";


const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginId = "openai-compatible-imagegen";


test("the repository is a Git-backed marketplace with a runnable root plugin", async () => {
  assert.ok(pluginReleaseFiles.includes("assets/icon.png"));

  const marketplace = JSON.parse(await readFile(
    path.join(projectRoot, ".agents/plugins/marketplace.json"),
    "utf8",
  ));

  assert.equal(marketplace.name, pluginId);
  assert.equal(marketplace.interface?.displayName, "OpenAI-Compatible Images");
  assert.equal(marketplace.plugins?.length, 1);
  assert.deepEqual(marketplace.plugins[0], {
    name: pluginId,
    source: {
      source: "local",
      path: "./",
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  });

  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--", ...pluginReleaseFiles],
    { cwd: projectRoot, encoding: "utf8" },
  );
  assert.deepEqual(
    stdout.trim().split(/\r?\n/).filter(Boolean).sort(),
    [...pluginReleaseFiles].sort(),
  );
});


test("public install and rollback guides use the documented plugin lifecycle commands", async () => {
  const [readme, readmeZh, installation, rollback, troubleshooting] = await Promise.all([
    readFile(path.join(projectRoot, "README.md"), "utf8"),
    readFile(path.join(projectRoot, "README.zh-CN.md"), "utf8"),
    readFile(path.join(projectRoot, "docs/guides/installation.md"), "utf8"),
    readFile(path.join(projectRoot, "docs/guides/rollback.md"), "utf8"),
    readFile(path.join(projectRoot, "docs/guides/troubleshooting.md"), "utf8"),
  ]);

  assert.match(readme, /\[简体中文\]\(README\.zh-CN\.md\)/);
  assert.match(readmeZh, /\[English\]\(README\.md\)/);

  for (const document of [readme, readmeZh, installation]) {
    assert.match(document, /codex plugin marketplace add Syh1906\/openai-compatible-imagegen/);
    assert.match(document, /codex plugin add openai-compatible-imagegen@openai-compatible-imagegen/);
  }
  for (const command of [
    "codex plugin list --json",
    "codex plugin remove openai-compatible-imagegen@openai-compatible-imagegen --json",
    "codex plugin marketplace upgrade openai-compatible-imagegen --json",
    "codex plugin marketplace remove openai-compatible-imagegen --json",
  ]) {
    assert.ok(`${rollback}\n${troubleshooting}`.includes(command), command);
  }
});
