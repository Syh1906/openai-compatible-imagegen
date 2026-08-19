import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  pluginAdapterFileNames,
  runtimeFileNames,
  sharedCoreFileNames,
  standaloneAdapterFileNames,
  standaloneRuntimeFileNames,
} from "../scripts/plugin-file-set.mjs";
import {
  normalizeReleaseFile,
  normalizeReleaseText,
  publishArtifactSet,
} from "../scripts/build-release-artifacts.mjs";


const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const buildScript = fileURLToPath(new URL("../scripts/build-release-artifacts.mjs", import.meta.url));
const releaseWorkflow = fileURLToPath(new URL("../.github/workflows/release-artifacts.yml", import.meta.url));
const pluginId = "openai-compatible-imagegen";
const archiveRoot = `${pluginId}/`;
const sharedCoreFiles = [
  "image_alpha.py",
  "image_emissive_alpha.py",
  "image_download.py",
  "image_mask_alpha.py",
  "image_png.py",
  "image_preview.py",
  "image_qa.py",
  "image_resize.py",
  "image_response.py",
  "image_transaction.py",
  "image_transparency.py",
  "image_transport.py",
  "image_webp.py",
  "provider_config.py",
];
const standaloneRuntimeFiles = [
  ...sharedCoreFiles,
  "image_batch.py",
  "image_cli.py",
  "image_postprocess.py",
  "image_reference.py",
  "image_transparency_runtime.py",
  "imagegen.py",
].sort();
const standaloneFiles = [
  ".gitignore",
  "LICENSE",
  "SKILL.md",
  "agents/openai.yaml",
  "examples/auth.example.json",
  "examples/batch.example.jsonl",
  "references/parameters.md",
  "references/postprocess.md",
  "references/prompting.md",
  "references/qa.md",
  ...standaloneRuntimeFiles.map((name) => `scripts/${name}`),
  "scripts/quick-init.py",
].sort();
const pluginFiles = [
  ".agents/plugins/marketplace.json",
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "LICENSE",
  "assets/icon.png",
  "dist/server.mjs",
  "dist/widget/index.html",
  ...runtimeFileNames.map((name) => `dist/scripts/${name}`),
  `skills/${pluginId}/SKILL.md`,
  `skills/${pluginId}/references/config.example.json`,
].sort();


test("package scripts expose the release artifact builder", async () => {
  const packageManifest = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(
    packageManifest.scripts["build:release"],
    "npm run build && node scripts/build-release-artifacts.mjs",
  );
});


test("release workflow publishes an exact version-titled release from an annotated tag", async () => {
  const workflow = await readFile(releaseWorkflow, "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /os:\s*windows-latest/);
  assert.match(workflow, /os:\s*ubuntu-latest/);
  assert.match(workflow, /os:\s*macos-latest/);
  assert.match(workflow, /runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/);
  assert.match(workflow, /environment:\s*release/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*write/);
  assert.match(workflow, /ref:\s*\$\{\{\s*inputs\.release_ref\s*\}\}/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.equal(workflow.match(/uses:\s*actions\/setup-node@v4/g)?.length, 3);
  for (const command of [
    "npm ci",
    "npm run build",
    "npm test",
    "npm run check",
    "node scripts/build-release-artifacts.mjs",
  ]) {
    assert.ok(workflow.includes(command), command);
  }
  assert.match(workflow, /git cat-file -t/);
  assert.match(workflow, /plugin\.json[^\n]+\.version/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /validate-release-notes\.mjs/);
  assert.match(workflow, /candidate-windows/);
  assert.match(workflow, /candidate-linux/);
  assert.match(workflow, /candidate-macos/);
  assert.match(workflow, /^\s{2}compare_candidates:/m);
  assert.match(workflow, /compare-release-artifacts\.mjs/);
  assert.match(
    workflow,
    /publish:\s*\n\s+needs:\s*\[[^\]]*compare_candidates[^\]]*\][\s\S]*?environment:\s*release/,
  );
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /name:\s*Create the GitHub Release[\s\S]*?shell:\s*bash[\s\S]*?gh release create/);
  assert.match(workflow, /--verify-tag/);
  assert.match(workflow, /--title "\$RELEASE_TAG"/);
  assert.match(workflow, /--notes-file "\$RELEASE_NOTES_PATH"/);
  assert.doesNotMatch(workflow, /--notes-from-tag/);
  assert.doesNotMatch(workflow, /git tag|git push/i);
});


test("Standalone releases remain independent from Plugin filesystem adapters", async () => {
  const pluginOnlyRuntimeNames = [
    "artifact_repository.py",
    "posix_repository_fs.py",
    "repository_fs.py",
    "repository_fs_helper.py",
    "windows_repository_fs.py",
  ];
  for (const name of pluginOnlyRuntimeNames) {
    assert.equal(standaloneFiles.includes(`scripts/${name}`), false, name);
  }
  for (const relativePath of standaloneFiles.filter((name) => name.startsWith("scripts/"))) {
    const source = await readFile(path.join(projectRoot, relativePath), "utf8");
    assert.doesNotMatch(source, /(?:artifact_repository|repository_fs|\bmcp\b)/, relativePath);
  }
});


test("shared prompting guidance keeps API retry permission Standalone-only", async () => {
  const prompting = await readFile(path.join(projectRoot, "references/prompting.md"), "utf8");
  const pluginSkill = await readFile(
    path.join(projectRoot, "skills/openai-compatible-imagegen/SKILL.md"),
    "utf8",
  );
  assert.match(prompting, /Standalone adapter/i);
  assert.match(prompting, /Plugin adapter/i);
  assert.match(prompting, /never[^.]*second[^.]*API request/i);
  assert.match(pluginSkill, /Even if policy contains `allow_api_retry`, do not request the image API again/);
});


test("release file sets separate shared core from distribution adapters", () => {
  assert.deepEqual([...sharedCoreFileNames].sort(), [...sharedCoreFiles].sort());
  assert.deepEqual(
    [...standaloneRuntimeFileNames].sort(),
    [...new Set([...sharedCoreFileNames, ...standaloneAdapterFileNames])].sort(),
  );
  assert.equal(
    new Set([...sharedCoreFileNames, ...standaloneAdapterFileNames, ...pluginAdapterFileNames]).size,
    runtimeFileNames.length,
  );
  assert.deepEqual(
    [...new Set([...sharedCoreFileNames, ...standaloneAdapterFileNames, ...pluginAdapterFileNames])].sort(),
    [...runtimeFileNames].sort(),
  );
});


test("Standalone release carries a Git ignore rule for local auth", async (t) => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-ignore-"));
  const gitRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-git-"));
  t.after(async () => Promise.all([
    rm(outputDirectory, { recursive: true, force: true }),
    rm(gitRoot, { recursive: true, force: true }),
  ]));

  const result = await runBuild(outputDirectory, projectRoot, { developmentProbe: true });
  const archiveName = result.files.find((name) => name.includes("development-skill-"));
  const archive = readStoredZip(await readFile(path.join(outputDirectory, archiveName)));
  const ignore = archive.get(`${archiveRoot}.gitignore`);
  assert.ok(ignore);
  const extractedRoot = path.join(gitRoot, pluginId);
  await mkdir(extractedRoot);
  await writeFile(path.join(extractedRoot, ".gitignore"), ignore);
  await writeFile(path.join(extractedRoot, "auth.json"), "{}\n");
  await execFileAsync("git", ["init", "--quiet", gitRoot]);
  await execFileAsync("git", ["-C", gitRoot, "check-ignore", "--quiet", `${pluginId}/auth.json`]);
});


test("release mode rejects a development version instead of publishing a regressive Standalone artifact", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-development-fixture-"));
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-version-"));
  t.after(async () => Promise.all([
    rm(fixtureRoot, { recursive: true, force: true }),
    rm(outputDirectory, { recursive: true, force: true }),
  ]));
  await copyBuilderFixture(fixtureRoot);
  await setFixtureVersion(fixtureRoot, "0.1.0+codex.20260816024439");
  await assert.rejects(
    runBuild(outputDirectory, fixtureRoot),
    /release version must be newer than v0\.3\.0|development-probe/i,
  );
  assert.deepEqual(await readdir(outputDirectory), []);
});


test("release mode rejects baseline metadata and publishes clean artifacts for the next patch", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-boundary-fixture-"));
  const rejectedOutput = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-boundary-rejected-"));
  const acceptedOutput = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-boundary-accepted-"));
  t.after(async () => Promise.all([
    rm(fixtureRoot, { recursive: true, force: true }),
    rm(rejectedOutput, { recursive: true, force: true }),
    rm(acceptedOutput, { recursive: true, force: true }),
  ]));

  await copyBuilderFixture(fixtureRoot);
  await setFixtureVersion(fixtureRoot, "0.3.0+metadata");
  await assert.rejects(
    runBuild(rejectedOutput, fixtureRoot),
    /release version must be newer than v0\.3\.0/,
  );
  assert.deepEqual(await readdir(rejectedOutput), []);

  await setFixtureVersion(fixtureRoot, "0.3.1");
  const result = await runBuild(acceptedOutput, fixtureRoot);
  assert.equal(result.ok, true);
  assert.equal(result.version, "0.3.1");
  assert.deepEqual(result.files, [
    "SHA256SUMS",
    "openai-compatible-imagegen-codex-plugin-0.3.1.zip",
    "openai-compatible-imagegen-shared-python-sha256-0.3.1.json",
    "openai-compatible-imagegen-skill-0.3.1.zip",
  ]);
  for (const name of result.files) assert.doesNotMatch(name, /development/i);
  assert.deepEqual((await readdir(acceptedOutput)).sort(), result.files);
});


test("the release source builds the current v1.1.0 artifact set", async (t) => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-candidate-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));

  const result = await runBuild(outputDirectory);

  assert.equal(result.version, "1.1.0");
  assert.deepEqual(result.files, [
    "SHA256SUMS",
    "openai-compatible-imagegen-codex-plugin-1.1.0.zip",
    "openai-compatible-imagegen-shared-python-sha256-1.1.0.json",
    "openai-compatible-imagegen-skill-1.1.0.zip",
  ]);
  assert.deepEqual((await readdir(outputDirectory)).sort(), result.files);
});


test("release artifact publication rolls back files created before a later write fails", async (t) => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-rollback-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const entries = [
    { outputPath: path.join(outputDirectory, "first.zip"), content: Buffer.from("first") },
    { outputPath: path.join(outputDirectory, "second.zip"), content: Buffer.from("second") },
  ];
  let writes = 0;

  await assert.rejects(
    publishArtifactSet(entries, {
      writeArtifact: async (outputPath, content) => {
        writes += 1;
        await writeFile(outputPath, content, { flag: "wx" });
        if (writes === 2) throw new Error("injected second write failure");
      },
    }),
    /injected second write failure/,
  );
  assert.deepEqual(await readdir(outputDirectory), []);
});


test("release artifact rollback ignores absent targets but aggregates real cleanup failures", async () => {
  const writeFailure = new Error("injected write failure");
  await assert.rejects(
    publishArtifactSet([
      { outputPath: path.join(os.tmpdir(), "never-created.zip"), content: Buffer.alloc(0) },
    ], {
      writeArtifact: async () => { throw writeFailure; },
      removeArtifact: async () => {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      },
    }),
    (error) => error === writeFailure,
  );

  const cleanupFailure = new Error("injected cleanup failure");
  await assert.rejects(
    publishArtifactSet([
      { outputPath: path.join(os.tmpdir(), "cleanup-fails.zip"), content: Buffer.alloc(0) },
    ], {
      writeArtifact: async () => { throw writeFailure; },
      removeArtifact: async () => { throw cleanupFailure; },
    }),
    (error) => error instanceof AggregateError
      && error.errors[0] === writeFailure
      && error.errors[1] === cleanupFailure,
  );
});


test("release text normalization accepts only known UTF-8 text types and preserves lone carriage returns", () => {
  assert.throws(
    () => normalizeReleaseText("assets/payload.bin", Buffer.from([0xff, 0x00, 0x0d, 0x0a])),
    /unsupported text file type/i,
  );
  assert.throws(
    () => normalizeReleaseText("references/invalid.md", Buffer.from([0xc3, 0x28])),
    /encoded data|utf-?8/i,
  );
  assert.deepEqual(
    normalizeReleaseText("references/line-endings.md", Buffer.from("\ufefffirst\r\nsecond\rthird\n", "utf8")),
    Buffer.from("\ufefffirst\nsecond\rthird\n", "utf8"),
  );
});


test("release file normalization preserves supported PNG assets byte for byte", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  assert.deepEqual(normalizeReleaseFile("assets/icon.png", png), png);
  assert.throws(
    () => normalizeReleaseFile("assets/payload.bin", png),
    /unsupported release file type/i,
  );
});


test("release builder creates exact, reproducible standalone and plugin archives with shared-core evidence", async (t) => {
  const firstOutput = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-first-"));
  const secondOutput = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-second-"));
  t.after(async () => Promise.all([
    rm(firstOutput, { recursive: true, force: true }),
    rm(secondOutput, { recursive: true, force: true }),
  ]));

  const first = await runBuild(firstOutput, projectRoot, { developmentProbe: true });
  const second = await runBuild(secondOutput, projectRoot, { developmentProbe: true });

  assert.equal(first.ok, true);
  assert.equal(first.plugin, pluginId);
  assert.equal(first.version, second.version);
  assert.equal(first.sharedPythonFiles, sharedCoreFiles.length);
  assert.deepEqual(first.files, second.files);

  const firstArtifacts = await readArtifacts(firstOutput, first.files);
  const secondArtifacts = await readArtifacts(secondOutput, second.files);
  const firstHashes = hashesOf(firstArtifacts);
  assert.deepEqual(firstHashes, hashesOf(secondArtifacts));
  await assert.rejects(
    runBuild(firstOutput, projectRoot, { developmentProbe: true }),
    /already exists/i,
  );
  assert.deepEqual(hashesOf(await readArtifacts(firstOutput, first.files)), firstHashes);

  const standaloneName = `openai-compatible-imagegen-development-skill-${first.version}.zip`;
  const pluginName = `openai-compatible-imagegen-development-codex-plugin-${first.version}.zip`;
  const evidenceName = `openai-compatible-imagegen-development-shared-python-sha256-${first.version}.json`;
  const checksumName = "SHA256SUMS";
  assert.ok(first.files.includes(standaloneName));
  assert.ok(first.files.includes(pluginName));
  assert.ok(first.files.includes(evidenceName));
  assert.ok(first.files.includes(checksumName));
  assert.ok(standaloneName);
  assert.ok(pluginName);
  assert.ok(evidenceName);
  await requireStandardZipReader([
    path.join(firstOutput, standaloneName),
    path.join(firstOutput, pluginName),
  ]);

  const standaloneEntries = readStoredZip(firstArtifacts[standaloneName]);
  const pluginEntries = readStoredZip(firstArtifacts[pluginName]);
  assert.deepEqual([...standaloneEntries.keys()].sort(), standaloneFiles.map((name) => archiveRoot + name));
  assert.deepEqual([...pluginEntries.keys()].sort(), pluginFiles.map((name) => archiveRoot + name));

  const forbidden = /(^|\/)(auth\.json|\.local|verification-scratch|node_modules|__pycache__|cache|test-results?|coverage)(\/|$)/i;
  for (const archivePath of [...standaloneEntries.keys(), ...pluginEntries.keys()]) {
    assert.doesNotMatch(archivePath, forbidden);
  }
  assert.equal([...pluginEntries.keys()].some((name) => name.includes("/web/")), false);

  const evidence = JSON.parse(firstArtifacts[evidenceName].toString("utf8"));
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.plugin, pluginId);
  assert.deepEqual(Object.keys(evidence.sharedPython).sort(), [...sharedCoreFiles].sort());
  for (const name of sharedCoreFiles) {
    const standalonePath = `${archiveRoot}scripts/${name}`;
    const pluginPath = `${archiveRoot}dist/scripts/${name}`;
    const standaloneHash = sha256(standaloneEntries.get(standalonePath));
    const pluginHash = sha256(pluginEntries.get(pluginPath));
    assert.equal(standaloneHash, pluginHash, name);
    assert.deepEqual(evidence.sharedPython[name], {
      pluginPath: `dist/scripts/${name}`,
      sha256: standaloneHash,
      standalonePath: `scripts/${name}`,
    });
  }

  const checksumEntries = Object.fromEntries(
    firstArtifacts[checksumName].toString("utf8").trim().split("\n").map((line) => {
      const match = /^([0-9a-f]{64})  ([^/\\]+)$/.exec(line);
      assert.ok(match, line);
      return [match[2], match[1]];
    }),
  );
  assert.deepEqual(checksumEntries, Object.fromEntries(
    [standaloneName, pluginName, evidenceName]
      .sort()
      .map((name) => [name, sha256(firstArtifacts[name])]),
  ));
});


test("release builder rejects a junction in an explicitly selected source tree", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-source-"));
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-junction-output-"));
  t.after(async () => Promise.all([
    rm(fixtureRoot, { recursive: true, force: true }),
    rm(outputDirectory, { recursive: true, force: true }),
  ]));

  for (const relativePath of [
    "package.json",
    "package-lock.json",
    ...new Set([...standaloneFiles, ...pluginFiles].filter((name) => !name.startsWith("scripts/"))),
  ]) {
    const destination = path.join(fixtureRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(projectRoot, relativePath), destination);
  }
  await symlink(path.join(projectRoot, "scripts"), path.join(fixtureRoot, "scripts"), "junction");

  await assert.rejects(
    runBuild(outputDirectory, fixtureRoot),
    /symbolic link|junction|reparse/i,
  );
});


test("release builder rejects a stale Plugin-only Python runtime", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-stale-runtime-"));
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-stale-output-"));
  t.after(async () => Promise.all([
    rm(fixtureRoot, { recursive: true, force: true }),
    rm(outputDirectory, { recursive: true, force: true }),
  ]));

  for (const relativePath of new Set([
    "package.json",
    "package-lock.json",
    ...standaloneFiles,
    ...pluginFiles,
    ...runtimeFileNames.map((name) => `scripts/${name}`),
  ])) {
    const destination = path.join(fixtureRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(projectRoot, relativePath), destination);
  }
  await writeFile(
    path.join(fixtureRoot, "dist/scripts/image_runtime.py"),
    "# stale Plugin runtime\n",
    "utf8",
  );

  await assert.rejects(
    runBuild(outputDirectory, fixtureRoot, { developmentProbe: true }),
    /Plugin Python runtime differs from source: image_runtime\.py/,
  );
});


test("development probe archives normalize text line endings before hashing", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-eol-fixture-"));
  const baselineOutput = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-eol-baseline-"));
  const variantOutput = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-eol-variant-"));
  t.after(async () => Promise.all([
    rm(fixtureRoot, { recursive: true, force: true }),
    rm(baselineOutput, { recursive: true, force: true }),
    rm(variantOutput, { recursive: true, force: true }),
  ]));

  await copyBuilderFixture(fixtureRoot);
  const fixtureFiles = new Set([
    "package.json",
    "package-lock.json",
    ...standaloneFiles,
    ...pluginFiles,
    ...runtimeFileNames.map((name) => `scripts/${name}`),
  ]);
  for (const relativePath of [...fixtureFiles].filter((name) => !name.endsWith(".png"))) {
    const target = path.join(fixtureRoot, relativePath);
    const content = (await readFile(target, "utf8")).replace(/\r?\n/g, "\r\n");
    await writeFile(target, content, "utf8");
  }

  const baseline = await runBuild(baselineOutput, projectRoot, { developmentProbe: true });
  const variant = await runBuild(variantOutput, fixtureRoot, { developmentProbe: true });
  assert.deepEqual(
    hashesOf(await readArtifacts(baselineOutput, baseline.files)),
    hashesOf(await readArtifacts(variantOutput, variant.files)),
  );
});


async function runBuild(outputDirectory, sourceRoot = projectRoot, { developmentProbe = false } = {}) {
  const args = [
    buildScript,
    "--source-root",
    sourceRoot,
    "--output-directory",
    outputDirectory,
  ];
  if (developmentProbe) args.push("--development-probe");
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: projectRoot,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim());
}


async function copyBuilderFixture(fixtureRoot) {
  const files = new Set([
    "package.json",
    "package-lock.json",
    ...standaloneFiles,
    ...pluginFiles,
    ...runtimeFileNames.map((name) => `scripts/${name}`),
  ]);
  for (const relativePath of files) {
    const destination = path.join(fixtureRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(projectRoot, relativePath), destination);
  }
}


async function setFixtureVersion(fixtureRoot, version) {
  const pluginManifestPath = path.join(fixtureRoot, ".codex-plugin/plugin.json");
  const packageManifestPath = path.join(fixtureRoot, "package.json");
  const packageLockPath = path.join(fixtureRoot, "package-lock.json");
  const pluginManifest = JSON.parse(await readFile(pluginManifestPath, "utf8"));
  const packageManifest = JSON.parse(await readFile(packageManifestPath, "utf8"));
  const packageLock = JSON.parse(await readFile(packageLockPath, "utf8"));
  pluginManifest.version = version;
  packageManifest.version = version;
  packageLock.version = version;
  packageLock.packages[""].version = version;
  await Promise.all([
    writeFile(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`, "utf8"),
    writeFile(packageManifestPath, `${JSON.stringify(packageManifest, null, 2)}\n`, "utf8"),
    writeFile(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`, "utf8"),
  ]);
}


function hashesOf(artifacts) {
  return Object.fromEntries(Object.entries(artifacts).map(([name, value]) => [name, sha256(value)]));
}


async function requireStandardZipReader(archivePaths) {
  await execFileAsync("python", [
    "-c",
    "import sys, zipfile\nfor value in sys.argv[1:]:\n    with zipfile.ZipFile(value) as archive:\n        assert archive.testzip() is None\n        assert archive.namelist() == sorted(archive.namelist())",
    ...archivePaths,
  ]);
}


async function readArtifacts(outputDirectory, names) {
  return Object.fromEntries(await Promise.all(names.map(async (name) => [
    name,
    await readFile(path.join(outputDirectory, name)),
  ])));
}


function readStoredZip(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compression = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    assert.equal(compression, 0, "release ZIP entries must use deterministic store mode");
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
    entries.set(name, buffer.subarray(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  assert.equal(entries.size > 0, true);
  return entries;
}


function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
