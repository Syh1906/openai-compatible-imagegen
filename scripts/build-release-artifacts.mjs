import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  pluginReleaseFiles,
  runtimeFileNames,
  sharedCoreFileNames,
  standaloneReleaseFiles,
} from "./plugin-file-set.mjs";


const defaultSourceRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginId = "openai-compatible-imagegen";
const archiveRoot = `${pluginId}/`;
const standaloneCompatibilityBaselineVersion = "0.3.0";
const forbiddenArchivePath = /(^|\/)(auth\.json|\.local|verification-scratch|node_modules|__pycache__|cache|test-results?|coverage)(\/|$)/i;
const allowedReleaseTextExtensions = new Set([".html", ".json", ".jsonl", ".mjs", ".md", ".py", ".yaml"]);
const allowedReleaseTextNames = new Set([".gitignore", "LICENSE"]);


async function main() {
  const options = parseOptions(process.argv.slice(2));
  const sourceRoot = path.resolve(options.sourceRoot ?? defaultSourceRoot);
  const outputDirectory = path.resolve(options.outputDirectory);
  await requireDirectoryWithoutLinks(sourceRoot, "release source root");
  await mkdir(outputDirectory, { recursive: true });
  await requireDirectoryWithoutLinks(outputDirectory, "release output directory");

  const manifest = await readJsonSource(sourceRoot, ".codex-plugin/plugin.json");
  requireValue(manifest.name === pluginId, "unexpected source plugin name");
  requireValue(
    typeof manifest.version === "string" && /^[0-9A-Za-z.+-]+$/.test(manifest.version),
    "source plugin version is invalid",
  );
  requireReleaseVersion(manifest.version, options.developmentProbe);
  await requirePackageIdentity(sourceRoot, manifest);
  requireAllowedPaths(standaloneReleaseFiles);
  requireAllowedPaths(pluginReleaseFiles);

  const [standaloneSources, pluginSources] = await Promise.all([
    readSourceFiles(sourceRoot, standaloneReleaseFiles),
    readSourceFiles(sourceRoot, pluginReleaseFiles),
  ]);
  await requirePluginRuntimeMatchesSource(sourceRoot, pluginSources);
  const sharedPython = createSharedPythonEvidence(standaloneSources, pluginSources);
  const artifactPrefix = options.developmentProbe ? `${pluginId}-development` : pluginId;
  const fileNames = {
    standalone: `${artifactPrefix}-skill-${manifest.version}.zip`,
    plugin: `${artifactPrefix}-codex-plugin-${manifest.version}.zip`,
    evidence: `${artifactPrefix}-shared-python-sha256-${manifest.version}.json`,
    checksums: "SHA256SUMS",
  };
  const outputPaths = Object.fromEntries(
    Object.entries(fileNames).map(([kind, name]) => [kind, path.join(outputDirectory, name)]),
  );
  await requireAbsentOutputs(Object.values(outputPaths));

  const standaloneZip = createStoredZip(standaloneSources.map(({ relativePath, content }) => ({
    name: archiveRoot + relativePath,
    content,
  })));
  const pluginZip = createStoredZip(pluginSources.map(({ relativePath, content }) => ({
    name: archiveRoot + relativePath,
    content,
  })));
  const evidence = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    plugin: pluginId,
    version: manifest.version,
    sharedPython,
  }, null, 2)}\n`, "utf8");
  const checksumSources = [
    [fileNames.standalone, standaloneZip],
    [fileNames.plugin, pluginZip],
    [fileNames.evidence, evidence],
  ].sort(([left], [right]) => left.localeCompare(right));
  const checksums = Buffer.from(
    checksumSources.map(([name, content]) => `${sha256(content)}  ${name}`).join("\n") + "\n",
    "utf8",
  );

  await publishArtifactSet([
    { outputPath: outputPaths.standalone, content: standaloneZip },
    { outputPath: outputPaths.plugin, content: pluginZip },
    { outputPath: outputPaths.evidence, content: evidence },
    { outputPath: outputPaths.checksums, content: checksums },
  ]);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    plugin: pluginId,
    version: manifest.version,
    sharedPythonFiles: sharedCoreFileNames.length,
    files: Object.values(fileNames).sort(),
  })}\n`);
}


function parseOptions(args) {
  const options = { developmentProbe: false };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--development-probe") {
      requireValue(!options.developmentProbe, "--development-probe may be provided only once");
      options.developmentProbe = true;
      continue;
    }
    if (option === "--source-root" || option === "--output-directory") {
      const value = args[index + 1];
      requireValue(value && !value.startsWith("--"), `${option} requires a value`);
      const key = option === "--source-root" ? "sourceRoot" : "outputDirectory";
      requireValue(options[key] === undefined, `${option} may be provided only once`);
      options[key] = value;
      index += 1;
    } else {
      throw new Error(`unknown option: ${option}`);
    }
  }
  requireValue(options.outputDirectory, "--output-directory is required");
  return options;
}


function requireReleaseVersion(version, developmentProbe) {
  if (developmentProbe) return;
  const parsed = parseCoreVersion(version);
  const baseline = parseCoreVersion(standaloneCompatibilityBaselineVersion);
  const isNewer = parsed.major > baseline.major
    || (parsed.major === baseline.major && parsed.minor > baseline.minor)
    || (parsed.major === baseline.major && parsed.minor === baseline.minor && parsed.patch > baseline.patch);
  requireValue(
    isNewer,
    `release version must be newer than v${standaloneCompatibilityBaselineVersion}; use --development-probe for local artifacts`,
  );
}


function parseCoreVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  requireValue(match !== null, `release version is not valid semver: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}


async function requirePackageIdentity(sourceRoot, manifest) {
  const [packageManifest, packageLock] = await Promise.all([
    readJsonSource(sourceRoot, "package.json"),
    readJsonSource(sourceRoot, "package-lock.json"),
  ]);
  requireValue(packageManifest.name === manifest.name, "package name differs from plugin name");
  requireValue(packageManifest.version === manifest.version, "package version differs from plugin version");
  requireValue(packageLock.name === manifest.name, "package lock name differs from plugin name");
  requireValue(packageLock.version === manifest.version, "package lock version differs from plugin version");
  requireValue(packageLock.packages?.[""]?.name === manifest.name, "package lock root name differs from plugin name");
  requireValue(packageLock.packages?.[""]?.version === manifest.version, "package lock root version differs from plugin version");
}


function requireAllowedPaths(relativePaths) {
  requireValue(relativePaths.length === new Set(relativePaths).size, "release whitelist contains duplicates");
  for (const relativePath of relativePaths) {
    requireValue(relativePath === relativePath.replaceAll("\\", "/"), `release path must use forward slashes: ${relativePath}`);
    requireValue(!path.posix.isAbsolute(relativePath), `release path must be relative: ${relativePath}`);
    requireValue(!relativePath.split("/").includes(".."), `release path escapes its root: ${relativePath}`);
    requireValue(!forbiddenArchivePath.test(relativePath), `release path is forbidden: ${relativePath}`);
  }
}


async function readSourceFiles(sourceRoot, relativePaths) {
  return Promise.all(relativePaths.map(async (relativePath) => ({
    relativePath,
    content: await readSourceFile(sourceRoot, relativePath),
  })));
}


async function readJsonSource(sourceRoot, relativePath) {
  return JSON.parse((await readSourceFile(sourceRoot, relativePath)).toString("utf8"));
}


async function readSourceFile(sourceRoot, relativePath) {
  const sourcePath = path.resolve(sourceRoot, ...relativePath.split("/"));
  requireInside(sourceRoot, sourcePath);
  await requirePathWithoutLinks(sourceRoot, relativePath);
  const metadata = await lstat(sourcePath);
  requireValue(metadata.isFile(), `release source is not a regular file: ${relativePath}`);
  return normalizeReleaseText(relativePath, await readFile(sourcePath));
}


export function normalizeReleaseText(relativePath, content) {
  const baseName = path.posix.basename(relativePath);
  const extension = path.posix.extname(baseName).toLowerCase();
  requireValue(
    allowedReleaseTextNames.has(baseName) || allowedReleaseTextExtensions.has(extension),
    `release source has an unsupported text file type: ${relativePath}`,
  );
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  return Buffer.from(text.replace(/\r\n/g, "\n"), "utf8");
}


async function requirePathWithoutLinks(sourceRoot, relativePath) {
  let currentPath = sourceRoot;
  for (const component of relativePath.split("/")) {
    currentPath = path.join(currentPath, component);
    const metadata = await lstat(currentPath);
    requireValue(
      !metadata.isSymbolicLink(),
      `release source contains a symbolic link, junction, or reparse point: ${relativePath}`,
    );
  }
}


async function requireDirectoryWithoutLinks(directory, label) {
  const metadata = await lstat(directory);
  requireValue(!metadata.isSymbolicLink(), `${label} is a symbolic link, junction, or reparse point`);
  requireValue(metadata.isDirectory(), `${label} is not a directory`);
  const resolved = await realpath(directory);
  requireValue(path.resolve(resolved) === path.resolve(directory), `${label} resolves through a symbolic link, junction, or reparse point`);
}


function createSharedPythonEvidence(standaloneSources, pluginSources) {
  const standalone = new Map(standaloneSources.map((entry) => [entry.relativePath, entry.content]));
  const plugin = new Map(pluginSources.map((entry) => [entry.relativePath, entry.content]));
  return Object.fromEntries(sharedCoreFileNames.map((name) => {
    const standalonePath = `scripts/${name}`;
    const pluginPath = `dist/scripts/${name}`;
    const standaloneHash = sha256(standalone.get(standalonePath));
    const pluginHash = sha256(plugin.get(pluginPath));
    requireValue(standaloneHash === pluginHash, `shared Python core differs: ${name}`);
    return [name, { pluginPath, sha256: standaloneHash, standalonePath }];
  }));
}


async function requirePluginRuntimeMatchesSource(sourceRoot, pluginSources) {
  const plugin = new Map(pluginSources.map((entry) => [entry.relativePath, entry.content]));
  for (const name of runtimeFileNames) {
    const source = await readSourceFile(sourceRoot, `scripts/${name}`);
    const built = plugin.get(`dist/scripts/${name}`);
    requireValue(built?.equals(source), `Plugin Python runtime differs from source: ${name}`);
  }
}


async function requireAbsentOutputs(outputPaths) {
  for (const outputPath of outputPaths) {
    const metadata = await lstatOrNull(outputPath);
    requireValue(metadata === null, `release artifact already exists: ${outputPath}`);
  }
}


export async function publishArtifactSet(entries, {
  writeArtifact = writeNewFile,
  removeArtifact = removeNewFile,
} = {}) {
  const attempted = [];
  try {
    for (const { outputPath, content } of entries) {
      attempted.push(outputPath);
      await writeArtifact(outputPath, content);
    }
  } catch (error) {
    const cleanupErrors = [];
    for (const outputPath of attempted.reverse()) {
      try {
        await removeArtifact(outputPath);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `release artifact publication failed and rollback left files under ${path.dirname(attempted[0])}`,
      );
    }
    throw error;
  }
}


async function writeNewFile(outputPath, content) {
  const handle = await open(outputPath, "wx", 0o644);
  let failure = null;
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], `release artifact write and close failed: ${outputPath}`) : error;
  }
  if (failure) {
    try {
      await removeNewFile(outputPath);
    } catch (cleanupError) {
      throw new AggregateError(
        [failure, cleanupError],
        `release artifact write failed and cleanup left a file: ${outputPath}`,
      );
    }
    throw failure;
  }
}


async function removeNewFile(outputPath) {
  await rm(outputPath, { force: false });
}


function createStoredZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;
  for (const { name, content } of [...entries].sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ))) {
    const nameBytes = Buffer.from(name, "utf8");
    const checksum = crc32(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x0021, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    const localRecord = Buffer.concat([localHeader, nameBytes, content]);
    localRecords.push(localRecord);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x0021, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(Buffer.concat([centralHeader, nameBytes]));
    localOffset += localRecord.length;
  }

  requireValue(entries.length <= 0xffff, "release archive has too many files");
  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}


const crcTable = Object.freeze(Array.from({ length: 256 }, (_unused, value) => {
  let result = value;
  for (let bit = 0; bit < 8; bit += 1) {
    result = (result & 1) ? (0xedb88320 ^ (result >>> 1)) : (result >>> 1);
  }
  return result >>> 0;
}));


function crc32(content) {
  let checksum = 0xffffffff;
  for (const value of content) {
    checksum = crcTable[(checksum ^ value) & 0xff] ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}


function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}


function requireInside(root, target) {
  const relative = path.relative(root, target);
  requireValue(relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative), `release path escapes source root: ${target}`);
}


async function lstatOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}


function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}


const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  await main();
}
