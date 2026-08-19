import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listChangedFiles,
  writeGitHubOutput,
} from "../../scripts/test-smart.mjs";


function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}


test("local change detection includes branch commits, working tree changes, and untracked files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-smart-regression-"));
  try {
    git(root, "init");
    git(root, "config", "user.email", "tests@example.invalid");
    git(root, "config", "user.name", "Test Runner");
    await writeFile(path.join(root, "base.txt"), "base\n", "utf8");
    git(root, "add", "base.txt");
    git(root, "commit", "-m", "base");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");

    await writeFile(path.join(root, "committed.txt"), "committed\n", "utf8");
    git(root, "add", "committed.txt");
    git(root, "commit", "-m", "branch change");
    await writeFile(path.join(root, "base.txt"), "working tree\n", "utf8");
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "untracked.txt"), "untracked\n", "utf8");

    assert.deepEqual(listChangedFiles({ cwd: root, env: {} }), [
      "base.txt",
      "committed.txt",
      "nested/untracked.txt",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("local change detection fails when origin/main has no merge base", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-smart-regression-"));
  try {
    git(root, "init");
    git(root, "config", "user.email", "tests@example.invalid");
    git(root, "config", "user.name", "Test Runner");
    await writeFile(path.join(root, "tracked.txt"), "tracked\n", "utf8");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "initial");

    assert.throws(
      () => listChangedFiles({ cwd: root, env: {} }),
      /cannot resolve smart regression base from origin\/main/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("GitHub output remains valid when no tests are selected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-smart-output-"));
  const outputPath = path.join(root, "github-output.txt");
  try {
    writeGitHubOutput({
      outputPath,
      plan: { suites: [], checks: [], platforms: ["linux"] },
      execution: { node: [], python: [] },
    });

    assert.equal(await readFile(outputPath, "utf8"), [
      'matrix=["ubuntu-latest"]',
      "has_tests=false",
      "has_node=false",
      "has_python=false",
      "needs_build=false",
      "needs_plugin_check=false",
      "",
    ].join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("rename detection keeps both the source and destination paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-smart-rename-"));
  try {
    git(root, "init");
    git(root, "config", "user.email", "tests@example.invalid");
    git(root, "config", "user.name", "Test Runner");
    await mkdir(path.join(root, "web"));
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "web", "editor-runtime.mjs"), "export default 1;\n", "utf8");
    git(root, "add", ".");
    git(root, "commit", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");
    git(root, "mv", "web/editor-runtime.mjs", "docs/editor-runtime.mjs");
    git(root, "commit", "-m", "move runtime");
    const head = git(root, "rev-parse", "HEAD");

    assert.deepEqual(
      listChangedFiles({ cwd: root, base, head, env: { GITHUB_ACTIONS: "true" } }),
      ["docs/editor-runtime.mjs", "web/editor-runtime.mjs"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("a new branch push resolves a zero before SHA from origin/main", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-smart-zero-base-"));
  try {
    git(root, "init");
    git(root, "config", "user.email", "tests@example.invalid");
    git(root, "config", "user.name", "Test Runner");
    await writeFile(path.join(root, "base.txt"), "base\n", "utf8");
    git(root, "add", ".");
    git(root, "commit", "-m", "base");
    git(root, "branch", "-M", "main");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    await writeFile(path.join(root, "changed.txt"), "changed\n", "utf8");
    git(root, "add", ".");
    git(root, "commit", "-m", "branch change");
    const head = git(root, "rev-parse", "HEAD");

    assert.deepEqual(
      listChangedFiles({
        cwd: root,
        base: "0000000000000000000000000000000000000000",
        head,
        env: { GITHUB_ACTIONS: "true" },
      }),
      ["changed.txt"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("a CI base expression can use the remote default branch without a local branch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-smart-remote-base-"));
  try {
    git(root, "init");
    git(root, "config", "user.email", "tests@example.invalid");
    git(root, "config", "user.name", "Test Runner");
    await writeFile(path.join(root, "base.txt"), "base\n", "utf8");
    git(root, "add", ".");
    git(root, "commit", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");
    git(root, "branch", "-M", "feature");
    git(root, "update-ref", "refs/remotes/origin/main", base);
    await writeFile(path.join(root, "changed.txt"), "changed\n", "utf8");
    git(root, "add", ".");
    git(root, "commit", "-m", "feature change");
    const head = git(root, "rev-parse", "HEAD");

    assert.deepEqual(
      listChangedFiles({ cwd: root, base: "origin/main", head, env: { GITHUB_ACTIONS: "true" } }),
      ["changed.txt"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("explicit CI endpoints preserve non-fast-forward changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-smart-non-fast-forward-"));
  try {
    git(root, "init");
    git(root, "config", "user.email", "tests@example.invalid");
    git(root, "config", "user.name", "Test Runner");
    await writeFile(path.join(root, "base.txt"), "base\n", "utf8");
    git(root, "add", ".");
    git(root, "commit", "-m", "base");
    await writeFile(path.join(root, "removed-by-rewind.txt"), "changed\n", "utf8");
    git(root, "add", ".");
    git(root, "commit", "-m", "old tip");
    const oldTip = git(root, "rev-parse", "HEAD");
    const rewoundHead = git(root, "rev-parse", "HEAD^");

    assert.deepEqual(
      listChangedFiles({
        cwd: root,
        base: oldTip,
        head: rewoundHead,
        env: { GITHUB_ACTIONS: "true" },
      }),
      ["removed-by-rewind.txt"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
