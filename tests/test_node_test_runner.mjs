import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listNodeTestFiles } from "../scripts/run-node-tests.mjs";


test("Node test discovery is explicit, sorted, and shell independent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-node-tests-"));
  try {
    await Promise.all([
      writeFile(path.join(root, "test_z.mjs"), "", "utf8"),
      writeFile(path.join(root, "test_a.mjs"), "", "utf8"),
      writeFile(path.join(root, "helper.mjs"), "", "utf8"),
      mkdir(path.join(root, "test_directory.mjs")),
    ]);

    assert.deepEqual(await listNodeTestFiles(root), [
      path.join(root, "test_a.mjs"),
      path.join(root, "test_z.mjs"),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
