import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, renameSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import lockfile from "proper-lockfile";

import { readLatestFencedFileSnapshot } from "../../mcp/file-lock-ownership.mjs";
import {
  ProjectBindingStoreError,
  createProjectBindingStore,
} from "../../mcp/project-binding-store.mjs";
import { latestCommittedRecordPath } from "../support/fenced-record-fixture.mjs";


const MODULE_PATH = fileURLToPath(new URL("../../mcp/project-binding-store.mjs", import.meta.url));
const THIS_TEST_PATH = fileURLToPath(import.meta.url);
const READ_RACE_WORKER_PATH = fileURLToPath(
  new URL("../support/project-binding-read-race-worker.mjs", import.meta.url),
);
const READ_RACE_TIMEOUT_MS = 10_000;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CONFIG_HASH = "c".repeat(64);


if (process.argv[2] === "--bind-worker") {
  await runBindWorker();
} else if (process.argv[2] === "--rebind-worker") {
  await runRebindWorker();
} else if (process.argv[2] === "--require-worker") {
  await runRequireWorker();
} else {
  test("stored binding must claim the binding hash selected by its directory", async () => {
    await withStoreRoots(async ({ stateRoot, projectA }) => {
      const store = createProjectBindingStore({ stateRoot });
      await store.bind(record(HASH_A, projectA));
      const recordPath = await latestCommittedRecordPath(bindingPath(stateRoot, HASH_A));
      const stored = JSON.parse(await readFile(recordPath, "utf8"));
      stored.bindingHash = HASH_B;
      await writeFile(recordPath, `${JSON.stringify(stored)}\n`);

      await assert.rejects(
        store.require(HASH_A),
        (error) => error instanceof ProjectBindingStoreError
          && error.code === "project_binding_state_invalid",
      );
    });
  });


  test("concurrent first binds publish one complete record and reject the other project", async () => {
    await withStoreRoots(async ({ stateRoot, projectA, projectB }) => {
      for (let round = 0; round < 12; round += 1) {
        const bindingHash = round.toString(16).padStart(64, "0");
        const startAt = Date.now() + 250;
        const [left, right] = await Promise.all([
          spawnBindWorker({ stateRoot, bindingHash, projectRoot: projectA, startAt }),
          spawnBindWorker({ stateRoot, bindingHash, projectRoot: projectB, startAt }),
        ]);
        const outcomes = [left, right].map(parseWorkerOutcome);
        const statuses = outcomes.map((outcome) => outcome.status).sort();
        assert.deepEqual(
          statuses,
          ["created", "project_binding_conflict"],
          `round ${round}: ${JSON.stringify(outcomes)}`,
        );

        const bytes = await readFile(await latestCommittedRecordPath(bindingPath(stateRoot, bindingHash)));
        const stored = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        assert.equal(stored.bindingHash, bindingHash);
        assert.ok(stored.projectRoot === path.resolve(projectA) || stored.projectRoot === path.resolve(projectB));
      }
    });
  });


  test("concurrent rebinds never make readers observe a torn binding snapshot", async () => {
    await withStoreRoots(async ({ stateRoot, projectA }) => {
      const bindingHash = "f".repeat(64);
      await createProjectBindingStore({ stateRoot }).bind(record(bindingHash, projectA));
      const startAt = Date.now() + 250;
      const [writer, reader] = await Promise.all([
        spawnStoreWorker("--rebind-worker", {
          stateRoot,
          bindingHash,
          projectRoot: projectA,
          startAt,
          rounds: 400,
        }),
        spawnStoreWorker("--require-worker", {
          stateRoot,
          bindingHash,
          projectRoot: projectA,
          startAt,
          rounds: 1200,
        }),
      ]);
      assert.deepEqual(parseWorkerOutcome(writer), { status: "ok" });
      assert.deepEqual(parseWorkerOutcome(reader), { status: "ok" });
    });
  });


  test("a reader retries when its selected epoch is retired", async () => {
    await withStoreRoots(async ({ stateRoot, projectA }) => {
      const store = createProjectBindingStore({ stateRoot });
      await store.bind(record(HASH_A, projectA));
      const reader = spawnPausedReadRaceWorker({
        stateRoot,
        bindingHash: HASH_A,
        pauseAt: "committed-list",
      });
      await reader.ready;
      let outcome;
      try {
        await store.bind(record(HASH_A, projectA, { projectConfigSha256: HASH_B }));
        await store.bind(record(HASH_A, projectA));
      } finally {
        reader.resume();
        outcome = await reader.completed;
      }
      assert.deepEqual(outcome, { status: "ok" });
    });
  });


  test("a reader retries when its epoch disappears after metadata validation", async () => {
    await withStoreRoots(async ({ stateRoot, projectA }) => {
      const store = createProjectBindingStore({ stateRoot });
      await store.bind(record(HASH_A, projectA));
      const reader = spawnPausedReadRaceWorker({
        stateRoot,
        bindingHash: HASH_A,
        pauseAt: "epoch-directory",
      });
      await reader.ready;
      let outcome;
      try {
        await store.bind(record(HASH_A, projectA, { projectConfigSha256: HASH_B }));
        await store.bind(record(HASH_A, projectA));
      } finally {
        reader.resume();
        outcome = await reader.completed;
      }
      assert.deepEqual(outcome, { status: "ok" });
    });
  });


  test("a reader rejects a missing current epoch after metadata validation", async () => {
    await withStoreRoots(async ({ stateRoot, projectA }) => {
      const store = createProjectBindingStore({ stateRoot });
      await store.bind(record(HASH_A, projectA));
      const reader = spawnPausedReadRaceWorker({
        stateRoot,
        bindingHash: HASH_A,
        pauseAt: "epoch-directory",
      });
      await reader.ready;
      let outcome;
      try {
        const recordPath = await latestCommittedRecordPath(bindingPath(stateRoot, HASH_A));
        await rm(path.dirname(recordPath), { recursive: true });
      } finally {
        reader.resume();
        outcome = await reader.completed;
      }
      assert.deepEqual(outcome, { status: "project_binding_state_invalid" });
    });
  });


  test("requiring a missing project binding does not create state directories", async () => {
    await withStoreRoots(async ({ stateRoot }) => {
      const store = createProjectBindingStore({ stateRoot });
      await assert.rejects(
        store.require(HASH_A),
        errorWithCode("project_binding_missing"),
      );
      await assert.rejects(
        access(path.join(stateRoot, "project-bindings")),
        errorWithCode("ENOENT"),
      );
    });
  });


  test("a dangling project binding record is invalid", async () => {
    await withStoreRoots(async ({ stateRoot, projectA }) => {
      const store = createProjectBindingStore({ stateRoot });
      await store.bind(record(HASH_A, projectA));
      const recordPath = await latestCommittedRecordPath(bindingPath(stateRoot, HASH_A));
      await rm(recordPath);
      await symlink(path.join(path.dirname(stateRoot), "missing.json"), recordPath, "file");
      await assert.rejects(
        store.require(HASH_A),
        errorWithCode("project_binding_state_invalid"),
      );
    });
  });


  test("a linked state root cannot create project binding directories outside the state root", async () => {
    await withStoreRoots(async ({ stateRoot, projectA }) => {
      const externalRoot = path.join(path.dirname(stateRoot), "external-state");
      const linkedStateRoot = path.join(path.dirname(stateRoot), "linked-state");
      await mkdir(externalRoot);
      await symlink(
        externalRoot,
        linkedStateRoot,
        process.platform === "win32" ? "junction" : "dir",
      );
      await assert.rejects(
        createProjectBindingStore({ stateRoot: linkedStateRoot }).bind(record(HASH_A, projectA)),
        errorWithCode("project_binding_state_invalid"),
      );
      await assert.rejects(
        access(path.join(externalRoot, "project-bindings")),
        errorWithCode("ENOENT"),
      );
    });
  });


  test("a lock compromised at publication cannot create a project binding", async () => {
    await withStoreRoots(async ({ stateRoot, projectA }) => {
      const lockPath = bindingLockPath(stateRoot, HASH_A);
      await withSerializationCompromise("project-binding.v1", () => {
        renameSync(lockPath, `${lockPath}.former-owner`);
        mkdirSync(lockPath);
      }, async () => {
        await assert.rejects(
          createProjectBindingStore({ stateRoot }).bind(record(HASH_A, projectA)),
          errorWithCode("project_binding_unavailable"),
        );
      });
      assert.equal(
        await readLatestFencedFileSnapshot(bindingPath(stateRoot, HASH_A), { maxBytes: 4096 }),
        null,
      );
    });
  });
}


async function runBindWorker() {
  const [, , , stateRoot, bindingHash, projectRoot, startAtText] = process.argv;
  const startAt = Number(startAtText);
  const delay = startAt - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  const { createProjectBindingStore: createStore } = await import(pathToFileURL(MODULE_PATH).href);
  try {
    const result = await createStore({ stateRoot }).bind(record(bindingHash, projectRoot));
    process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: error?.code ?? "unexpected_error" })}\n`);
  }
}


async function runRebindWorker() {
  const [, , , stateRoot, bindingHash, projectRoot, startAtText, roundsText] = process.argv;
  await waitUntil(Number(startAtText));
  const store = createProjectBindingStore({ stateRoot });
  try {
    for (let index = 0; index < Number(roundsText); index += 1) {
      await store.bind(record(bindingHash, projectRoot, {
        projectConfigSha256: index % 2 === 0 ? HASH_B : null,
      }));
    }
    process.stdout.write(`${JSON.stringify({ status: "ok" })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: error?.code ?? "unexpected_error" })}\n`);
  }
}


async function runRequireWorker() {
  const [, , , stateRoot, bindingHash, , startAtText, roundsText] = process.argv;
  await waitUntil(Number(startAtText));
  const store = createProjectBindingStore({ stateRoot });
  try {
    for (let index = 0; index < Number(roundsText); index += 1) {
      await store.require(bindingHash);
    }
    process.stdout.write(`${JSON.stringify({ status: "ok" })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: error?.code ?? "unexpected_error" })}\n`);
  }
}


async function spawnBindWorker({ stateRoot, bindingHash, projectRoot, startAt }) {
  return await spawnStoreWorker("--bind-worker", {
    stateRoot,
    bindingHash,
    projectRoot,
    startAt,
  });
}


async function spawnStoreWorker(mode, {
  stateRoot,
  bindingHash,
  projectRoot,
  startAt,
  rounds = 1,
}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      THIS_TEST_PATH,
      mode,
      stateRoot,
      bindingHash,
      projectRoot,
      String(startAt),
      String(rounds),
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}


function spawnPausedReadRaceWorker({ stateRoot, bindingHash, pauseAt }) {
  const child = spawn(process.execPath, [READ_RACE_WORKER_PATH, stateRoot, bindingHash, pauseAt], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let readyResolved = false;
  let resumed = false;
  let resolveReady;
  let rejectReady;
  let resolveCompleted;
  let rejectCompleted;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const readyTimeout = setTimeout(() => {
    rejectReady(new Error("race worker timed out before selecting an epoch"));
    child.kill();
  }, READ_RACE_TIMEOUT_MS);
  readyTimeout.unref();
  let completionTimeout = null;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!readyResolved && stdout.startsWith("ready\n")) {
      readyResolved = true;
      clearTimeout(readyTimeout);
      resolveReady();
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", (error) => {
    clearTimeout(readyTimeout);
    if (completionTimeout !== null) clearTimeout(completionTimeout);
    if (readyResolved) rejectCompleted(error);
    else rejectReady(error);
  });
  child.on("close", (code) => {
    clearTimeout(readyTimeout);
    if (completionTimeout !== null) clearTimeout(completionTimeout);
    if (!readyResolved) {
      const error = new Error(`race worker closed before ready (${code}): ${stderr}`);
      rejectReady(error);
      return;
    }
    if (code !== 0 || stderr !== "") {
      rejectCompleted(new Error(`race worker failed (${code}): ${stderr}`));
      return;
    }
    resolveCompleted(JSON.parse(stdout.trim().split("\n").at(-1)));
  });
  return {
    ready,
    completed,
    resume: () => {
      if (resumed) return;
      resumed = true;
      completionTimeout = setTimeout(() => {
        rejectCompleted(new Error("race worker timed out after resuming"));
        child.kill();
      }, READ_RACE_TIMEOUT_MS);
      completionTimeout.unref();
      child.stdin.end("continue\n");
    },
  };
}


async function waitUntil(startAt) {
  const delay = startAt - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}


function parseWorkerOutcome(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}


async function withStoreRoots(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-project-binding-store-"));
  const stateRoot = path.join(root, "state");
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  await Promise.all([mkdir(stateRoot), mkdir(projectA), mkdir(projectB)]);
  try {
    await callback({ stateRoot, projectA, projectB });
  } finally {
    await rm(root, { recursive: true });
  }
}


function record(bindingHash, projectRoot, { projectConfigSha256 = null } = {}) {
  return {
    schemaVersion: "project-binding.v1",
    bindingHash,
    projectRoot,
    userConfigSha256: CONFIG_HASH,
    projectConfigSha256,
  };
}


function bindingPath(stateRoot, bindingHash) {
  return path.join(stateRoot, "project-bindings", bindingHash, "binding.json");
}


function bindingLockPath(stateRoot, bindingHash) {
  return path.join(stateRoot, "project-bindings", bindingHash, "binding.lock");
}


function errorWithCode(code) {
  return (error) => error instanceof Error && error.code === code;
}


async function withSerializationCompromise(schemaVersion, compromise, callback) {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  let fired = false;
  Object.defineProperty(Object.prototype, "toJSON", {
    configurable: true,
    value() {
      if (!fired && this.schemaVersion === schemaVersion) {
        fired = true;
        compromise();
      }
      return Object.assign(Object.create(null), this);
    },
  });
  try {
    await callback();
    assert.equal(fired, true);
  } finally {
    if (original) Object.defineProperty(Object.prototype, "toJSON", original);
    else delete Object.prototype.toJSON;
  }
}
