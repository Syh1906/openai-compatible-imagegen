import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

import { parseEditorDraft } from "./editor-draft-contract.mjs";
import { pathContainsSymbolicLink } from "./filesystem-path-safety.mjs";

import {
  createEditorSessionId,
  editorStateError,
  normalizeImageInput,
  normalizeSessionInput,
  normalizeStatusesInput,
} from "./editor-state-registry.mjs";
import {
  acquireFileLockOwnership,
  readLatestFencedFileSnapshot,
} from "./file-lock-ownership.mjs";
import {
  StableFileSnapshotError,
} from "./stable-file-snapshot.mjs";


const SCHEMA_VERSION = "editor-state.v1";
const SESSION_ID_PATTERN = /^eds_[0-9a-f]{32}$/;
const IMAGE_ID_PATTERN = /^img_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_IMAGES = 1024;
const MAX_SESSIONS = 4096;
const mutationQueues = new Map();


export function createFileEditorStateRegistry({ idFactory = createEditorSessionId } = {}) {
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");

  return Object.freeze({ open, getSession, saveDraft, destroy, finalize, getCanvasStatuses });

  async function open(input) {
    const request = normalizeImageInput(input);
    return await withRecord(input, async (record, save) => {
      let image = record.images.find((item) => item.imageId === request.imageId);
      if (image?.canvasStatus === "destroyed") throw editorStateError("image_canvas_destroyed", "当前图片的画布已经销毁。");
      if (!image) {
        if (record.images.length >= MAX_IMAGES) invalidState();
        image = { imageId: request.imageId, canvasStatus: "available", sessionIds: [], draft: null };
        record.images.push(image);
      }
      const id = idFactory();
      if (!SESSION_ID_PATTERN.test(id) || findSession(record, id) || countSessions(record) >= MAX_SESSIONS) {
        throw new TypeError("idFactory must return a unique eds_ ID with 32 lowercase hex characters");
      }
      image.sessionIds.push(id);
      const draft = image.draft;
      image.draft = null;
      await save(record);
      return sessionResult(id, image.imageId, "active", draft);
    });
  }

  async function getSession(input) {
    const request = normalizeSessionInput(input);
    const record = await readOnlyRecord(input);
    const found = findSession(record, request.editorSessionId);
    return found
      ? sessionResult(request.editorSessionId, found.image.imageId, found.image.canvasStatus === "destroyed" ? "destroyed" : "active")
      : null;
  }

  async function saveDraft(input) {
    const request = normalizeSessionInput(input);
    const draft = normalizeDraft(input?.draft);
    return await withRecord(input, async (record, save) => {
      const found = findSession(record, request.editorSessionId);
      if (!found) return null;
      if (found.image.canvasStatus === "destroyed") {
        throw editorStateError("image_canvas_destroyed", "当前图片的画布已经销毁。");
      }
      found.image.draft = draft;
      await save(record);
      return sessionResult(request.editorSessionId, found.image.imageId, "active");
    });
  }

  async function destroy(input) {
    const request = normalizeSessionInput(input);
    return await withRecord(input, async (record, save) => {
      const found = findSession(record, request.editorSessionId);
      if (!found) return null;
      if (found.image.canvasStatus !== "destroyed") {
        found.image.canvasStatus = "destroyed";
        found.image.draft = null;
        await save(record);
      }
      return sessionResult(request.editorSessionId, found.image.imageId, "destroyed");
    });
  }

  async function finalize(input) {
    const request = normalizeSessionInput(input);
    return await withRecord(input, async (record, save) => {
      const found = findSession(record, request.editorSessionId);
      if (!found) return null;
      found.image.sessionIds.splice(found.sessionIndex, 1);
      if (found.image.canvasStatus === "available" && found.image.sessionIds.length === 0 && !found.image.draft) {
        record.images.splice(found.imageIndex, 1);
      }
      await save(record);
      return sessionResult(request.editorSessionId, found.image.imageId, "released");
    });
  }

  async function getCanvasStatuses(input) {
    const request = normalizeStatusesInput(input);
    const record = await readOnlyRecord(input);
    return request.imageIds.map((imageId) => (
      record.images.find((item) => item.imageId === imageId)?.canvasStatus === "destroyed"
        ? "destroyed"
        : "available"
    ));
  }
}


async function withRecord(input, callback) {
  const queueKey = mutationQueueKey(input);
  if (queueKey === null) return await withFileLock(input, callback);
  const previous = mutationQueues.get(queueKey) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  mutationQueues.set(queueKey, current);
  await previous;
  try {
    return await withFileLock(input, callback);
  } finally {
    release();
    if (mutationQueues.get(queueKey) === current) mutationQueues.delete(queueKey);
  }
}


async function withFileLock(input, callback) {
  let scope;
  let ownership;
  let result;
  let failure;
  try {
    scope = await prepareScope(input, { create: true });
    await requireSafeLockPath(scope.lockPath);
    ownership = await acquireFileLockOwnership({
      recordPath: scope.recordPath,
      lockPath: scope.lockPath,
      maxRecordBytes: MAX_RECORD_BYTES,
      retries: { retries: 80, factor: 1, minTimeout: 10, maxTimeout: 50 },
      unavailableError: unavailableState,
      invalidError: invalidStateError,
    });
    await ownership.assertOwned();
    const record = await readRecord(scope, ownership);
    await ownership.assertOwned();
    result = await callback(record, async (next) => {
      await ownership.assertOwned();
      await writeRecord(scope, next, ownership);
      await ownership.assertOwned();
    });
    await ownership.assertOwned();
  } catch (error) {
    failure = normalizeFailure(error);
  }
  if (ownership) {
    try {
      await ownership.release();
    } catch {
      if (!failure) failure = editorStateError("editor_state_unavailable", "画布状态暂时不可用。");
    }
  }
  if (failure) throw failure;
  return result;
}


function mutationQueueKey(input) {
  if (typeof input?.artifactRoot !== "string" || typeof input?.bindingKey !== "string") return null;
  return `${path.resolve(input.artifactRoot)}\0${input.bindingKey}`;
}


function unavailableState() {
  return editorStateError("editor_state_unavailable", "画布状态暂时不可用。");
}


async function readOnlyRecord(input) {
  const scope = await prepareScope(input, { create: false });
  return scope.stateMissing ? emptyRecord(scope.bindingKey) : await readRecord(scope);
}


async function prepareScope(input, { create }) {
  if (typeof input?.artifactRoot !== "string" || !path.isAbsolute(input.artifactRoot)) invalidState();
  const bindingKey = input.bindingKey;
  const artifactRoot = path.resolve(input.artifactRoot);
  await requireCanonicalDirectory(artifactRoot, { create: false });
  const runtimeDirectory = path.join(artifactRoot, ".runtime");
  const stateDirectory = path.join(runtimeDirectory, "editor-state");
  const bindingsDirectory = path.join(stateDirectory, "bindings");
  const locksDirectory = path.join(stateDirectory, "locks");
  let stateMissing = false;
  for (const directory of [runtimeDirectory, stateDirectory, bindingsDirectory, locksDirectory]) {
    if (stateMissing) break;
    const exists = await requireCanonicalDirectory(directory, {
      create,
      allowMissing: !create,
    });
    stateMissing = !exists;
  }
  const recordKey = createHash("sha256").update(bindingKey, "utf8").digest("hex");
  return {
    bindingKey,
    bindingsDirectory,
    stateMissing,
    recordPath: path.join(bindingsDirectory, `${recordKey}.json`),
    lockPath: path.join(locksDirectory, `${recordKey}.lock`),
  };
}


async function readRecord(scope, ownership = null) {
  let bytes;
  try {
    bytes = ownership
      ? await ownership.readSnapshot()
      : await readLatestFencedFileSnapshot(scope.recordPath, { maxBytes: MAX_RECORD_BYTES });
  } catch (error) {
    if (error instanceof StableFileSnapshotError && error.kind === "invalid") invalidState();
    throw unavailableState();
  }
  if (bytes === null) return emptyRecord(scope.bindingKey);
  try {
    return validateRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), scope.bindingKey);
  } catch (error) {
    if (error?.code === "editor_state_invalid") throw error;
    invalidState();
  }
}


async function writeRecord(scope, record, ownership) {
  const validated = validateRecord(record, scope.bindingKey);
  const bytes = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
  if (bytes.length > MAX_RECORD_BYTES) invalidState();
  try {
    await ownership.replaceSnapshot(bytes);
  } catch (error) {
    if (error?.code === "editor_state_invalid") throw error;
    throw editorStateError("editor_state_unavailable", "画布状态暂时不可用。");
  }
}


function validateRecord(value, bindingKey) {
  if (!plainObject(value) || !exactKeys(value, ["bindingKey", "images", "schemaVersion"])) invalidState();
  if (value.schemaVersion !== SCHEMA_VERSION || value.bindingKey !== bindingKey || !Array.isArray(value.images) || value.images.length > MAX_IMAGES) {
    invalidState();
  }
  const imageIds = new Set();
  const sessionIds = new Set();
  for (const image of value.images) {
    if (
      !plainObject(image)
      || !exactKeys(image, image.draft === undefined
        ? ["canvasStatus", "imageId", "sessionIds"]
        : ["canvasStatus", "draft", "imageId", "sessionIds"])
      || !IMAGE_ID_PATTERN.test(image.imageId)
      || !["available", "destroyed"].includes(image.canvasStatus)
      || !Array.isArray(image.sessionIds)
      || (image.canvasStatus === "available" && image.sessionIds.length === 0 && !image.draft)
      || imageIds.has(image.imageId)
    ) invalidState();
    image.draft = image.draft === undefined ? null : normalizeDraft(image.draft, { allowNull: true });
    imageIds.add(image.imageId);
    for (const id of image.sessionIds) {
      if (!SESSION_ID_PATTERN.test(id) || sessionIds.has(id)) invalidState();
      sessionIds.add(id);
    }
  }
  if (sessionIds.size > MAX_SESSIONS) invalidState();
  return value;
}


async function requireCanonicalDirectory(directory, { create, allowMissing = false }) {
  try {
    if (create) await mkdir(directory, { recursive: false, mode: 0o700 }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await pathContainsSymbolicLink(directory)) invalidState();
  } catch (error) {
    if (error?.code === "editor_state_invalid") throw error;
    if (error?.code === "ENOENT" && allowMissing) return false;
    if (error?.code === "ENOENT") invalidState();
    throw editorStateError("editor_state_unavailable", "画布状态暂时不可用。");
  }
  return true;
}


async function requireSafeLockPath(lockPath) {
  try {
    const metadata = await lstat(lockPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await pathContainsSymbolicLink(lockPath)) {
      invalidState();
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error?.code === "editor_state_invalid") throw error;
    throw editorStateError("editor_state_unavailable", "画布状态暂时不可用。");
  }
}


function emptyRecord(bindingKey) {
  return { schemaVersion: SCHEMA_VERSION, bindingKey, images: [] };
}


function findSession(record, editorSessionId) {
  for (let imageIndex = 0; imageIndex < record.images.length; imageIndex += 1) {
    const image = record.images[imageIndex];
    const sessionIndex = image.sessionIds.indexOf(editorSessionId);
    if (sessionIndex !== -1) return { image, imageIndex, sessionIndex };
  }
  return null;
}


function countSessions(record) {
  return record.images.reduce((count, image) => count + image.sessionIds.length, 0);
}


function sessionResult(id, imageId, status, draft = null) {
  return Object.freeze({ id, imageId, status, ...(draft ? { draft: structuredClone(draft) } : {}) });
}

function normalizeDraft(value, { allowNull = false } = {}) {
  try {
    return parseEditorDraft(value, { allowNull });
  } catch {
    invalidState();
  }
}


function exactKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}


function plainObject(value) {
  return Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
}


function normalizeFailure(error) {
  if (error?.code === "editor_state_invalid" || error?.code === "editor_state_unavailable" || error?.code === "image_canvas_destroyed") {
    return error;
  }
  if (error instanceof TypeError) return error;
  return editorStateError("editor_state_unavailable", "画布状态暂时不可用。");
}


function invalidState() {
  throw invalidStateError();
}


function invalidStateError() {
  return editorStateError("editor_state_invalid", "画布状态无效。");
}
