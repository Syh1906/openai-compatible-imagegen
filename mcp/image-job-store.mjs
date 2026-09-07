import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

import { acquireFileLockOwnership, readLatestFencedFileSnapshot } from "./file-lock-ownership.mjs";
import { pathContainsSymbolicLink } from "./filesystem-path-safety.mjs";
import { jobError, jobIdSchema, jobRecordSchema, scopeHash } from "./image-job-contract.mjs";

const MAX_RECORD_BYTES = 8 * 1024 * 1024;

export function createImageJobStore() {
  const pendingUpdates = new Map();
  return Object.freeze({ read, update });

  async function read({ context, jobId }) {
    const scope = await prepareScope(context, jobId, false);
    if (!scope) throw jobError("image_job_not_found");
    try {
      const bytes = await readLatestFencedFileSnapshot(scope.recordPath, { maxBytes: MAX_RECORD_BYTES });
      if (bytes === null) throw jobError("image_job_not_found");
      return decode(bytes, context, jobId);
    } catch (error) {
      if (error?.code?.startsWith("image_job_")) throw error;
      throw jobError("image_job_state_unavailable");
    }
  }

  async function update({ context, jobId }, callback) {
    const key = `${context.artifactRoot}\0${jobId}`;
    const previous = pendingUpdates.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => mutate({ context, jobId }, callback));
    pendingUpdates.set(key, current);
    try { return await current; }
    finally { if (pendingUpdates.get(key) === current) pendingUpdates.delete(key); }
  }

  async function mutate({ context, jobId }, callback) {
    const scope = await prepareScope(context, jobId, true);
    let ownership;
    try {
      ownership = await acquireFileLockOwnership({
        ...scope, maxRecordBytes: MAX_RECORD_BYTES,
        retries: { retries: 80, factor: 1, minTimeout: 10, maxTimeout: 25 },
        unavailableError: () => jobError("image_job_state_unavailable"),
        invalidError: () => jobError("image_job_state_invalid"),
      });
      const bytes = await ownership.readSnapshot();
      const record = bytes === null ? null : decode(bytes, context, jobId);
      const next = await callback(record);
      if (next === null) return record;
      const validated = validate(next, context, jobId);
      const serialized = Buffer.from(`${JSON.stringify(validated)}\n`);
      if (serialized.length > MAX_RECORD_BYTES) throw jobError("image_job_state_invalid");
      await ownership.replaceSnapshot(serialized);
      return validated;
    } catch (error) {
      if (error?.code?.startsWith("image_job_")) throw error;
      throw jobError("image_job_state_unavailable");
    } finally {
      if (ownership) await ownership.release();
    }
  }
}

function decode(bytes, context, jobId) {
  try {
    return validate(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), context, jobId);
  } catch {
    throw jobError("image_job_state_invalid");
  }
}

function validate(record, context, jobId) {
  const parsed = jobRecordSchema.safeParse(record);
  if (!parsed.success || parsed.data.jobId !== jobId || parsed.data.scopeHash !== scopeHash(context)) throw jobError("image_job_state_invalid");
  return parsed.data;
}

async function prepareScope(context, jobId, create) {
  if (!jobIdSchema.safeParse(jobId).success || typeof context?.artifactRoot !== "string" || !path.isAbsolute(context.artifactRoot)) {
    throw jobError("image_job_state_invalid");
  }
  const artifactRoot = path.resolve(context.artifactRoot);
  const stateRoot = path.join(artifactRoot, ".runtime", "image-jobs");
  for (const directory of [artifactRoot, path.join(artifactRoot, ".runtime"), stateRoot]) {
    try {
      if (await pathContainsSymbolicLink(directory)) throw jobError("image_job_state_invalid");
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw jobError("image_job_state_invalid");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (!create) return null;
      if (directory === artifactRoot) throw jobError("image_job_state_unavailable");
      await mkdir(directory).catch((failure) => { if (failure.code !== "EEXIST") throw failure; });
      if (await pathContainsSymbolicLink(directory) || !(await lstat(directory)).isDirectory()) throw jobError("image_job_state_invalid");
    }
  }
  const recordPath = path.join(stateRoot, `${jobId}.json`);
  const lockPath = path.join(stateRoot, `${jobId}.lock`);
  for (const target of [recordPath, lockPath]) {
    try {
      if (await pathContainsSymbolicLink(target)) throw jobError("image_job_state_invalid");
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  return { recordPath, lockPath };
}
