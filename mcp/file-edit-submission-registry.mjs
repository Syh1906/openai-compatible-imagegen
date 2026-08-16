import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

import { pathContainsSymbolicLink } from "./filesystem-path-safety.mjs";

import {
  createSubmissionId,
  digestRevision,
  normalizeArtifactIds,
  normalizeClaimGeneration,
  normalizeIssueInput,
  normalizeLookupInput,
  registryError,
} from "./edit-submission-registry.mjs";
import {
  acquireFileLockOwnership,
  readLatestFencedFileSnapshot,
} from "./file-lock-ownership.mjs";
import {
  StableFileSnapshotError,
} from "./stable-file-snapshot.mjs";


const SCHEMA_VERSION = "edit-submissions.v1";
const BINDING_KEY_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_ID_PATTERN = /^img_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBMISSION_ID_PATTERN = /^sub_[0-9a-f]{32}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_RECORDS = 256;
const DEFAULT_LEASE_TIMEOUT_MS = 20 * 60 * 1000;


export function createFileEditSubmissionRegistry({
  idFactory = createSubmissionId,
  now = Date.now,
  leaseTimeoutMs = DEFAULT_LEASE_TIMEOUT_MS,
} = {}) {
  if (typeof idFactory !== "function" || typeof now !== "function") {
    throw new TypeError("idFactory and now must be functions");
  }
  if (!Number.isSafeInteger(leaseTimeoutMs) || leaseTimeoutMs <= 0) {
    throw new TypeError("leaseTimeoutMs must be a positive safe integer");
  }

  return Object.freeze({ issue, resolveForEdit, claimForEdit, releaseForEdit, complete });

  async function issue(input) {
    const revision = normalizeIssueInput(input);
    return await withParentRecord(input, async (record, save) => {
      recoverExpiredClaim(record, now(), leaseTimeoutMs);
      if (record.inFlightSubmissionId !== null) {
        throw registryError("edit_submission_in_flight", "当前画布提交正在用于图片编辑。");
      }
      if (record.submissions.length >= MAX_RECORDS) {
        throw registryError("edit_submission_limit", "当前图片的画布提交记录已达到上限。");
      }
      const id = idFactory();
      if (!SUBMISSION_ID_PATTERN.test(id) || record.submissions.some((item) => item.id === id)) {
        throw new TypeError("idFactory must return a unique sub_ ID with 32 lowercase hex characters");
      }
      const receipt = Object.freeze({
        id,
        parentImageId: revision.parentImageId,
        annotationId: revision.annotationId,
        revisionSha256: digestRevision(revision),
      });
      record.submissions.push({
        id,
        annotationId: revision.annotationId,
        claimGeneration: 0,
        maskSha256: revision.maskSha256,
        maskPolicySha256: revision.maskPolicySha256,
        revisionSha256: receipt.revisionSha256,
        state: "prepared",
        completedArtifactIds: [],
      });
      await save(record);
      return receipt;
    });
  }

  async function resolveForEdit(input) {
    const request = normalizeLookupInput(input, { requireSubmissionId: false });
    return await withParentRecord(input, async (record, save) => {
      if (recoverExpiredClaim(record, now(), leaseTimeoutMs)) await save(record);
      return resolveRecord(record, request);
    });
  }

  async function claimForEdit(input) {
    const request = normalizeLookupInput(input, { requireSubmissionId: false });
    return await withParentRecord(input, async (record, save) => {
      recoverExpiredClaim(record, now(), leaseTimeoutMs);
      const resolved = resolveRecord(record, request);
      if (resolved === null || resolved.completedArtifactIds) return resolved;
      if (record.inFlightSubmissionId !== null) {
        throw registryError("edit_submission_in_flight", "当前画布提交正在用于图片编辑。");
      }
      const submission = requireSubmission(record, resolved.receipt.id);
      if (submission.claimGeneration >= Number.MAX_SAFE_INTEGER) invalidState();
      submission.claimGeneration += 1;
      submission.state = "in_flight";
      record.inFlightSubmissionId = submission.id;
      record.inFlightAt = now();
      await save(record);
      return Object.freeze({ ...resolved, claimGeneration: submission.claimGeneration });
    });
  }

  async function releaseForEdit(input) {
    const request = normalizeLookupInput(input, { requireSubmissionId: true });
    const claimGeneration = normalizeClaimGeneration(input.claimGeneration);
    return await withParentRecord(input, async (record, save) => {
      const submission = requireCurrentClaim(record, request, claimGeneration);
      submission.state = "prepared";
      record.inFlightSubmissionId = null;
      record.inFlightAt = null;
      await save(record);
      return receiptFor(record, submission);
    });
  }

  async function complete(input) {
    const request = normalizeLookupInput(input, { requireSubmissionId: true });
    const claimGeneration = normalizeClaimGeneration(input.claimGeneration);
    const artifactIds = normalizeArtifactIds(input.artifactIds);
    return await withParentRecord(input, async (record, save) => {
      const submission = requireCurrentClaim(record, request, claimGeneration);
      submission.state = "complete";
      submission.completedArtifactIds = artifactIds;
      for (const candidate of record.submissions) {
        if (candidate.id !== submission.id && candidate.state === "prepared") {
          candidate.state = "stale";
        }
      }
      record.inFlightSubmissionId = null;
      record.inFlightAt = null;
      await save(record);
      return receiptFor(record, submission);
    });
  }
}


async function withParentRecord(input, callback) {
  const scope = await prepareScope(input);
  let ownership;
  try {
    await requireSafeLockPath(scope.lockPath);
    ownership = await acquireFileLockOwnership({
      recordPath: scope.recordPath,
      lockPath: scope.lockPath,
      maxRecordBytes: MAX_RECORD_BYTES,
      retries: { retries: 40, factor: 1, minTimeout: 10, maxTimeout: 50 },
      unavailableError: unavailableState,
      invalidError: invalidStateError,
    });
    await ownership.assertOwned();
    const record = await readParentRecord(scope, ownership);
    await ownership.assertOwned();
    const result = await callback(record, async (next) => {
      await ownership.assertOwned();
      await writeParentRecord(scope, next, ownership);
      await ownership.assertOwned();
    });
    await ownership.assertOwned();
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === "EditSubmissionError") throw error;
    throw registryError("edit_submission_state_unavailable", "画布提交状态暂时不可用。");
  } finally {
    if (ownership) {
      try {
        await ownership.release();
      } catch {
        throw registryError("edit_submission_state_unavailable", "画布提交状态暂时不可用。");
      }
    }
  }
}


function unavailableState() {
  return registryError("edit_submission_state_unavailable", "画布提交状态暂时不可用。");
}


async function prepareScope(input) {
  if (
    typeof input?.artifactRoot !== "string"
    || !path.isAbsolute(input.artifactRoot)
    || typeof input.bindingKey !== "string"
    || !BINDING_KEY_PATTERN.test(input.bindingKey)
    || typeof input.parentImageId !== "string"
    || !IMAGE_ID_PATTERN.test(input.parentImageId)
  ) {
    throw registryError("edit_submission_state_invalid", "画布提交状态无效。");
  }
  const stateRoot = path.join(path.resolve(input.artifactRoot), ".runtime", "edit-submissions");
  const parentsDirectory = path.join(stateRoot, "parents");
  const locksDirectory = path.join(stateRoot, "locks");
  const artifactRoot = path.resolve(input.artifactRoot);
  for (const directory of [
    artifactRoot,
    path.join(artifactRoot, ".runtime"),
    stateRoot,
    parentsDirectory,
    locksDirectory,
  ]) {
    await ensureCanonicalDirectory(directory, { create: directory !== artifactRoot });
  }
  const parentKey = createHash("sha256")
    .update(`${input.bindingKey}\0${input.parentImageId}`, "utf8")
    .digest("hex");
  return {
    bindingKey: input.bindingKey,
    parentImageId: input.parentImageId,
    parentsDirectory,
    recordPath: path.join(parentsDirectory, `${parentKey}.json`),
    lockPath: path.join(locksDirectory, `${parentKey}.lock`),
  };
}


async function readParentRecord(scope, ownership = null) {
  let bytes;
  try {
    bytes = ownership
      ? await ownership.readSnapshot()
      : await readLatestFencedFileSnapshot(scope.recordPath, { maxBytes: MAX_RECORD_BYTES });
  } catch (error) {
    if (error instanceof StableFileSnapshotError && error.kind === "invalid") {
      throw registryError("edit_submission_state_invalid", "画布提交状态无效。");
    }
    throw registryError("edit_submission_state_unavailable", "画布提交状态暂时不可用。");
  }
  if (bytes === null) return emptyRecord(scope);
  try {
    return validateRecord(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      scope,
    );
  } catch (error) {
    if (error?.code === "edit_submission_state_invalid") throw error;
    throw registryError("edit_submission_state_invalid", "画布提交状态无效。");
  }
}


async function writeParentRecord(scope, record, ownership) {
  const validated = validateRecord(record, scope);
  const bytes = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
  if (bytes.length > MAX_RECORD_BYTES) {
    throw registryError("edit_submission_state_invalid", "画布提交状态无效。");
  }
  try {
    await ownership.replaceSnapshot(bytes);
  } catch (error) {
    if (error instanceof Error && error.name === "EditSubmissionError") throw error;
    throw registryError("edit_submission_state_unavailable", "画布提交状态暂时不可用。");
  }
}


function resolveRecord(record, request) {
  const prepared = record.submissions.some((item) => item.state === "prepared");
  if (request.submissionId === undefined) {
    if (!prepared && record.inFlightSubmissionId === null) return null;
    throw registryError("missing_edit_submission", "当前图片存在待发送画布提交，缺少 submissionId。");
  }
  const submission = record.submissions.find((item) => item.id === request.submissionId);
  if (!submission) {
    throw registryError("stale_edit_submission", "画布提交不存在、已过期或已被消费。");
  }
  const annotationMatches = submission.annotationId === null
    ? !request.hasAnnotationId || request.annotationId === null
    : request.hasAnnotationId && request.annotationId === submission.annotationId;
  if (!annotationMatches) {
    throw registryError("edit_submission_mismatch", "画布提交与标注不匹配。");
  }
  if (submission.state === "complete") {
    return Object.freeze({
      receipt: receiptFor(record, submission),
      maskSha256: submission.maskSha256,
      maskPolicySha256: submission.maskPolicySha256,
      completedArtifactIds: [...submission.completedArtifactIds],
    });
  }
  if (submission.state !== "prepared") {
    throw registryError("stale_edit_submission", "画布提交已经被更新版本替代。");
  }
  return Object.freeze({
    receipt: receiptFor(record, submission),
    maskSha256: submission.maskSha256,
    maskPolicySha256: submission.maskPolicySha256,
  });
}


function requireCurrentClaim(record, request, claimGeneration) {
  const submission = requireSubmission(record, request.submissionId);
  if (
    submission.state !== "in_flight"
    || record.inFlightSubmissionId !== request.submissionId
    || submission.claimGeneration !== claimGeneration
  ) {
    throw registryError("stale_edit_submission", "画布提交已经被更新版本替代。");
  }
  return submission;
}


function requireSubmission(record, submissionId) {
  const submission = record.submissions.find((item) => item.id === submissionId);
  if (!submission) {
    throw registryError("stale_edit_submission", "画布提交不存在、已过期或已被消费。");
  }
  return submission;
}


function receiptFor(record, submission) {
  return Object.freeze({
    id: submission.id,
    parentImageId: record.parentImageId,
    annotationId: submission.annotationId,
    revisionSha256: submission.revisionSha256,
  });
}


function recoverExpiredClaim(record, currentTime, leaseTimeoutMs) {
  if (record.inFlightSubmissionId === null) return false;
  if (currentTime - record.inFlightAt <= leaseTimeoutMs) return false;
  const submission = record.submissions.find((item) => item.id === record.inFlightSubmissionId);
  if (submission?.state === "in_flight") submission.state = "prepared";
  record.inFlightSubmissionId = null;
  record.inFlightAt = null;
  return true;
}


function emptyRecord(scope) {
  return {
    schemaVersion: SCHEMA_VERSION,
    bindingKey: scope.bindingKey,
    parentImageId: scope.parentImageId,
    inFlightSubmissionId: null,
    inFlightAt: null,
    submissions: [],
  };
}


function validateRecord(value, scope) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) invalidState();
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    "bindingKey",
    "inFlightAt",
    "inFlightSubmissionId",
    "parentImageId",
    "schemaVersion",
    "submissions",
  ])) invalidState();
  if (
    value.schemaVersion !== SCHEMA_VERSION
    || value.bindingKey !== scope.bindingKey
    || value.parentImageId !== scope.parentImageId
    || !Array.isArray(value.submissions)
    || value.submissions.length > MAX_RECORDS
  ) invalidState();
  const ids = new Set();
  for (const submission of value.submissions) {
    validateSubmission(submission);
    if (ids.has(submission.id)) invalidState();
    ids.add(submission.id);
  }
  const inFlightSubmissions = value.submissions.filter((item) => item.state === "in_flight");
  if (value.inFlightSubmissionId === null) {
    if (value.inFlightAt !== null || inFlightSubmissions.length !== 0) invalidState();
  } else {
    if (
      !SUBMISSION_ID_PATTERN.test(value.inFlightSubmissionId)
      || !Number.isSafeInteger(value.inFlightAt)
      || value.inFlightAt < 0
      || inFlightSubmissions.length !== 1
      || inFlightSubmissions[0].id !== value.inFlightSubmissionId
    ) invalidState();
  }
  return value;
}


function validateSubmission(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) invalidState();
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    "annotationId",
    "claimGeneration",
    "completedArtifactIds",
    "id",
    "maskPolicySha256",
    "maskSha256",
    "revisionSha256",
    "state",
  ])) invalidState();
  if (
    !SUBMISSION_ID_PATTERN.test(value.id)
    || (value.annotationId !== null && typeof value.annotationId !== "string")
    || !Number.isSafeInteger(value.claimGeneration)
    || value.claimGeneration < 0
    || (value.maskSha256 !== null && !SHA256_PATTERN.test(value.maskSha256))
    || (value.maskPolicySha256 !== null && !SHA256_PATTERN.test(value.maskPolicySha256))
    || !SHA256_PATTERN.test(value.revisionSha256)
    || !["prepared", "in_flight", "complete", "stale"].includes(value.state)
    || !Array.isArray(value.completedArtifactIds)
    || value.completedArtifactIds.some((id) => !IMAGE_ID_PATTERN.test(id))
    || new Set(value.completedArtifactIds).size !== value.completedArtifactIds.length
    || (value.state === "complete") !== (value.completedArtifactIds.length > 0)
  ) invalidState();
}


async function ensureCanonicalDirectory(directory, { create }) {
  try {
    if (create) {
      await mkdir(directory, { recursive: false, mode: 0o700 }).catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
    }
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) invalidState();
    if (await pathContainsSymbolicLink(directory)) invalidState();
  } catch (error) {
    if (error?.code === "edit_submission_state_invalid") throw error;
    throw registryError("edit_submission_state_unavailable", "画布提交状态暂时不可用。");
  }
}


async function requireSafeLockPath(lockPath) {
  try {
    const metadata = await lstat(lockPath);
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || await pathContainsSymbolicLink(lockPath)
    ) invalidState();
  } catch (error) {
    if (error?.code === "ENOENT") return;
    if (error?.code === "edit_submission_state_invalid") throw error;
    throw registryError("edit_submission_state_unavailable", "画布提交状态暂时不可用。");
  }
}


function invalidState() {
  throw invalidStateError();
}


function invalidStateError() {
  return registryError("edit_submission_state_invalid", "画布提交状态无效。");
}
