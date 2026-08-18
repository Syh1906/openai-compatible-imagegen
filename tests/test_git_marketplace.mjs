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

test("public plugin metadata uses English defaults", async () => {
  const manifest = JSON.parse(await readFile(
    path.join(projectRoot, ".codex-plugin/plugin.json"),
    "utf8",
  ));
  for (const [field, value] of [
    ["description", manifest.description],
    ["interface.longDescription", manifest.interface?.longDescription],
    ["interface.defaultPrompt", manifest.interface?.defaultPrompt?.join("\n")],
  ]) {
    assert.equal(typeof value, "string", field);
    assert.doesNotMatch(value, /\p{Script=Han}/u, field);
  }
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

test("English and Chinese README files keep commands and public links synchronized", async () => {
  const [readme, readmeZh] = await Promise.all([
    readFile(path.join(projectRoot, "README.md"), "utf8"),
    readFile(path.join(projectRoot, "README.zh-CN.md"), "utf8"),
  ]);

  assert.deepEqual(fencedBodies(readme), fencedBodies(readmeZh));
  assert.deepEqual(publicRelativeLinks(readme), publicRelativeLinks(readmeZh));
  assert.match(readme, /\[documentation index\]\(docs\/README\.md\)/i);
  assert.match(readmeZh, /\[文档导航\]\(docs\/README\.zh-CN\.md\)/);
  assert.doesNotMatch(readme, /^## For AI agents$/m);
  assert.doesNotMatch(readmeZh, /^## 给 Agent 的入口$/m);
});

test("public installation docs use the latest Skills CLI without pinning a package version", async () => {
  const projectCommand = "npx --yes skills@latest add /path/to/openai-compatible-imagegen --agent codex --skill openai-compatible-imagegen --copy --yes";
  const globalCommand = "npx --yes skills@latest add /path/to/openai-compatible-imagegen --global --agent codex --skill openai-compatible-imagegen --copy --yes";

  for (const documentPath of [
    "README.md",
    "README.zh-CN.md",
    "docs/guides/installation.md",
    "docs/guides/installation.zh-CN.md",
  ]) {
    const document = await readFile(path.join(projectRoot, documentPath), "utf8");
    assert.match(document, new RegExp(escapeRegExp(projectCommand)), documentPath);
    assert.match(document, new RegExp(escapeRegExp(globalCommand)), documentPath);
    assert.doesNotMatch(document, /npx --yes skills@\d/, documentPath);
  }
});

test("public docs keep localized pairs and English runtime skills", async () => {
  const pairs = [
    ["docs/README.md", "docs/README.zh-CN.md"],
    ["docs/arch.md", "docs/arch.zh-CN.md"],
    ["docs/guides/README.md", "docs/guides/README.zh-CN.md"],
    ["docs/guides/installation.md", "docs/guides/installation.zh-CN.md"],
    ["docs/guides/configuration.md", "docs/guides/configuration.zh-CN.md"],
    ["docs/guides/migration.md", "docs/guides/migration.zh-CN.md"],
    ["docs/guides/rollback.md", "docs/guides/rollback.zh-CN.md"],
    ["docs/guides/troubleshooting.md", "docs/guides/troubleshooting.zh-CN.md"],
  ];

  for (const [englishPath, chinesePath] of pairs) {
    const [english, chinese] = await Promise.all([
      readFile(path.join(projectRoot, englishPath), "utf8"),
      readFile(path.join(projectRoot, chinesePath), "utf8"),
    ]);
    assert.equal(headingLevels(english), headingLevels(chinese), englishPath);
    assert.deepEqual(tableShapes(english), tableShapes(chinese), englishPath);
    assert.deepEqual(fenceLanguages(english), fenceLanguages(chinese), englishPath);
    assert.deepEqual(cliCommands(english), cliCommands(chinese), englishPath);
    assert.match(english, /\.zh-CN\.md\)/, englishPath);
    assert.match(chinese, /\[English\]\([^)]*\.md\)/, chinesePath);
  }

  const [architecture, architectureZh] = await Promise.all([
    readFile(path.join(projectRoot, "docs/arch.md"), "utf8"),
    readFile(path.join(projectRoot, "docs/arch.zh-CN.md"), "utf8"),
  ]);
  for (const [englishHeading, chineseHeading] of [
    ["Sources of truth", "真相源"],
    ["Core flow", "核心流程"],
    ["Distribution ownership", "发行职责"],
    ["Dependency direction", "依赖方向"],
    ["Configuration boundaries", "配置边界"],
    ["Artifact and state model", "产物与状态模型"],
    ["Release model", "发布模型"],
    ["Change matrix", "变更矩阵"],
  ]) {
    assert.match(architecture, new RegExp(`^## ${englishHeading}$`, "m"));
    assert.match(architectureZh, new RegExp(`^## ${chineseHeading}$`, "m"));
  }

  for (const skillPath of [
    "SKILL.md",
    "skills/openai-compatible-imagegen/SKILL.md",
  ]) {
    const skill = await readFile(path.join(projectRoot, skillPath), "utf8");
    assert.doesNotMatch(skill, /\p{Script=Han}/u, skillPath);
  }
});

function fencedBodies(markdown) {
  return [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
    .map((match) => match[1].trim().replaceAll(".zh-CN.md", ".md"))
    .sort();
}

function publicRelativeLinks(markdown) {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(?:https?:|#)/.test(target))
    .filter((target) => !/^README(?:\.zh-CN)?\.md$/.test(target))
    .map((target) => target.replace(/\.zh-CN\.md(?=#|$)/, ".md").split("#")[0])
    .sort();
}

function headingLevels(markdown) {
  return [...markdown.matchAll(/^(#{1,6}) /gm)]
    .map((match) => match[1].length)
    .join(",");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tableShapes(markdown) {
  return [...markdown.matchAll(/(?:^\|.*\|\r?\n?)+/gm)]
    .map((match) => match[0].trim().split(/\r?\n/).length);
}

function fenceLanguages(markdown) {
  return [...markdown.matchAll(/^```([^\r\n]*)/gm)]
    .map((match) => match[1].trim());
}

function cliCommands(markdown) {
  const commands = [];
  const commandPattern = /^(?:\(Get-FileHash|codex|npx|python|sha256sum)\b/;
  for (const match of markdown.matchAll(/```[^\r\n]*\r?\n([\s\S]*?)```/g)) {
    for (const line of match[1].split(/\r?\n/)) {
      const command = line.trim();
      if (commandPattern.test(command)) commands.push(command);
    }
  }
  const prose = markdown.replace(/```[\s\S]*?```/g, "");
  for (const match of prose.matchAll(/`([^`\r\n]+)`/g)) {
    const command = match[1].trim();
    if (commandPattern.test(command)) commands.push(command);
  }
  return commands.sort();
}
