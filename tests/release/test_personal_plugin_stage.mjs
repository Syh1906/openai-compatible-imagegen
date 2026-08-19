import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";


const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const stageScript = fileURLToPath(new URL("../../scripts/stage-personal-plugin.mjs", import.meta.url));
const prepareScript = fileURLToPath(new URL("../../scripts/prepare-personal-plugin.mjs", import.meta.url));
const pluginId = "openai-compatible-imagegen";
const expectedRuntimeFiles = [
  "artifact_repository.py",
  "image_alpha.py",
  "image_batch.py",
  "image_cli.py",
  "image_delivery.py",
  "image_delivery_ops.py",
  "image_download.py",
  "image_emissive_alpha.py",
  "image_mask_alpha.py",
  "image_png.py",
  "image_postprocess.py",
  "image_preview.py",
  "image_qa.py",
  "image_reference.py",
  "image_resize.py",
  "image_response.py",
  "image_transaction.py",
  "image_transparency.py",
  "image_transparency_contract.py",
  "image_transparency_runtime.py",
  "image_transport.py",
  "image_webp.py",
  "imagegen.py",
  "imagegen_cli.py",
  "mask_policy.py",
  "image_runtime.py",
  "migrate_image_config.py",
  "posix_repository_fs.py",
  "provider_config.py",
  "repository_fs.py",
  "repository_fs_helper.py",
  "reveal_in_explorer.py",
  "windows_repository_fs.py",
];
const consistencyPaths = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  `skills/${pluginId}/SKILL.md`,
  "dist/server.mjs",
  "dist/widget/index.html",
  ...expectedRuntimeFiles.map((name) => `dist/scripts/${name}`),
];


test("personal staging replaces a stale marketplace source and proves source consistency", async (t) => {
  const catalogRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-personal-stage-"));
  const marketplacePath = path.join(catalogRoot, ".agents", "plugins", "marketplace.json");
  const pluginRoot = path.join(catalogRoot, "plugins", pluginId);
  t.after(async () => rm(catalogRoot, { recursive: true, force: true }));

  await mkdir(path.join(pluginRoot, "dist", "widget"), { recursive: true });
  await writeFile(path.join(pluginRoot, "dist", "widget", "index.html"), "stale widget", "utf8");
  await mkdir(path.dirname(marketplacePath), { recursive: true });
  await writeFile(marketplacePath, `${JSON.stringify({
    name: "personal-test",
    plugins: [{
      name: pluginId,
      source: { source: "local", path: `./plugins/${pluginId}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  }, null, 2)}\n`, "utf8");

  const { stdout } = await execFileAsync(process.execPath, [
    stageScript,
    "--source-root",
    projectRoot,
    "--marketplace-path",
    marketplacePath,
  ], {
    cwd: projectRoot,
    maxBuffer: 4 * 1024 * 1024,
  });
  const result = JSON.parse(stdout.trim());

  assert.equal(result.ok, true);
  assert.equal(result.plugin, pluginId);
  assert.equal(result.sourceConsistent, true);
  assert.equal(result.probeOk, true);
  assert.equal(result.stagedFileCount > consistencyPaths.length, true);
  for (const relativePath of consistencyPaths) {
    assert.equal(
      await hashFile(path.join(pluginRoot, relativePath)),
      await hashFile(path.join(projectRoot, relativePath)),
      relativePath,
    );
  }
  const { stdout: runtimeHelp } = await execFileAsync("python", [
    path.join(pluginRoot, "dist", "scripts", "imagegen.py"),
    "--help",
  ], {
    cwd: pluginRoot,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.match(runtimeHelp, /usage: imagegen /);
  assert.deepEqual(await readdir(path.dirname(pluginRoot)), [pluginId]);
});


test("personal staging rejects a marketplace source outside the canonical personal plugins directory", async (t) => {
  const catalogRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-personal-stage-nested-source-"));
  const marketplacePath = path.join(catalogRoot, ".agents", "plugins", "marketplace.json");
  const nestedPluginRoot = path.join(catalogRoot, ".agents", "plugins", "plugins", pluginId);
  t.after(async () => rm(catalogRoot, { recursive: true, force: true }));

  await mkdir(path.dirname(marketplacePath), { recursive: true });
  await writeFile(marketplacePath, `${JSON.stringify({
    name: "personal-test",
    plugins: [{
      name: pluginId,
      source: { source: "local", path: `./.agents/plugins/plugins/${pluginId}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  }, null, 2)}\n`, "utf8");

  await assert.rejects(
    runStage({ sourceRoot: projectRoot, marketplacePath }),
    /marketplace plugin source must be \.\/plugins\/openai-compatible-imagegen/,
  );
  assert.equal(await lstatOrNull(nestedPluginRoot), null);
});


test("personal staging preserves the existing source when candidate validation fails", async (t) => {
  const catalogRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-personal-stage-failure-"));
  const marketplacePath = path.join(catalogRoot, ".agents", "plugins", "marketplace.json");
  const pluginRoot = path.join(catalogRoot, "plugins", pluginId);
  const invalidSourceRoot = path.join(catalogRoot, "invalid-source");
  t.after(async () => rm(catalogRoot, { recursive: true, force: true }));

  await writeMarketplace(marketplacePath);
  await runStage({ sourceRoot: projectRoot, marketplacePath });
  const beforeFailure = await snapshotFiles(pluginRoot);

  await copyReleaseSource(projectRoot, invalidSourceRoot);
  const invalidWidgetPath = path.join(invalidSourceRoot, "dist", "widget", "index.html");
  const invalidWidget = (await readFile(invalidWidgetPath, "utf8")).replace(
    /(<meta name="openai-compatible-imagegen-release" content=")[a-f0-9]{20}("\s*>)/,
    (_match, prefix, suffix) => `${prefix}${"0".repeat(20)}${suffix}`,
  );
  await writeFile(
    invalidWidgetPath,
    invalidWidget,
    "utf8",
  );

  await assert.rejects(
    runStage({ sourceRoot: invalidSourceRoot, marketplacePath }),
    /widget release marker|digest|release identity|probe failed/i,
  );
  assert.deepEqual(await snapshotFiles(pluginRoot), beforeFailure);
  assert.deepEqual(await readdir(path.dirname(pluginRoot)), [pluginId]);
});


test("personal staging rejects an extra dist file before creating a candidate", async (t) => {
  const catalogRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-personal-stage-extra-dist-"));
  const marketplacePath = path.join(catalogRoot, ".agents", "plugins", "marketplace.json");
  const pluginParent = path.join(catalogRoot, "plugins");
  const invalidSourceRoot = path.join(catalogRoot, "invalid-source");
  t.after(async () => rm(catalogRoot, { recursive: true, force: true }));

  await writeMarketplace(marketplacePath);
  await copyReleaseSource(projectRoot, invalidSourceRoot);
  await writeFile(path.join(invalidSourceRoot, "dist", "obsolete.secret"), "secret", "utf8");

  await assert.rejects(
    runStage({ sourceRoot: invalidSourceRoot, marketplacePath }),
    /distribution file set differs/,
  );
  assert.equal(await lstatOrNull(pluginParent), null);
});


test("personal staging recovers an interrupted directory switch before continuing", async (t) => {
  const catalogRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-personal-stage-recovery-"));
  const marketplacePath = path.join(catalogRoot, ".agents", "plugins", "marketplace.json");
  const pluginParent = path.join(catalogRoot, "plugins");
  const pluginRoot = path.join(pluginParent, pluginId);
  const candidateRoot = path.join(pluginParent, `.${pluginId}.stage-123-fixture`);
  const backupRoot = path.join(pluginParent, `.${pluginId}.backup-123-fixture`);
  const transactionPath = path.join(pluginParent, `.${pluginId}.stage.transaction.json`);
  t.after(async () => rm(catalogRoot, { recursive: true, force: true }));

  await writeMarketplace(marketplacePath);
  await runStage({ sourceRoot: projectRoot, marketplacePath });
  await rename(pluginRoot, backupRoot);
  await mkdir(candidateRoot);
  await writeFile(path.join(candidateRoot, "partial.txt"), "partial candidate", "utf8");
  await writeFile(transactionPath, `${JSON.stringify({
    version: 1,
    token: "fixture-token",
    pluginRoot,
    candidateRoot,
    backupRoot,
    phase: "old-moved",
  })}\n`, "utf8");

  await runStage({ sourceRoot: projectRoot, marketplacePath });

  assert.deepEqual(await readdir(pluginParent), [pluginId]);
  for (const relativePath of consistencyPaths) {
    assert.equal(
      await hashFile(path.join(pluginRoot, relativePath)),
      await hashFile(path.join(projectRoot, relativePath)),
      relativePath,
    );
  }
});


test("personal staging recovers an interrupted transaction write before continuing", async (t) => {
  const catalogRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-personal-stage-transaction-write-"));
  const marketplacePath = path.join(catalogRoot, ".agents", "plugins", "marketplace.json");
  const pluginParent = path.join(catalogRoot, "plugins");
  const pluginRoot = path.join(pluginParent, pluginId);
  const candidateRoot = path.join(pluginParent, `.${pluginId}.stage-123-transaction-fixture`);
  const transactionPath = path.join(pluginParent, `.${pluginId}.stage.transaction.json`);
  const transactionWritePath = `${transactionPath}.tmp`;
  t.after(async () => rm(catalogRoot, { recursive: true, force: true }));

  await writeMarketplace(marketplacePath);
  await runStage({ sourceRoot: projectRoot, marketplacePath });
  await mkdir(candidateRoot);
  await writeFile(path.join(candidateRoot, "partial.txt"), "partial candidate", "utf8");
  await writeFile(transactionPath, `${JSON.stringify({
    version: 1,
    token: "fixture-token",
    pluginRoot,
    candidateRoot,
    backupRoot: null,
    phase: "copying",
  })}\n`, "utf8");
  await writeFile(transactionWritePath, "{\"version\":1", "utf8");

  await runStage({ sourceRoot: projectRoot, marketplacePath });

  assert.deepEqual(await readdir(pluginParent), [pluginId]);
  for (const relativePath of consistencyPaths) {
    assert.equal(
      await hashFile(path.join(pluginRoot, relativePath)),
      await hashFile(path.join(projectRoot, relativePath)),
      relativePath,
    );
  }
});


test("personal staging recovers an expired legacy lock after PID reuse", async (t) => {
  const catalogRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-personal-stage-legacy-lock-"));
  const marketplacePath = path.join(catalogRoot, ".agents", "plugins", "marketplace.json");
  const pluginParent = path.join(catalogRoot, "plugins");
  const pluginRoot = path.join(pluginParent, pluginId);
  const legacyLockPath = path.join(pluginParent, `.${pluginId}.stage.lock`);
  t.after(async () => rm(catalogRoot, { recursive: true, force: true }));

  await writeMarketplace(marketplacePath);
  await mkdir(pluginParent, { recursive: true });
  await writeFile(legacyLockPath, `${JSON.stringify({
    version: 1,
    token: "expired-legacy-lock",
    pid: process.pid,
    createdAt: new Date(Date.now() - (24 * 60 * 60 * 1000)).toISOString(),
  })}\n`, "utf8");

  await runStage({ sourceRoot: projectRoot, marketplacePath });

  assert.deepEqual(await readdir(pluginParent), [pluginId]);
  for (const relativePath of consistencyPaths) {
    assert.equal(
      await hashFile(path.join(pluginRoot, relativePath)),
      await hashFile(path.join(projectRoot, relativePath)),
      relativePath,
    );
  }
});


test("personal staging preserves a valid backup when the active root is invalid", async (t) => {
  const catalogRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-personal-stage-invalid-active-"));
  const marketplacePath = path.join(catalogRoot, ".agents", "plugins", "marketplace.json");
  const pluginParent = path.join(catalogRoot, "plugins");
  const pluginRoot = path.join(pluginParent, pluginId);
  const backupRoot = path.join(pluginParent, `.${pluginId}.backup-123-invalid-active`);
  const candidateRoot = path.join(pluginParent, `.${pluginId}.stage-123-invalid-active`);
  const transactionPath = path.join(pluginParent, `.${pluginId}.stage.transaction.json`);
  t.after(async () => rm(catalogRoot, { recursive: true, force: true }));

  await writeMarketplace(marketplacePath);
  await runStage({ sourceRoot: projectRoot, marketplacePath });
  await rename(pluginRoot, backupRoot);
  await writeFile(pluginRoot, "invalid active root", "utf8");
  await writeFile(transactionPath, `${JSON.stringify({
    version: 1,
    token: "invalid-active-fixture",
    pluginRoot,
    candidateRoot,
    backupRoot,
    phase: "old-moved",
  })}\n`, "utf8");

  await assert.rejects(
    runStage({ sourceRoot: projectRoot, marketplacePath }),
    /personal staging plugin root is not a directory|plugin root/i,
  );
  assert.equal((await lstat(backupRoot)).isDirectory(), true);
  assert.equal((await lstat(pluginRoot)).isFile(), true);
  assert.equal((await lstat(transactionPath)).isFile(), true);
});


test("personal staging rejects an invalid backup before promoting it", async (t) => {
  const catalogRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-personal-stage-invalid-backup-"));
  const marketplacePath = path.join(catalogRoot, ".agents", "plugins", "marketplace.json");
  const pluginParent = path.join(catalogRoot, "plugins");
  const pluginRoot = path.join(pluginParent, pluginId);
  const backupRoot = path.join(pluginParent, `.${pluginId}.backup-123-invalid-backup`);
  const candidateRoot = path.join(pluginParent, `.${pluginId}.stage-123-invalid-backup`);
  const transactionPath = path.join(pluginParent, `.${pluginId}.stage.transaction.json`);
  t.after(async () => rm(catalogRoot, { recursive: true, force: true }));

  await writeMarketplace(marketplacePath);
  await mkdir(pluginParent, { recursive: true });
  await writeFile(backupRoot, "invalid backup root", "utf8");
  await writeFile(transactionPath, `${JSON.stringify({
    version: 1,
    token: "invalid-backup-fixture",
    pluginRoot,
    candidateRoot,
    backupRoot,
    phase: "old-moved",
  })}\n`, "utf8");

  await assert.rejects(
    runStage({ sourceRoot: projectRoot, marketplacePath }),
    /marketplace plugin root is not a directory|personal staging backup root is not a directory|backup root/i,
  );
  assert.equal((await lstat(backupRoot)).isFile(), true);
  assert.equal(await lstatOrNull(pluginRoot), null);
  assert.equal((await lstat(transactionPath)).isFile(), true);
});


test("personal staging rejects a symbolic-link transaction before recovery", async (t) => {
  const catalogRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-personal-stage-transaction-link-"));
  const marketplacePath = path.join(catalogRoot, ".agents", "plugins", "marketplace.json");
  const pluginParent = path.join(catalogRoot, "plugins");
  const pluginRoot = path.join(pluginParent, pluginId);
  const backupRoot = path.join(pluginParent, `.${pluginId}.backup-123-transaction-link`);
  const candidateRoot = path.join(pluginParent, `.${pluginId}.stage-123-transaction-link`);
  const transactionPath = path.join(pluginParent, `.${pluginId}.stage.transaction.json`);
  const externalTransactionPath = path.join(catalogRoot, "external-transaction.json");
  t.after(async () => rm(catalogRoot, { recursive: true, force: true }));

  await writeMarketplace(marketplacePath);
  await runStage({ sourceRoot: projectRoot, marketplacePath });
  await cp(pluginRoot, backupRoot, { recursive: true });
  await writeFile(externalTransactionPath, `${JSON.stringify({
    version: 1,
    token: "transaction-link-fixture",
    pluginRoot,
    candidateRoot,
    backupRoot,
    phase: "installed",
  })}\n`, "utf8");
  await symlink(externalTransactionPath, transactionPath, "file");

  await assert.rejects(
    runStage({ sourceRoot: projectRoot, marketplacePath }),
    /personal staging transaction is a symbolic link|transaction/i,
  );
  assert.equal((await lstat(backupRoot)).isDirectory(), true);
  assert.equal((await lstat(transactionPath)).isSymbolicLink(), true);
});


async function hashFile(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}


async function copyReleaseSource(sourceRoot, destinationRoot) {
  await mkdir(destinationRoot, { recursive: true });
  for (const relativePath of ["package.json", "package-lock.json", ".mcp.json", "LICENSE"]) {
    await copyFile(path.join(sourceRoot, relativePath), path.join(destinationRoot, relativePath));
  }
  for (const relativePath of [".codex-plugin", "assets", "dist", `skills/${pluginId}`]) {
    await cp(path.join(sourceRoot, relativePath), path.join(destinationRoot, relativePath), {
      recursive: true,
    });
  }
}


async function runStage({ sourceRoot, marketplacePath }) {
  return await execFileAsync(process.execPath, [
    stageScript,
    "--source-root",
    sourceRoot,
    "--marketplace-path",
    marketplacePath,
  ], {
    cwd: projectRoot,
    maxBuffer: 4 * 1024 * 1024,
  });
}


async function snapshotFiles(root, relativeDirectory = "") {
  const snapshot = {};
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(snapshot, await snapshotFiles(root, relativePath));
    } else {
      snapshot[relativePath.replaceAll("\\", "/")] = await hashFile(path.join(root, relativePath));
    }
  }
  return snapshot;
}


async function lstatOrNull(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}


async function writeMarketplace(marketplacePath) {
  await mkdir(path.dirname(marketplacePath), { recursive: true });
  await writeFile(marketplacePath, `${JSON.stringify({
    name: "personal-test",
    plugins: [{
      name: pluginId,
      source: { source: "local", path: `./plugins/${pluginId}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  }, null, 2)}\n`, "utf8");
}


test("personal preparation rebuilds and stages the validated local plugin", async () => {
  const { preparePersonalPlugin } = await import(pathToFileURL(prepareScript));
  const calls = [];
  const marketplacePath = path.join(projectRoot, ".agents", "plugins", "marketplace.json");
  const result = await preparePersonalPlugin({
    sourceRoot: projectRoot,
    marketplacePath,
    npmCliPath: null,
    execute: async (command, args) => {
      calls.push({ command, args });
      return args[0] === stageScript
        ? {
            stdout: '{"ok":true,"plugin":"openai-compatible-imagegen","marketplaceName":"personal-test","sourceConsistent":true,"probeOk":true}\n',
            stderr: "",
          }
        : { stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(
    calls.map(({ args }) => args.join(" ")),
    [
      "run build",
      "run test",
      "run check",
      `${stageScript} --source-root ${path.resolve(projectRoot)} --marketplace-path ${marketplacePath}`,
    ],
  );
  assert.deepEqual(result.steps, ["build", "test", "check", "stage:personal"]);
  assert.equal(result.stage.sourceConsistent, true);
  assert.equal(result.stage.probeOk, true);
  assert.equal("install" in result, false);
});


test("personal preparation never stages after an earlier gate fails", async () => {
  const { preparePersonalPlugin } = await import(pathToFileURL(prepareScript));
  const calls = [];
  await assert.rejects(
    preparePersonalPlugin({
      sourceRoot: projectRoot,
      marketplacePath: path.join(projectRoot, ".agents", "plugins", "marketplace.json"),
      npmCliPath: null,
      execute: async (command, args) => {
        calls.push({ command, args });
        if (args.join(" ") === "run check") throw new Error("check failed");
        return { stdout: "", stderr: "" };
      },
    }),
    /check failed/,
  );

  assert.deepEqual(calls.map(({ args }) => args.join(" ")), ["run build", "run test", "run check"]);
});


test("personal preparation preserves stdout and stderr from a failed gate", async () => {
  const { preparePersonalPlugin } = await import(pathToFileURL(prepareScript));
  await assert.rejects(
    preparePersonalPlugin({
      sourceRoot: projectRoot,
      marketplacePath: path.join(projectRoot, ".agents", "plugins", "marketplace.json"),
      npmCliPath: null,
      execute: async () => {
        throw Object.assign(new Error("test command exited"), {
          stdout: "node test failed",
          stderr: "python tests passed",
        });
      },
    }),
    /node test failed[\s\S]*python tests passed/,
  );
});
