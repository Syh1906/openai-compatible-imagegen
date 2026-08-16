import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  acquireFileLockOwnership,
  readLatestFencedFileSnapshot,
} from "./file-lock-ownership.mjs";
import {
  StableFileSnapshotError,
} from "./stable-file-snapshot.mjs";


const SCHEMA_VERSION = "project-binding.v1";
const BINDING_HASH_PATTERN = /^[0-9a-f]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_RECORD_BYTES = 4096;


export class ProjectBindingStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProjectBindingStoreError";
    this.code = code;
  }
}


export function createProjectBindingStore({ stateRoot }) {
  if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)) {
    throw new TypeError("stateRoot must be an absolute path");
  }
  const resolvedStateRoot = path.resolve(stateRoot);
  const bindingsRoot = path.join(resolvedStateRoot, "project-bindings");

  return Object.freeze({ bind, require: requireBinding });

  async function bind(value) {
    const requested = normalizeRecord(value);
    const scope = await prepareRecordScope(bindingsRoot, requested.bindingHash);
    return await withRecordLock(scope, async (ownership) => {
      let existing = await readRecord(scope.recordPath, {
        required: false,
        expectedBindingHash: requested.bindingHash,
      }, ownership);
      if (existing === null) {
        await ownership.replaceSnapshot(Buffer.from(serializeRecord(requested), "utf8"));
        return { status: "created", record: requested };
      }
      if (!samePath(existing.projectRoot, requested.projectRoot)) {
        throw stateError("project_binding_conflict");
      }
      if (sameConfigSnapshot(existing, requested)) {
        return { status: "unchanged", record: existing };
      }
      await replaceRecord(scope.recordPath, existing, requested, ownership);
      return { status: "rebound", record: requested };
    });
  }

  async function requireBinding(bindingHash) {
    requireBindingHash(bindingHash);
    const scope = recordScope(bindingsRoot, bindingHash);
    return await readRecord(scope.recordPath, {
      required: true,
      expectedBindingHash: bindingHash,
    });
  }
}


async function withRecordLock(scope, callback) {
  let ownership;
  let result;
  let failure;
  try {
    await requireSafeLockPath(scope.lockPath);
    ownership = await acquireFileLockOwnership({
      recordPath: scope.recordPath,
      lockPath: scope.lockPath,
      maxRecordBytes: MAX_RECORD_BYTES,
      retries: { retries: 80, factor: 1, minTimeout: 10, maxTimeout: 50 },
      unavailableError: unavailableState,
      invalidError: invalidState,
    });
    await ownership.assertOwned();
    result = await callback(ownership);
    await ownership.assertOwned();
  } catch (error) {
    failure = error instanceof ProjectBindingStoreError
      ? error
      : stateError("project_binding_unavailable");
  }
  if (ownership) {
    try {
      await ownership.release();
    } catch {
      if (!failure) failure = stateError("project_binding_unavailable");
    }
  }
  if (failure) throw failure;
  return result;
}


async function requireSafeLockPath(lockPath) {
  try {
    const metadata = await lstat(lockPath);
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || !samePath(await realpath(lockPath), lockPath)
    ) {
      throw stateError("project_binding_state_invalid");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error instanceof ProjectBindingStoreError) throw error;
    throw stateError("project_binding_unavailable");
  }
}


function unavailableState() {
  return stateError("project_binding_unavailable");
}


function invalidState() {
  return stateError("project_binding_state_invalid");
}


async function prepareRecordScope(bindingsRoot, bindingHash) {
  requireBindingHash(bindingHash);
  await ensureCanonicalDirectory(path.dirname(bindingsRoot));
  await ensureCanonicalDirectory(bindingsRoot);
  const bindingDirectory = path.join(bindingsRoot, bindingHash);
  await ensureCanonicalDirectory(bindingDirectory);
  return recordScope(bindingsRoot, bindingHash);
}


function recordScope(bindingsRoot, bindingHash) {
  const bindingDirectory = path.join(bindingsRoot, bindingHash);
  return {
    recordPath: path.join(bindingDirectory, "binding.json"),
    lockPath: path.join(bindingDirectory, "binding.lock"),
  };
}


async function ensureCanonicalDirectory(directory) {
  try {
    await mkdir(directory, { recursive: false, mode: 0o700 }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw stateError("project_binding_state_invalid");
    }
    const canonical = await realpath(directory);
    if (!samePath(canonical, directory)) {
      throw stateError("project_binding_state_invalid");
    }
  } catch (error) {
    if (error instanceof ProjectBindingStoreError) throw error;
    throw stateError("project_binding_unavailable");
  }
}


async function readRecord(recordPath, { required, expectedBindingHash }, ownership = null) {
  let bytes;
  try {
    bytes = ownership
      ? await ownership.readSnapshot()
      : await readLatestFencedFileSnapshot(recordPath, { maxBytes: MAX_RECORD_BYTES });
  } catch (error) {
    if (error instanceof StableFileSnapshotError && error.kind === "invalid") {
      throw stateError("project_binding_state_invalid");
    }
    throw stateError("project_binding_unavailable");
  }
  if (bytes === null) {
    if (required) throw stateError("project_binding_missing");
    return null;
  }
  try {
    const record = parseRecord(bytes);
    if (record.bindingHash !== expectedBindingHash) {
      throw stateError("project_binding_state_invalid");
    }
    return record;
  } catch (error) {
    if (error instanceof ProjectBindingStoreError) throw error;
    throw stateError("project_binding_state_invalid");
  }
}


async function replaceRecord(recordPath, expected, replacement, ownership) {
  try {
    const current = await readRecord(recordPath, {
      required: true,
      expectedBindingHash: expected.bindingHash,
    }, ownership);
    if (
      !samePath(current.projectRoot, expected.projectRoot)
      || !sameConfigSnapshot(current, expected)
    ) {
      throw stateError("project_binding_conflict");
    }
    await ownership.replaceSnapshot(Buffer.from(serializeRecord(replacement), "utf8"));
  } catch (error) {
    if (error instanceof ProjectBindingStoreError) throw error;
    throw stateError("project_binding_unavailable");
  }
}


function parseRecord(bytes) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw stateError("project_binding_state_invalid");
  }
  return normalizeRecord(value);
}


function normalizeRecord(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw stateError("project_binding_state_invalid");
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "bindingHash",
    "projectConfigSha256",
    "projectRoot",
    "schemaVersion",
    "userConfigSha256",
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw stateError("project_binding_state_invalid");
  }
  if (
    value.schemaVersion !== SCHEMA_VERSION
    || !BINDING_HASH_PATTERN.test(value.bindingHash)
    || typeof value.projectRoot !== "string"
    || !path.isAbsolute(value.projectRoot)
    || !SHA256_PATTERN.test(value.userConfigSha256)
    || (value.projectConfigSha256 !== null && !SHA256_PATTERN.test(value.projectConfigSha256))
  ) {
    throw stateError("project_binding_state_invalid");
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    bindingHash: value.bindingHash,
    projectRoot: path.resolve(value.projectRoot),
    userConfigSha256: value.userConfigSha256,
    projectConfigSha256: value.projectConfigSha256,
  });
}


function serializeRecord(record) {
  return `${JSON.stringify(record)}\n`;
}


function sameConfigSnapshot(left, right) {
  return left.userConfigSha256 === right.userConfigSha256
    && left.projectConfigSha256 === right.projectConfigSha256;
}


function requireBindingHash(value) {
  if (typeof value !== "string" || !BINDING_HASH_PATTERN.test(value)) {
    throw stateError("project_binding_state_invalid");
  }
}


function stateError(code) {
  return new ProjectBindingStoreError(code);
}


function samePath(left, right) {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  return normalizedLeft === normalizedRight;
}


function normalizePath(value) {
  const normalized = path.resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
