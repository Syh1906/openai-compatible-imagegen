import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  StableFileSnapshotError,
  readStableFileSnapshot,
} from "../../mcp/stable-file-snapshot.mjs";


test("a missing record returns null", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-stable-snapshot-"));
  try {
    const recordPath = path.join(root, "missing.json");
    assert.equal(
      await readStableFileSnapshot(recordPath, { maxBytes: 4096 }),
      null,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});


test("a dangling record link is invalid instead of missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-stable-snapshot-"));
  const recordPath = path.join(root, "record.json");
  try {
    await symlink(path.join(root, "missing.json"), recordPath, "file");
    await assert.rejects(
      readStableFileSnapshot(recordPath, { maxBytes: 4096 }),
      (error) => error instanceof StableFileSnapshotError && error.kind === "invalid",
    );
  } finally {
    await rm(root, { recursive: true });
  }
});


test("a dangling record directory link is invalid instead of missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-stable-snapshot-"));
  const recordPath = path.join(root, "record.json");
  try {
    await symlink(path.join(root, "missing-directory"), recordPath, "dir");
    await assert.rejects(
      readStableFileSnapshot(recordPath, { maxBytes: 4096 }),
      (error) => error instanceof StableFileSnapshotError && error.kind === "invalid",
    );
  } finally {
    await rm(root, { recursive: true });
  }
});
