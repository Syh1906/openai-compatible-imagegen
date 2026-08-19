import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { pluginReleaseFiles } from "../../scripts/plugin-file-set.mjs";


const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
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

test("CI gives push and pull request checks distinct names", async () => {
  const workflow = await readFile(path.join(projectRoot, ".github/workflows/ci.yml"), "utf8");

  assert.match(workflow, /^\s+name: test \(\$\{\{ matrix\.os \}\}, \$\{\{ github\.event_name \}\}\)$/m);
});


test("public install, update, and rollback guides use the documented plugin lifecycle commands", async () => {
  const [
    readme,
    readmeZh,
    installation,
    installationZh,
    updating,
    updatingZh,
    rollback,
    rollbackZh,
    troubleshooting,
    troubleshootingZh,
  ] = await Promise.all([
    readFile(path.join(projectRoot, "README.md"), "utf8"),
    readFile(path.join(projectRoot, "README.zh-CN.md"), "utf8"),
    readFile(path.join(projectRoot, "docs/guides/installation.md"), "utf8"),
    readFile(path.join(projectRoot, "docs/guides/installation.zh-CN.md"), "utf8"),
    readFile(path.join(projectRoot, "docs/guides/updating.md"), "utf8"),
    readFile(path.join(projectRoot, "docs/guides/updating.zh-CN.md"), "utf8"),
    readFile(path.join(projectRoot, "docs/guides/rollback.md"), "utf8"),
    readFile(path.join(projectRoot, "docs/guides/rollback.zh-CN.md"), "utf8"),
    readFile(path.join(projectRoot, "docs/guides/troubleshooting.md"), "utf8"),
    readFile(path.join(projectRoot, "docs/guides/troubleshooting.zh-CN.md"), "utf8"),
  ]);

  assert.match(readme, /\[简体中文\]\(README\.zh-CN\.md\)/);
  assert.match(readmeZh, /\[English\]\(README\.md\)/);

  for (const document of [readme, readmeZh, installation, installationZh]) {
    assert.match(document, /codex plugin marketplace add Syh1906\/openai-compatible-imagegen/);
    assert.match(document, /codex plugin add openai-compatible-imagegen@openai-compatible-imagegen/);
  }

  for (const [document, marketplaceHeading, zipHeading, restartPattern] of [
    [updating, "Update a Git marketplace Plugin", "Update from a Plugin ZIP", /completely quit and restart Codex/i],
    [updatingZh, "更新 Git marketplace Plugin", "从 Plugin ZIP 更新", /完全退出并重新启动 Codex/],
  ]) {
    const marketplaceSection = markdownSection(document, marketplaceHeading);
    const zipSection = markdownSection(document, zipHeading);

    for (const command of [
      "codex plugin marketplace upgrade openai-compatible-imagegen --json",
      "codex plugin list --json",
    ]) {
      assert.ok(marketplaceSection.includes(command), `${command}: ${marketplaceHeading}`);
    }
    for (const command of [
      "codex plugin remove openai-compatible-imagegen@openai-compatible-imagegen --json",
      "codex plugin add openai-compatible-imagegen@openai-compatible-imagegen --json",
    ]) {
      assert.ok(zipSection.includes(command), `${command}: ${zipHeading}`);
    }
    assert.doesNotMatch(marketplaceSection, /codex plugin (?:remove|add) /);
    assert.doesNotMatch(marketplaceSection, /npm install/);
    assert.match(marketplaceSection, restartPattern);

    for (const platformCommand of [
      '(Get-FileHash -Algorithm SHA256 -LiteralPath "openai-compatible-imagegen-codex-plugin-<version>.zip").Hash.ToLowerInvariant()',
      'shasum -a 256 openai-compatible-imagegen-codex-plugin-<version>.zip',
      'sha256sum openai-compatible-imagegen-codex-plugin-<version>.zip',
      'codex plugin marketplace add "C:/path/to/openai-compatible-imagegen" --json',
      'codex plugin marketplace add "/absolute/path/to/openai-compatible-imagegen" --json',
      'python "C:/path/to/openai-compatible-imagegen/scripts/imagegen.py" info',
      'python3 "/absolute/path/to/openai-compatible-imagegen/scripts/imagegen.py" info',
    ]) {
      assert.ok(document.includes(platformCommand), `${platformCommand}: updating guide`);
    }
    assert.match(document, /skills update/);
    assert.match(document, /auth\.json/);
  }

  assert.match(readme, /marketplace is already registered[\s\S]*skip/i);
  assert.match(readme, /completely quit and restart Codex/i);
  assert.match(installation, /marketplace is already registered[\s\S]*skip/i);
  assert.match(installation, /completely quit and restart Codex/i);
  assert.match(readmeZh, /marketplace 已注册[\s\S]*跳过/);
  assert.match(readmeZh, /完全退出并重新启动 Codex/);
  assert.match(installationZh, /marketplace 已注册[\s\S]*跳过/);
  assert.match(installationZh, /完全退出并重新启动 Codex/);

  for (const documents of [
    `${rollback}\n${troubleshooting}`,
    `${rollbackZh}\n${troubleshootingZh}`,
  ]) {
    for (const command of [
      "codex plugin list --json",
      "codex plugin remove openai-compatible-imagegen@openai-compatible-imagegen --json",
      "codex plugin marketplace upgrade openai-compatible-imagegen --json",
      "codex plugin marketplace remove openai-compatible-imagegen --json",
    ]) {
      assert.ok(documents.includes(command), command);
    }
  }
});

test("public navigation exposes the update guide from package entry points", async () => {
  const documents = await Promise.all([
    "README.md",
    "README.zh-CN.md",
    "docs/README.md",
    "docs/README.zh-CN.md",
    "docs/guides/README.md",
    "docs/guides/README.zh-CN.md",
    "docs/guides/installation.md",
    "docs/guides/installation.zh-CN.md",
    "docs/guides/rollback.md",
    "docs/guides/rollback.zh-CN.md",
  ].map(async (relativePath) => [
    relativePath,
    await readFile(path.join(projectRoot, relativePath), "utf8"),
  ]));

  for (const [relativePath, document] of documents) {
    assert.match(document, /updating(?:\.zh-CN)?\.md/, relativePath);
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
  const windowsProjectCommand = 'npx --yes skills@latest add "C:/path/to/openai-compatible-imagegen" --agent codex --skill openai-compatible-imagegen --copy --yes';
  const windowsGlobalCommand = 'npx --yes skills@latest add "C:/path/to/openai-compatible-imagegen" --global --agent codex --skill openai-compatible-imagegen --copy --yes';

  for (const documentPath of [
    "README.md",
    "README.zh-CN.md",
    "docs/guides/installation.md",
    "docs/guides/installation.zh-CN.md",
  ]) {
    const document = await readFile(path.join(projectRoot, documentPath), "utf8");
    assert.match(document, new RegExp(escapeRegExp(projectCommand)), documentPath);
    assert.match(document, new RegExp(escapeRegExp(globalCommand)), documentPath);
    assert.match(document, new RegExp(escapeRegExp(windowsProjectCommand)), documentPath);
    assert.match(document, new RegExp(escapeRegExp(windowsGlobalCommand)), documentPath);
    assert.doesNotMatch(document, /npx --yes skills@\d/, documentPath);
  }
});

test("public command guides cover Windows, macOS, and Linux shell variants", async () => {
  const documents = await Promise.all([
    "docs/guides/installation.md",
    "docs/guides/installation.zh-CN.md",
    "docs/guides/updating.md",
    "docs/guides/updating.zh-CN.md",
    "docs/guides/configuration.md",
    "docs/guides/configuration.zh-CN.md",
    "docs/guides/migration.md",
    "docs/guides/migration.zh-CN.md",
  ].map(async (relativePath) => [
    relativePath,
    await readFile(path.join(projectRoot, relativePath), "utf8"),
  ]));

  for (const [relativePath, document] of documents) {
    assert.match(document, /Windows PowerShell/, relativePath);
    assert.match(document, /macOS/, relativePath);
    assert.match(document, /Linux/, relativePath);
  }

  for (const relativePath of [
    "docs/guides/configuration.md",
    "docs/guides/configuration.zh-CN.md",
  ]) {
    const document = await readFile(path.join(projectRoot, relativePath), "utf8");
    assert.match(document, /python "C:\/path\/to\/openai-compatible-imagegen\/scripts\/quick-init\.py"/, relativePath);
    assert.match(document, /python3 "\/absolute\/path\/to\/openai-compatible-imagegen\/scripts\/quick-init\.py"/, relativePath);
  }

  for (const relativePath of [
    "docs/guides/migration.md",
    "docs/guides/migration.zh-CN.md",
  ]) {
    const document = await readFile(path.join(projectRoot, relativePath), "utf8");
    assert.match(document, /python "C:\/path\/to\/openai-compatible-imagegen\/dist\/scripts\/migrate_image_config\.py"/, relativePath);
    assert.match(document, /python3 "\/absolute\/path\/to\/openai-compatible-imagegen\/dist\/scripts\/migrate_image_config\.py"/, relativePath);
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
    ["docs/guides/updating.md", "docs/guides/updating.zh-CN.md"],
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

function markdownSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `## ${heading}`);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  const next = lines.findIndex((line, index) => index > start && /^#{1,2} /.test(line));
  return lines.slice(start + 1, next === -1 ? undefined : next).join("\n");
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
  const commandPattern = /^(?:\(Get-FileHash|codex|npx|python3?|shasum|sha256sum)\b/;
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
