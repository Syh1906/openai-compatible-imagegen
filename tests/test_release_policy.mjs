import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compareReleaseArtifactDirectories } from "../scripts/compare-release-artifacts.mjs";
import { validateReleaseNotes } from "../scripts/validate-release-notes.mjs";


const validNotes = `OpenAI-Compatible Images 1.0.1 protects local configuration and artifact data while adding a versioned Plugin ZIP installation path.

## Highlights

- Protect local configuration and artifact directories with repository-local ignore rules.

## Install

Follow the [v1.0.1 installation guide](https://github.com/Syh1906/openai-compatible-imagegen/blob/v1.0.1/docs/guides/installation.md) and verify every archive with \`SHA256SUMS\`.

## Known limitations

- Codex may restore the result card after switching tasks; use **Continue editing** to reopen the preserved draft.
`;


test("release notes require a versioned public body and frozen changelog entry", async (t) => {
  const root = await createReleaseFixture(t);

  const result = await validateReleaseNotes({ projectRoot: root, releaseTag: "v1.0.1" });

  assert.deepEqual(result, {
    ok: true,
    releaseTag: "v1.0.1",
    version: "1.0.1",
    notesPath: ".github/release-notes/v1.0.1.md",
  });
});


test("release notes reject the one-line tag annotation shape", async (t) => {
  const root = await createReleaseFixture(t, { notes: "OpenAI-Compatible Images 1.0.1\n" });

  await assert.rejects(
    validateReleaseNotes({ projectRoot: root, releaseTag: "v1.0.1" }),
    /Highlights.*Install.*Known limitations/is,
  );
});


test("release notes reject a version that remains only under Unreleased", async (t) => {
  const root = await createReleaseFixture(t, {
    changelog: "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Pending change.\n",
  });

  await assert.rejects(
    validateReleaseNotes({ projectRoot: root, releaseTag: "v1.0.1" }),
    /changelog.*1\.0\.1/i,
  );
});


test("release artifact comparison accepts byte-identical candidate directories", async (t) => {
  const { left, right } = await createArtifactFixture(t);

  const result = await compareReleaseArtifactDirectories(left, right);

  assert.deepEqual(result.files, ["SHA256SUMS", "plugin.zip"]);
});


test("release artifact comparison rejects a changed artifact", async (t) => {
  const { left, right } = await createArtifactFixture(t);
  await writeFile(path.join(right, "plugin.zip"), "remote bytes", "utf8");

  await assert.rejects(
    compareReleaseArtifactDirectories(left, right),
    /plugin\.zip.*differs/i,
  );
});


test("release artifact comparison rejects an extra or missing artifact", async (t) => {
  const { left, right } = await createArtifactFixture(t);
  await writeFile(path.join(right, "unexpected.zip"), "unexpected", "utf8");

  await assert.rejects(
    compareReleaseArtifactDirectories(left, right),
    /file sets differ.*unexpected\.zip/i,
  );
});


async function createReleaseFixture(t, { notes = validNotes, changelog } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".github", "release-notes"), { recursive: true });
  await writeFile(path.join(root, ".github", "release-notes", "v1.0.1.md"), notes, "utf8");
  await writeFile(
    path.join(root, "CHANGELOG.md"),
    changelog ?? "# Changelog\n\n## [Unreleased]\n\n## [1.0.1] - 2026-08-18\n\n### Added\n\n- Released change.\n\n[1.0.1]: https://github.com/Syh1906/openai-compatible-imagegen/compare/v1.0.0...v1.0.1\n",
    "utf8",
  );
  return root;
}


async function createArtifactFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-compare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const left = path.join(root, "left");
  const right = path.join(root, "right");
  await Promise.all([mkdir(left), mkdir(right)]);
  await Promise.all([
    writeFile(path.join(left, "plugin.zip"), "plugin bytes", "utf8"),
    writeFile(path.join(right, "plugin.zip"), "plugin bytes", "utf8"),
    writeFile(path.join(left, "SHA256SUMS"), "checksum", "utf8"),
    writeFile(path.join(right, "SHA256SUMS"), "checksum", "utf8"),
  ]);
  return { left, right };
}
