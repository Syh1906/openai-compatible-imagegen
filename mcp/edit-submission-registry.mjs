import { createHash, randomBytes } from "node:crypto";


const SUBMISSION_ID_PATTERN = /^sub_[0-9a-f]{32}$/;
const IMAGE_ID_PATTERN = /^img_[0-9A-HJKMNP-TV-Z]{26}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;


export function createEditSubmissionRegistry({ idFactory = createSubmissionId } = {}) {
  if (typeof idFactory !== "function") {
    throw new TypeError("idFactory must be a function");
  }

  const recordsById = new Map();
  const preparedByBindingAndParent = new Map();
  const inFlightByBindingAndParent = new Map();

  return Object.freeze({ issue, resolveForEdit, claimForEdit, releaseForEdit, complete });

  function issue(input) {
    const revision = normalizeIssueInput(input);
    const pendingKey = bindingParentKey(revision.bindingKey, revision.parentImageId);
    if (inFlightByBindingAndParent.has(pendingKey)) {
      throw registryError("edit_submission_in_flight", "当前画布提交正在用于图片编辑。");
    }

    const id = idFactory();
    if (!SUBMISSION_ID_PATTERN.test(id) || recordsById.has(id)) {
      throw new TypeError("idFactory must return a unique sub_ ID with 32 lowercase hex characters");
    }
    const receipt = Object.freeze({
      id,
      parentImageId: revision.parentImageId,
      annotationId: revision.annotationId,
      revisionSha256: digestRevision(revision),
    });
    recordsById.set(id, {
      bindingKey: revision.bindingKey,
      parentImageId: revision.parentImageId,
      annotationId: revision.annotationId,
      maskSha256: revision.maskSha256,
      maskPolicySha256: revision.maskPolicySha256,
      claimGeneration: 0,
      state: "prepared",
      receipt,
    });
    const preparedIds = preparedByBindingAndParent.get(pendingKey) || new Set();
    preparedIds.add(id);
    preparedByBindingAndParent.set(pendingKey, preparedIds);
    return receipt;
  }

  function resolveForEdit(input) {
    const request = normalizeLookupInput(input, { requireSubmissionId: false });
    const pendingKey = bindingParentKey(request.bindingKey, request.parentImageId);
    const preparedIds = preparedByBindingAndParent.get(pendingKey);

    if (request.submissionId === undefined) {
      if (!preparedIds?.size && !inFlightByBindingAndParent.has(pendingKey)) return null;
      throw registryError("missing_edit_submission", "当前图片存在待发送画布提交，缺少 submissionId。");
    }

    const record = recordsById.get(request.submissionId);
    if (!record) {
      throw registryError("stale_edit_submission", "画布提交不存在、已过期或已被消费。");
    }
    assertBindingMatches(record, request);
    const annotationMatches = record.annotationId === null
      ? !request.hasAnnotationId || request.annotationId === null
      : request.hasAnnotationId && request.annotationId === record.annotationId;
    if (!annotationMatches) {
      throw registryError("edit_submission_mismatch", "画布提交与标注不匹配。");
    }
    if (record.state === "complete") {
      return Object.freeze({
        receipt: record.receipt,
        maskSha256: record.maskSha256,
        maskPolicySha256: record.maskPolicySha256,
        completedArtifactIds: [...(record.completedArtifactIds || [])],
      });
    }
    if (record.state !== "prepared" || !preparedIds?.has(request.submissionId)) {
      throw registryError("stale_edit_submission", "画布提交已经被更新版本替代。");
    }
    return Object.freeze({
      receipt: record.receipt,
      maskSha256: record.maskSha256,
      maskPolicySha256: record.maskPolicySha256,
    });
  }


  function claimForEdit(input) {
    const resolved = resolveForEdit(input);
    if (resolved === null) return null;

    if (resolved.completedArtifactIds) return resolved;

    const record = recordsById.get(resolved.receipt.id);
    const pendingKey = bindingParentKey(record.bindingKey, record.parentImageId);
    if (inFlightByBindingAndParent.has(pendingKey)) {
      throw registryError("edit_submission_in_flight", "当前画布提交正在用于图片编辑。");
    }
    inFlightByBindingAndParent.set(pendingKey, resolved.receipt.id);
    record.claimGeneration += 1;
    record.state = "in_flight";
    return Object.freeze({ ...resolved, claimGeneration: record.claimGeneration });
  }


  function releaseForEdit(input) {
    const { record } = requireCurrentRecord(input, "in_flight");
    const pendingKey = bindingParentKey(record.bindingKey, record.parentImageId);
    inFlightByBindingAndParent.delete(pendingKey);
    const preparedIds = preparedByBindingAndParent.get(pendingKey) || new Set();
    preparedIds.add(record.receipt.id);
    preparedByBindingAndParent.set(pendingKey, preparedIds);
    record.state = "prepared";
    return record.receipt;
  }


  function complete(input) {
    const { record, pendingKey } = requireCurrentRecord(input, "in_flight");

    record.completedArtifactIds = normalizeArtifactIds(input.artifactIds);
    record.state = "complete";
    const preparedIds = preparedByBindingAndParent.get(pendingKey) || new Set();
    for (const candidateId of preparedIds) {
      if (candidateId !== record.receipt.id) recordsById.get(candidateId).state = "stale";
    }
    inFlightByBindingAndParent.delete(pendingKey);
    preparedByBindingAndParent.delete(pendingKey);
    return record.receipt;
  }


  function requireCurrentRecord(input, requiredState) {
    const request = normalizeLookupInput(input, { requireSubmissionId: true });
    const claimGeneration = normalizeClaimGeneration(input.claimGeneration);
    const record = recordsById.get(request.submissionId);
    if (!record) {
      throw registryError("stale_edit_submission", "画布提交不存在、已过期或已被消费。");
    }
    assertBindingMatches(record, request);

    const pendingKey = bindingParentKey(request.bindingKey, request.parentImageId);
    if (
      record.state !== requiredState
      || inFlightByBindingAndParent.get(pendingKey) !== request.submissionId
      || record.claimGeneration !== claimGeneration
    ) {
      throw registryError("stale_edit_submission", "画布提交已经被更新版本替代。");
    }
    return { request, record, pendingKey };
  }
}


export function normalizeClaimGeneration(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw registryError("stale_edit_submission", "画布提交已经被更新版本替代。");
  }
  return value;
}


export function normalizeArtifactIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.some((id) => (
    typeof id !== "string" || !IMAGE_ID_PATTERN.test(id)
  ))) {
    throw new TypeError("artifactIds must contain at least one valid image ID");
  }
  return [...new Set(value)];
}


export function normalizeIssueInput(input) {
  requireObject(input, "submission");
  const bindingKey = requireText(input.bindingKey, "bindingKey");
  const parentImageId = requireText(input.parentImageId, "parentImageId");
  const annotationId = requireNullableText(input.annotationId, "annotationId");
  const maskSha256 = requireNullableSha256(input.maskSha256, "maskSha256");
  const maskPolicySha256 = requireNullableSha256(input.maskPolicySha256 ?? null, "maskPolicySha256");
  if (typeof input.sourcePrompt !== "string") {
    throw new TypeError("sourcePrompt must be a string");
  }
  if (!Array.isArray(input.items)) {
    throw new TypeError("items must be an array");
  }
  canonicalJson(input.items);
  return {
    bindingKey,
    parentImageId,
    annotationId,
    maskSha256,
    maskPolicySha256,
    sourcePrompt: input.sourcePrompt,
    items: input.items,
  };
}


export function normalizeLookupInput(input, { requireSubmissionId }) {
  requireObject(input, "edit submission lookup");
  const bindingKey = requireText(input.bindingKey, "bindingKey");
  const parentImageId = requireText(input.parentImageId, "parentImageId");
  const hasSubmissionId = Object.hasOwn(input, "submissionId") && input.submissionId !== undefined;
  if (requireSubmissionId && !hasSubmissionId) {
    throw registryError("missing_edit_submission", "缺少 submissionId。");
  }
  if (hasSubmissionId && !SUBMISSION_ID_PATTERN.test(input.submissionId)) {
    throw registryError("stale_edit_submission", "画布提交不存在、已过期或已被消费。");
  }
  const hasAnnotationId = Object.hasOwn(input, "annotationId");
  return {
    bindingKey,
    parentImageId,
    submissionId: hasSubmissionId ? input.submissionId : undefined,
    hasAnnotationId,
    annotationId: hasAnnotationId
      ? requireNullableText(input.annotationId, "annotationId")
      : undefined,
  };
}


function assertBindingMatches(record, request) {
  if (
    request.bindingKey !== record.bindingKey
    || request.parentImageId !== record.parentImageId
  ) {
    throw registryError("edit_submission_mismatch", "画布提交与项目或父图片不匹配。");
  }
}


export function digestRevision(revision) {
  const canonicalRevision = {
    annotationId: revision.annotationId,
    items: revision.items,
    maskPolicySha256: revision.maskPolicySha256,
    maskSha256: revision.maskSha256,
    parentImageId: revision.parentImageId,
    sourcePrompt: revision.sourcePrompt,
  };
  return createHash("sha256")
    .update(canonicalJson(canonicalRevision), "utf8")
    .digest("hex");
}


function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("revision data must contain finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ));
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("revision data must contain only canonical JSON values");
}


function bindingParentKey(bindingKey, parentImageId) {
  return JSON.stringify([bindingKey, parentImageId]);
}


export function registryError(code, message) {
  const error = new Error(message);
  error.name = "EditSubmissionError";
  error.code = code;
  return error;
}


function requireObject(value, name) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be an object`);
  }
}


function requireText(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}


function requireNullableText(value, name) {
  if (value === null) return null;
  return requireText(value, name);
}


function requireNullableSha256(value, name) {
  if (value === null) return null;
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${name} must be null or a lowercase SHA-256 digest`);
  }
  return value;
}


export function createSubmissionId() {
  return `sub_${randomBytes(16).toString("hex")}`;
}
