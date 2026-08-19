import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pathContainsSymbolicLink } from "../mcp/filesystem-path-safety.mjs";


test("Windows short-path aliases are not treated as symbolic links", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "imagegen-path-safety-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  assert.equal(await pathContainsSymbolicLink(directory), false);
});


test("the macOS system temporary-directory alias is not treated as a project link", {
  skip: process.platform !== "darwin",
}, async () => {
  assert.equal(await pathContainsSymbolicLink(os.tmpdir()), false);
});


test("a junction in the selected path is treated as a symbolic link", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-path-safety-link-"));
  const target = path.join(root, "target");
  const linked = path.join(root, "linked");
  await mkdir(target);
  await mkdir(path.join(target, "child"));
  await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  t.after(async () => rm(root, { recursive: true, force: true }));

  assert.equal(await pathContainsSymbolicLink(linked), true);
  assert.equal(await pathContainsSymbolicLink(path.join(linked, "child")), true);
});
