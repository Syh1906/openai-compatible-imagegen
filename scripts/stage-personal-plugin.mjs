import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import lockfile from "proper-lockfile";

import {
  distributionFiles as expectedDistributionFiles,
  releaseEntriesFor,
  releaseTopLevelEntries as expectedTopLevelEntries,
} from "./plugin-file-set.mjs";


const execFileAsync = promisify(execFile);
const defaultSourceRoot = fileURLToPath(new URL("..", import.meta.url));
const probePath = fileURLToPath(new URL("./probe-plugin.mjs", import.meta.url));
const pluginId = "openai-compatible-imagegen";
const releaseEntries = releaseEntriesFor(pluginId);
const legacyStageLockFileName = `.${pluginId}.stage.lock`;
const stageLockDirectoryName = `.${pluginId}.stage.lock-v2`;
const legacyStageLockStaleMs = 60 * 60 * 1000;
const transactionFileName = `.${pluginId}.stage.transaction.json`;
const transactionWriteFileName = `${transactionFileName}.tmp`;


async function main() {
  const options = parseOptions(process.argv.slice(2));
  const sourceRoot = path.resolve(options.sourceRoot ?? defaultSourceRoot);
  const marketplacePath = path.resolve(
    options.marketplacePath
      ?? path.join(os.homedir(), ".agents", "plugins", "marketplace.json"),
  );
  const sourceManifest = await readJson(path.join(sourceRoot, ".codex-plugin", "plugin.json"));
  requireValue(sourceManifest.name === pluginId, "unexpected source plugin name");
  await requirePackageIdentity(sourceRoot, sourceManifest);
  await requireExactDistribution(sourceRoot);

  const marketplace = await resolveMarketplaceSource(marketplacePath);
  await requireNoSymlinkComponents(marketplace.marketplaceRoot, marketplace.pluginRoot);
  const pluginParent = path.dirname(marketplace.pluginRoot);
  await mkdir(pluginParent, { recursive: true });
  const stageLock = await acquireStageLock(pluginParent);
  const candidateRoot = createOwnedSiblingPath(pluginParent, "stage");
  const transactionPath = path.join(pluginParent, transactionFileName);
  const transaction = {
    version: 1,
    token: randomUUID(),
    pluginRoot: marketplace.pluginRoot,
    candidateRoot,
    backupRoot: null,
    phase: "copying",
  };
  let candidateExists = false;
  let transactionStarted = false;
  let stagedFileCount;
  let probe;

  try {
    await recoverInterruptedStage({
      pluginParent,
      pluginRoot: marketplace.pluginRoot,
    });
    await writeTransaction(transactionPath, transaction);
    transactionStarted = true;
    await mkdir(candidateRoot);
    candidateExists = true;
    for (const relativePath of releaseEntries) {
      await copyReleaseEntry(sourceRoot, candidateRoot, relativePath);
    }
    stagedFileCount = await requireExactPackage(sourceRoot, candidateRoot);
    probe = await runProbe({ pluginRoot: candidateRoot, sourceRoot });
    requireValue(probe.ok === true && probe.sourceConsistent === true, "staged plugin probe failed");
    await updateTransaction(transactionPath, transaction, { phase: "validated" });
    await replacePluginDirectory({
      candidateRoot,
      pluginParent,
      pluginRoot: marketplace.pluginRoot,
      transaction,
      transactionPath,
    });
    candidateExists = false;
  } catch (error) {
    if (candidateExists) {
      try {
        await removeOwnedDirectory(pluginParent, candidateRoot);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `personal staging failed and candidate cleanup failed: ${candidateRoot}`,
        );
      }
    }
    if (transactionStarted) {
      await clearSettledTransaction(transactionPath, transaction);
    }
    throw error;
  } finally {
    await stageLock.release();
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    plugin: pluginId,
    version: sourceManifest.version,
    stagedFileCount,
    sourceConsistent: true,
    probeOk: true,
    releaseIdentity: probe.releaseIdentity,
  })}\n`);
}


async function replacePluginDirectory({
  candidateRoot,
  pluginParent,
  pluginRoot,
  transaction,
  transactionPath,
}) {
  const existing = await lstatOrNull(pluginRoot);
  if (!existing) {
    await updateTransaction(transactionPath, transaction, { phase: "installing" });
    await rename(candidateRoot, pluginRoot);
    await updateTransaction(transactionPath, transaction, { phase: "installed" });
    await clearTransaction(transactionPath, transaction);
    return;
  }
  requireValue(!existing.isSymbolicLink(), "marketplace plugin root is a symbolic link");
  requireValue(existing.isDirectory(), "marketplace plugin root is not a directory");
  await requireSafeTree(pluginRoot);

  const backupRoot = createOwnedSiblingPath(pluginParent, "backup");
  await updateTransaction(transactionPath, transaction, {
    backupRoot,
    phase: "moving",
  });
  await rename(pluginRoot, backupRoot);
  await updateTransaction(transactionPath, transaction, { phase: "old-moved" });
  await updateTransaction(transactionPath, transaction, { phase: "installing" });
  try {
    await rename(candidateRoot, pluginRoot);
  } catch (error) {
    try {
      await rename(backupRoot, pluginRoot);
      await clearTransaction(transactionPath, transaction);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `personal staging switch failed and rollback failed: ${backupRoot}`,
      );
    }
    throw error;
  }
  await updateTransaction(transactionPath, transaction, { phase: "installed" });

  try {
    await removeOwnedDirectory(pluginParent, backupRoot);
    await clearTransaction(transactionPath, transaction);
  } catch (cleanupError) {
    throw new Error(
      `personal staging switched successfully but backup cleanup failed: ${backupRoot}: ${cleanupError.message}`,
      { cause: cleanupError },
    );
  }
}


async function acquireStageLock(pluginParent) {
  await recoverLegacyStageLock(pluginParent);
  const lockPath = path.join(pluginParent, stageLockDirectoryName);
  const existing = await lstatOrNull(lockPath);
  if (existing) {
    requireValue(!existing.isSymbolicLink(), "personal staging lock is a symbolic link");
    requireValue(existing.isDirectory(), "personal staging lock is not a directory");
  }
  try {
    const release = await lockfile.lock(pluginParent, {
      lockfilePath: lockPath,
      realpath: false,
      retries: 0,
      stale: 5 * 60 * 1000,
      update: 60 * 1000,
    });
    return { release };
  } catch (error) {
    if (error?.code === "ELOCKED") {
      throw new Error("personal staging is already running", { cause: error });
    }
    throw error;
  }
}


async function recoverLegacyStageLock(pluginParent) {
  const lockPath = path.join(pluginParent, legacyStageLockFileName);
  const metadata = await lstatOrNull(lockPath);
  if (!metadata) return;
  requireValue(!metadata.isSymbolicLink(), "legacy personal staging lock is a symbolic link");
  requireValue(metadata.isFile(), "legacy personal staging lock is not a file");
  const existing = await readJson(lockPath);
  requireValue(
    Number.isInteger(existing.pid) && existing.pid > 0,
    "legacy personal staging lock has an invalid owner",
  );
  const createdAt = Date.parse(existing.createdAt);
  requireValue(Number.isFinite(createdAt), "legacy personal staging lock has an invalid timestamp");
  const expired = Date.now() - createdAt >= legacyStageLockStaleMs;
  if (isProcessAlive(existing.pid) && !expired) {
    throw new Error(`personal staging is already running with pid ${existing.pid}`);
  }
  await removeOwnedFile(pluginParent, lockPath, legacyStageLockFileName);
}


async function recoverInterruptedStage({ pluginParent, pluginRoot }) {
  const transactionPath = path.join(pluginParent, transactionFileName);
  const transactionWritePath = path.join(pluginParent, transactionWriteFileName);
  await removeOwnedFile(pluginParent, transactionWritePath, transactionWriteFileName);
  const transaction = await readTransactionOrNull(transactionPath);
  if (!transaction) return;
  validateTransaction(pluginParent, pluginRoot, transaction);

  const active = await lstatOrNull(pluginRoot);
  const backup = transaction.backupRoot
    ? await requireRecoverableDirectory(transaction.backupRoot, "backup")
    : null;
  if (!active && backup) {
    await rename(transaction.backupRoot, pluginRoot);
  } else if (active && backup) {
    requireValue(!active.isSymbolicLink(), "personal staging plugin root is a symbolic link");
    requireValue(active.isDirectory(), "personal staging plugin root is not a directory");
    await requireSafeTree(pluginRoot);
    await removeOwnedDirectory(pluginParent, transaction.backupRoot);
  }

  if (await lstatOrNull(transaction.candidateRoot)) {
    await removeOwnedDirectory(pluginParent, transaction.candidateRoot);
  }
  await clearTransaction(transactionPath, transaction);
}


function validateTransaction(pluginParent, pluginRoot, transaction) {
  requireValue(transaction.version === 1, "unsupported personal staging transaction version");
  requireValue(typeof transaction.token === "string", "personal staging transaction token is missing");
  requireValue(path.resolve(transaction.pluginRoot) === pluginRoot, "personal staging transaction plugin root differs");
  requireOwnedSiblingPath(pluginParent, transaction.candidateRoot, "stage");
  if (transaction.backupRoot) {
    requireOwnedSiblingPath(pluginParent, transaction.backupRoot, "backup");
  }
  requireValue(
    ["copying", "validated", "moving", "old-moved", "installing", "installed"].includes(transaction.phase),
    "personal staging transaction phase is invalid",
  );
}


function requireOwnedSiblingPath(parent, candidate, kind) {
  requireValue(typeof candidate === "string", `personal staging ${kind} path is missing`);
  requireInside(parent, candidate);
  requireValue(
    path.basename(candidate).startsWith(`.${pluginId}.${kind}-`),
    `personal staging ${kind} path has an invalid name`,
  );
}


async function updateTransaction(transactionPath, transaction, changes) {
  Object.assign(transaction, changes);
  await writeTransaction(transactionPath, transaction);
}


async function writeTransaction(transactionPath, transaction) {
  const transactionParent = path.dirname(transactionPath);
  const transactionWritePath = path.join(transactionParent, transactionWriteFileName);
  const metadata = await lstatOrNull(transactionPath);
  if (metadata) {
    requireValue(!metadata.isSymbolicLink(), "personal staging transaction is a symbolic link");
    requireValue(metadata.isFile(), "personal staging transaction is not a file");
  }
  const writeMetadata = await lstatOrNull(transactionWritePath);
  if (writeMetadata) {
    requireValue(!writeMetadata.isSymbolicLink(), "personal staging transaction write is a symbolic link");
    requireValue(writeMetadata.isFile(), "personal staging transaction write is not a file");
  }
  try {
    await writeFile(transactionWritePath, `${JSON.stringify(transaction)}\n`, "utf8");
    await rename(transactionWritePath, transactionPath);
  } catch (error) {
    try {
      await removeOwnedFile(transactionParent, transactionWritePath, transactionWriteFileName);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `personal staging transaction update and cleanup failed: ${transactionWritePath}`,
      );
    }
    throw error;
  }
}


async function clearSettledTransaction(transactionPath, transaction) {
  const current = await readTransactionOrNull(transactionPath);
  if (!current) return;
  requireValue(current.token === transaction.token, "personal staging transaction ownership changed");
  if (current.backupRoot && await lstatOrNull(current.backupRoot)) return;
  await clearTransaction(transactionPath, current);
}


async function clearTransaction(transactionPath, transaction) {
  const current = await readTransactionOrNull(transactionPath);
  if (!current) return;
  requireValue(current.token === transaction.token, "personal staging transaction ownership changed");
  await removeOwnedFile(path.dirname(transactionPath), transactionPath, transactionFileName);
}


async function removeOwnedFile(parent, target, expectedName) {
  requireInside(parent, target);
  requireValue(path.basename(target) === expectedName, "refusing to remove an unowned staging file");
  const metadata = await lstatOrNull(target);
  if (!metadata) return;
  requireValue(!metadata.isSymbolicLink(), `refusing to remove symbolic link: ${target}`);
  requireValue(metadata.isFile(), `refusing to remove non-file: ${target}`);
  try {
    await rm(target, { force: false });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}


async function readTransactionOrNull(transactionPath) {
  const metadata = await lstatOrNull(transactionPath);
  if (!metadata) return null;
  requireValue(!metadata.isSymbolicLink(), "personal staging transaction is a symbolic link");
  requireValue(metadata.isFile(), "personal staging transaction is not a file");
  return await readJson(transactionPath);
}


async function requireRecoverableDirectory(target, label) {
  const metadata = await lstatOrNull(target);
  if (!metadata) return null;
  requireValue(!metadata.isSymbolicLink(), `personal staging ${label} root is a symbolic link`);
  requireValue(metadata.isDirectory(), `personal staging ${label} root is not a directory`);
  await requireSafeTree(target);
  return metadata;
}


function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}


function createOwnedSiblingPath(parent, kind) {
  const candidate = path.join(parent, `.${pluginId}.${kind}-${process.pid}-${randomUUID()}`);
  requireInside(parent, candidate);
  return candidate;
}


async function removeOwnedDirectory(parent, target) {
  requireInside(parent, target);
  const metadata = await lstatOrNull(target);
  if (!metadata) return;
  requireValue(!metadata.isSymbolicLink(), `refusing to remove symbolic link: ${target}`);
  requireValue(metadata.isDirectory(), `refusing to remove non-directory: ${target}`);
  await requireSafeTree(target);
  await rm(target, { recursive: true, force: false });
}


async function requireSafeTree(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    const metadata = await lstat(entryPath);
    requireValue(!metadata.isSymbolicLink(), `plugin tree contains a symbolic link: ${entryPath}`);
    if (metadata.isDirectory()) {
      await requireSafeTree(entryPath);
    } else {
      requireValue(metadata.isFile(), `plugin tree contains an unsupported entry: ${entryPath}`);
    }
  }
}


async function lstatOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}


function parseOptions(args) {
  const options = { marketplacePath: null, sourceRoot: null };
  const optionNames = new Map([
    ["--marketplace-path", "marketplacePath"],
    ["--source-root", "sourceRoot"],
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = optionNames.get(args[index]);
    const value = args[index + 1];
    if (!key || !value) {
      throw new Error(
        "usage: node scripts/stage-personal-plugin.mjs "
        + "[--source-root <path>] [--marketplace-path <path>]",
      );
    }
    options[key] = value;
  }
  return options;
}


async function resolveMarketplaceSource(marketplacePath) {
  const catalogDirectory = path.dirname(marketplacePath);
  requireValue(
    path.basename(catalogDirectory) === "plugins"
      && path.basename(path.dirname(catalogDirectory)) === ".agents",
    "marketplace path must be under <root>/.agents/plugins/marketplace.json",
  );
  const marketplaceRoot = path.resolve(catalogDirectory, "..", "..");
  const catalog = await readJson(marketplacePath);
  const matches = catalog.plugins?.filter((entry) => entry.name === pluginId) ?? [];
  requireValue(matches.length === 1, `marketplace must contain exactly one ${pluginId} entry`);
  const source = matches[0].source;
  requireValue(source?.source === "local", "marketplace plugin source must be local");
  requireValue(typeof source.path === "string", "marketplace plugin source path is missing");
  const pluginRoot = path.resolve(marketplaceRoot, source.path);
  const expectedPluginRoot = path.resolve(marketplaceRoot, "plugins", pluginId);
  requireInside(marketplaceRoot, pluginRoot);
  requireValue(
    pluginRoot === expectedPluginRoot,
    `marketplace plugin source must be ./plugins/${pluginId}`,
  );
  return { marketplaceRoot, pluginRoot };
}


async function requirePackageIdentity(sourceRoot, manifest) {
  const packageManifest = await readJson(path.join(sourceRoot, "package.json"));
  const packageLock = await readJson(path.join(sourceRoot, "package-lock.json"));
  requireValue(packageManifest.name === manifest.name, "package name differs from plugin name");
  requireValue(packageManifest.version === manifest.version, "package version differs from plugin version");
  requireValue(packageLock.name === manifest.name, "package lock name differs from plugin name");
  requireValue(packageLock.version === manifest.version, "package lock version differs from plugin version");
  requireValue(packageLock.packages?.[""]?.name === manifest.name, "package lock root name differs from plugin name");
  requireValue(packageLock.packages?.[""]?.version === manifest.version, "package lock root version differs from plugin version");
}


async function copyReleaseEntry(sourceRoot, pluginRoot, relativePath) {
  const sourcePath = path.resolve(sourceRoot, relativePath);
  const destinationPath = path.resolve(pluginRoot, relativePath);
  requireInside(sourceRoot, sourcePath);
  requireInside(pluginRoot, destinationPath);
  const sourceMetadata = await lstat(sourcePath);
  requireValue(!sourceMetadata.isSymbolicLink(), `release source is a symbolic link: ${relativePath}`);
  if (sourceMetadata.isFile()) {
    await requireSafeDestination(destinationPath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
    return;
  }
  requireValue(sourceMetadata.isDirectory(), `release source has unsupported type: ${relativePath}`);
  await copyDirectory(sourceRoot, pluginRoot, relativePath);
}


async function copyDirectory(sourceRoot, pluginRoot, relativeDirectory) {
  const sourceDirectory = path.resolve(sourceRoot, relativeDirectory);
  const destinationDirectory = path.resolve(pluginRoot, relativeDirectory);
  await requireSafeDestination(destinationDirectory, "directory");
  await mkdir(destinationDirectory, { recursive: true });
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.join(relativeDirectory, entry.name);
    const sourcePath = path.resolve(sourceRoot, relativePath);
    const metadata = await lstat(sourcePath);
    requireValue(!metadata.isSymbolicLink(), `release source is a symbolic link: ${relativePath}`);
    if (metadata.isDirectory()) {
      await copyDirectory(sourceRoot, pluginRoot, relativePath);
    } else if (metadata.isFile()) {
      const destinationPath = path.resolve(pluginRoot, relativePath);
      await requireSafeDestination(destinationPath);
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
    } else {
      throw new Error(`release source has unsupported type: ${relativePath}`);
    }
  }
}


async function requireExactPackage(sourceRoot, pluginRoot) {
  const topLevelEntries = (await readdir(pluginRoot)).sort();
  requireValue(
    JSON.stringify(topLevelEntries) === JSON.stringify(expectedTopLevelEntries),
    `marketplace plugin has unexpected top-level entries: ${topLevelEntries.join(", ")}`,
  );
  const sourceFiles = await listReleaseFiles(sourceRoot);
  const stagedFiles = await listReleaseFiles(pluginRoot);
  requireValue(
    JSON.stringify(stagedFiles) === JSON.stringify(sourceFiles),
    "marketplace plugin release file list differs from source",
  );
  for (const relativePath of sourceFiles) {
    const [sourceHash, stagedHash] = await Promise.all([
      hashFile(path.join(sourceRoot, relativePath)),
      hashFile(path.join(pluginRoot, relativePath)),
    ]);
    requireValue(sourceHash === stagedHash, `marketplace plugin file differs from source: ${relativePath}`);
  }
  return sourceFiles.length;
}


async function requireExactDistribution(sourceRoot) {
  const files = [];
  await collectFiles(sourceRoot, "dist", files);
  const distributionFiles = files.map((relativePath) => relativePath.slice("dist/".length)).sort();
  requireValue(
    JSON.stringify(distributionFiles) === JSON.stringify(expectedDistributionFiles),
    `distribution file set differs: ${distributionFiles.join(", ")}`,
  );
}


async function listReleaseFiles(root) {
  const files = [];
  for (const relativePath of releaseEntries) {
    await collectFiles(root, relativePath, files);
  }
  return files.sort();
}


async function collectFiles(root, relativePath, files) {
  const absolutePath = path.resolve(root, relativePath);
  const metadata = await lstat(absolutePath);
  requireValue(!metadata.isSymbolicLink(), `release path is a symbolic link: ${relativePath}`);
  if (metadata.isFile()) {
    files.push(relativePath.replaceAll("\\", "/"));
    return;
  }
  requireValue(metadata.isDirectory(), `release path has unsupported type: ${relativePath}`);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    await collectFiles(root, path.join(relativePath, entry.name), files);
  }
}


async function requireNoSymlinkComponents(root, target) {
  const relative = path.relative(root, target);
  requireValue(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "marketplace plugin path escapes marketplace root");
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const metadata = await lstat(current);
      requireValue(!metadata.isSymbolicLink(), "marketplace plugin path contains a symbolic link");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}


async function requireSafeDestination(destinationPath, expectedType = "file") {
  try {
    const metadata = await lstat(destinationPath);
    requireValue(!metadata.isSymbolicLink(), "marketplace destination is a symbolic link");
    requireValue(
      expectedType === "directory" ? metadata.isDirectory() : metadata.isFile(),
      `marketplace destination type differs: ${destinationPath}`,
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}


async function runProbe({ marketplacePath, pluginRoot, sourceRoot }) {
  const args = [
    probePath,
    "--plugin-root",
    pluginRoot,
    "--project-root",
    sourceRoot,
    "--source-root",
    sourceRoot,
  ];
  if (marketplacePath) {
    args.push("--marketplace-path", marketplacePath);
  }
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: sourceRoot,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim());
}


async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}


async function readJsonOrNull(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}


async function hashFile(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}


function requireInside(root, candidate) {
  const relative = path.relative(root, candidate);
  requireValue(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "path escapes the expected root");
}


function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}


main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
