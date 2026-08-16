import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { acquireFileLockOwnership } from "../mcp/file-lock-ownership.mjs";
import { readLatestFencedFileSnapshot } from "../mcp/file-lock-ownership.mjs";
import { StableFileSnapshotError } from "../mcp/stable-file-snapshot.mjs";
import { latestCommittedRecordPath } from "./support/fenced-record-fixture.mjs";


const WORKER_PATH = fileURLToPath(new URL("./support/file-lock-owner-worker.mjs", import.meta.url));


test("a former owner cannot remove a replacement lock during release", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-lock-ownership-"));
  const recordPath = path.join(root, "record.json");
  const lockPath = path.join(root, "record.lock");
  const unavailableError = () => Object.assign(new Error("state unavailable"), {
    code: "state_unavailable",
  });
  let ownership;
  try {
    ownership = await acquireFileLockOwnership({
      recordPath,
      lockPath,
      maxRecordBytes: 1024,
      retries: 0,
      unavailableError,
    });
    await rm(lockPath, { recursive: true });
    await mkdir(lockPath);

    await assert.rejects(ownership.assertOwned(), errorWithCode("state_unavailable"));
    await assert.rejects(ownership.release(), errorWithCode("state_unavailable"));
    await access(lockPath);
  } finally {
    await rm(root, { recursive: true });
  }
});


test("a former owner cannot publish after a successor takes over", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-lock-fencing-"));
  const recordPath = path.join(root, "record.json");
  const lockPath = path.join(root, "record.lock");
  const unavailableError = () => Object.assign(new Error("state unavailable"), {
    code: "state_unavailable",
  });
  let ownership;
  try {
    await writeFile(recordPath, "initial\n", "utf8");
    ownership = await acquireFileLockOwnership({
      recordPath,
      lockPath,
      maxRecordBytes: 1024,
      retries: 0,
      unavailableError,
    });
    await ownership.replaceSnapshot(Buffer.from("former owner\n", "utf8"));

    await ownership.assertOwned();
    await rename(lockPath, `${lockPath}.former-owner`);
    assert.deepEqual(await runSuccessor(recordPath, lockPath), { status: "ok" });

    await assert.rejects(
      ownership.replaceSnapshot(Buffer.from("former owner again\n", "utf8")),
      errorWithCode("state_unavailable"),
    );
    await assert.rejects(ownership.release(), errorWithCode("state_unavailable"));
    assert.equal(
      (await readLatestFencedFileSnapshot(recordPath, { maxBytes: 1024 })).toString("utf8"),
      "successor\n",
    );
  } finally {
    await rm(root, { recursive: true });
  }
});


test("an initialized record never falls back to a legacy snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-lock-no-fallback-"));
  const recordPath = path.join(root, "record.json");
  const lockPath = path.join(root, "record.lock");
  const unavailableError = () => Object.assign(new Error("state unavailable"), {
    code: "state_unavailable",
  });
  try {
    await writeFile(recordPath, "legacy\n", "utf8");
    const ownership = await acquireFileLockOwnership({
      recordPath,
      lockPath,
      maxRecordBytes: 1024,
      retries: 0,
      unavailableError,
    });
    await ownership.replaceSnapshot(Buffer.from("current\n", "utf8"));
    await ownership.release();
    const committedRecordPath = await latestCommittedRecordPath(recordPath);
    await rm(path.dirname(committedRecordPath), { recursive: true });

    await assert.rejects(
      readLatestFencedFileSnapshot(recordPath, { maxBytes: 1024 }),
      (error) => error instanceof StableFileSnapshotError && error.kind === "invalid",
    );
  } finally {
    await rm(root, { recursive: true });
  }
});


async function runSuccessor(recordPath, lockPath) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_PATH, recordPath, lockPath, "successor"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 || stderr !== "") {
        reject(new Error(`worker failed (${code}): ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}


function errorWithCode(code) {
  return (error) => error instanceof Error && error.code === code;
}
