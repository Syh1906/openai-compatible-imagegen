import { isStableToolErrorCode, stableToolErrorMessages } from "./tool-errors.mjs";
import {
  safeDeliveryQa,
  safeDeliverySummary,
  safeDeliveryWarnings,
} from "./delivery-result.mjs";


const DEFAULT_MODEL_PROFILE_ID = "primary/gpt-image-2";
const BATCH_ID_PATTERN = /^batch_[0-9A-HJKMNP-TV-Z]{26}$/;
const DELIVERY_RECEIPT_ID_PATTERN = /^delivery_[0-9a-f]{64}$/;
const IMAGE_ID_PATTERN = /^img_[0-9A-HJKMNP-TV-Z]{26}$/;
const API_DELIVERY_STATUSES = new Set(["published", "published_with_warnings", "partial"]);
const API_DELIVERY_ISSUE_CODES = new Set([
  "count_mismatch",
  "format_mismatch",
  "item_publish_failed",
  "item_unusable",
  "size_mismatch",
  "total_bytes_exceeded",
]);
const API_IMAGE_FORMATS = new Set(["jpeg", "png", "webp"]);


export async function executeImageBatch({
  items,
  concurrency,
  context,
  runTask,
  readArtifact,
  validateEdit,
  recordManifest,
}) {
  requireBatchDependencies({
    items,
    concurrency,
    runTask,
    readArtifact,
    validateEdit,
    recordManifest,
  });
  const outcomes = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      outcomes[index] = await executeBatchItem({
        item: items[index],
        context,
        runTask,
        readArtifact,
        validateEdit,
      });
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  const results = outcomes.map((outcome) => outcome.result);
  const succeeded = results.filter((item) => item.ok).length;
  const artifactIds = outcomes.flatMap((outcome) => outcome.publishedArtifactIds);
  const summary = {
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    artifactCount: artifactIds.length,
  };
  const manifestResults = outcomes.map((outcome) => outcome.manifestResult);
  const manifestStatus = manifestResults.some((result) => result === null)
    ? manifestFailure({ code: "image_task_failed" })
    : await storeBatchManifest({
      results: manifestResults,
      summary: manifestSummary(manifestResults),
      context,
      recordManifest,
    });
  return {
    results,
    summary,
    artifactIds,
    ...manifestStatus,
  };
}


async function executeBatchItem({ item, context, runTask, readArtifact, validateEdit }) {
  try {
    if (item.operation === "edit") {
      await validateEdit(item, context);
    }
    const result = await runTask(machineTaskFor(item, context), context);
    if (!result?.ok) {
      return failedBatchOutcome(item, result?.error, "image_task_failed");
    }
    const artifactIds = (result.artifacts || []).map((artifact) => artifact?.id);
    if (
      artifactIds.length < 1
      || artifactIds.some((id) => !IMAGE_ID_PATTERN.test(id))
      || new Set(artifactIds).size !== artifactIds.length
    ) {
      return failedBatchOutcome(item, null, "image_task_failed");
    }
    const apiDelivery = safeApiDelivery(result.apiDelivery, artifactIds, item.count ?? 1);
    if (!apiDelivery) {
      return unmanifestableBatchOutcome(item, artifactIds);
    }
    const deliveryFacts = manifestDeliveryFacts({
      requested: Boolean(item.delivery),
      sourceArtifactIds: artifactIds,
      deliveries: result.deliveries,
    });
    if (!deliveryFacts) {
      return unmanifestableBatchOutcome(item, artifactIds);
    }
    const manifestResult = {
      requestId: item.requestId,
      operation: item.operation,
      ok: true,
      artifactIds,
      apiDelivery,
      deliveryReceiptIds: deliveryFacts.receiptIds,
      deliveryArtifactIds: deliveryFacts.artifactIds,
    };
    try {
      const records = await Promise.all(artifactIds.map((id) => readArtifact(id, context)));
      const delivery = item.delivery
        ? await buildDeliveryReceipt({
          sourceArtifactIds: artifactIds,
          deliveries: result.deliveries,
          context,
          readArtifact,
        })
        : null;
      return {
        result: {
          requestId: item.requestId,
          operation: item.operation,
          ok: true,
          artifacts: records.map(({ metadata }) => ({ ...metadata })),
          apiDelivery,
          ...(delivery ? { delivery } : {}),
        },
        manifestResult,
        publishedArtifactIds: artifactIds,
      };
    } catch (error) {
      return {
        result: batchFailure(item, error, "artifact_read_failed"),
        manifestResult,
        publishedArtifactIds: artifactIds,
      };
    }
  } catch (error) {
    return failedBatchOutcome(item, error, "image_task_failed");
  }
}


function safeApiDelivery(value, artifactIds, expectedCount) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!API_DELIVERY_STATUSES.has(value.status)) return undefined;
  const requestedCount = safeInteger(value.requestedCount, 1, 16);
  const returnedCount = safeInteger(value.returnedCount, 0, Number.MAX_SAFE_INTEGER);
  const publishedCount = safeInteger(value.publishedCount, 1, 16);
  if (
    requestedCount === undefined
    || returnedCount === undefined
    || publishedCount === undefined
    || requestedCount !== expectedCount
    || returnedCount < publishedCount
    || publishedCount !== artifactIds.length
  ) {
    return undefined;
  }

  const allowedArtifacts = new Set(artifactIds);
  const items = [];
  if (!Array.isArray(value.items) || value.items.length !== publishedCount) return undefined;
  for (const item of value.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const responseIndex = safeInteger(item.responseIndex, 1, 16);
    const width = safeInteger(item.width, 1, Number.MAX_SAFE_INTEGER);
    const height = safeInteger(item.height, 1, Number.MAX_SAFE_INTEGER);
    if (
      responseIndex === undefined
      || width === undefined
      || height === undefined
      || !allowedArtifacts.has(item.artifactId)
      || !API_IMAGE_FORMATS.has(item.actualFormat)
    ) {
      return undefined;
    }
    items.push({
      responseIndex,
      artifactId: item.artifactId,
      actualFormat: item.actualFormat,
      width,
      height,
    });
  }
  if (
    items.some((item, index) => item.artifactId !== artifactIds[index])
    || new Set(items.map((item) => item.responseIndex)).size !== items.length
    || items.some((item) => item.responseIndex > requestedCount || item.responseIndex > returnedCount)
  ) return undefined;

  const issues = [];
  if (!Array.isArray(value.issues) || value.issues.length > 64) return undefined;
  for (const issue of value.issues) {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) continue;
    if (!API_DELIVERY_ISSUE_CODES.has(issue.code)) continue;
    const responseIndex = issue.responseIndex === undefined
      ? undefined
      : safeInteger(issue.responseIndex, 1, 16);
    if (issue.responseIndex !== undefined && responseIndex === undefined) return undefined;
    issues.push({
      code: issue.code,
      ...(responseIndex !== undefined ? { responseIndex } : {}),
    });
  }
  const hasCountMismatch = issues.some((issue) => issue.code === "count_mismatch");
  if (hasCountMismatch !== (returnedCount !== requestedCount)) return undefined;
  const expectedStatus = publishedCount !== requestedCount
    ? "partial"
    : issues.length ? "published_with_warnings" : "published";
  if (value.status !== expectedStatus) return undefined;
  return {
    status: value.status,
    requestedCount,
    returnedCount,
    publishedCount,
    items,
    issues,
  };
}


function manifestDeliveryFacts({ requested, sourceArtifactIds, deliveries }) {
  if (!requested) return { receiptIds: [], artifactIds: [] };
  const receipts = Array.isArray(deliveries) ? deliveries : [];
  if (receipts.length > sourceArtifactIds.length) return undefined;
  const receiptIds = [];
  const artifactIds = [];
  for (const [index, sourceArtifactId] of sourceArtifactIds.entries()) {
    const receipt = receipts[index];
    if (!receipt || receipt.ok !== true || receipt.sourceArtifactId !== sourceArtifactId) continue;
    if (!DELIVERY_RECEIPT_ID_PATTERN.test(receipt.deliveryReceiptId)) continue;
    if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length > 10) continue;
    const derivedIds = receipt.artifacts.map((artifact) => artifact?.id);
    if (
      derivedIds.some((id) => !IMAGE_ID_PATTERN.test(id))
      || new Set(derivedIds).size !== derivedIds.length
    ) continue;
    receiptIds.push(receipt.deliveryReceiptId);
    artifactIds.push(...derivedIds);
  }
  if (new Set(receiptIds).size !== receiptIds.length || new Set(artifactIds).size !== artifactIds.length) {
    return undefined;
  }
  return { receiptIds, artifactIds };
}


function safeInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}


async function buildDeliveryReceipt({ sourceArtifactIds, deliveries, context, readArtifact }) {
  const receipts = Array.isArray(deliveries) ? deliveries : [];
  const results = [];
  for (const [index, sourceArtifactId] of sourceArtifactIds.entries()) {
    const receipt = receipts[index];
    if (!receipt || receipt.sourceArtifactId !== sourceArtifactId || receipt.ok !== true) {
      results.push(deliveryFailure(
        sourceArtifactId,
        receipt?.error,
        "image_task_failed",
      ));
      continue;
    }
    const artifactIds = Array.isArray(receipt.artifacts)
      ? receipt.artifacts.map((artifact) => artifact?.id)
      : [];
    if (artifactIds.some((id) => typeof id !== "string") || artifactIds.length > 10) {
      results.push(deliveryFailure(
        sourceArtifactId,
        null,
        "artifact_read_failed",
        receipt.deliveryReceiptId,
      ));
      continue;
    }
    try {
      const records = await Promise.all(artifactIds.map((id) => readArtifact(id, context)));
      const warnings = safeDeliveryWarnings(receipt.warnings);
      const qa = safeDeliveryQa(receipt.qa);
      const summary = safeDeliverySummary(receipt.summary);
      results.push({
        sourceArtifactId,
        deliveryReady: Boolean(receipt.deliveryReady),
        artifacts: records.map(({ metadata }) => ({ ...metadata })),
        ...(DELIVERY_RECEIPT_ID_PATTERN.test(receipt.deliveryReceiptId)
          ? { deliveryReceiptId: receipt.deliveryReceiptId }
          : {}),
        ...(qa !== undefined ? { qa } : {}),
        ...(warnings.length ? { warnings } : {}),
        ...(summary !== undefined ? { summary } : {}),
      });
    } catch (error) {
      results.push(deliveryFailure(
        sourceArtifactId,
        error,
        "artifact_read_failed",
        receipt.deliveryReceiptId,
      ));
    }
  }
  const artifactIds = results.flatMap((result) => result.artifacts.map((artifact) => artifact.id));
  return {
    deliveryReady: results.every((result) => result.deliveryReady),
    results,
    artifactIds,
  };
}


function deliveryFailure(sourceArtifactId, error, fallbackCode, deliveryReceiptId) {
  const candidateCode = error?.code;
  const code = isStableToolErrorCode(candidateCode) ? candidateCode : fallbackCode;
  return {
    sourceArtifactId,
    deliveryReady: false,
    artifacts: [],
    ...(DELIVERY_RECEIPT_ID_PATTERN.test(deliveryReceiptId)
      ? { deliveryReceiptId }
      : {}),
    error: {
      code,
      message: stableToolErrorMessages.get(code),
    },
  };
}


async function storeBatchManifest({ results, summary, context, recordManifest }) {
  const manifest = {
    schemaVersion: "batch-manifest.v1",
    summary,
    results,
  };
  try {
    const recorded = await recordManifest(manifest, context);
    const stored = recorded?.manifest;
    if (
      recorded?.ok !== true
      || !stored
      || !BATCH_ID_PATTERN.test(stored.batchId)
      || typeof stored.createdAt !== "string"
      || Number.isNaN(Date.parse(stored.createdAt))
    ) {
      return manifestFailure(recorded?.error);
    }
    return {
      manifestReady: true,
      batchId: stored.batchId,
      manifestCreatedAt: stored.createdAt,
    };
  } catch (error) {
    return manifestFailure(error);
  }
}


function manifestSummary(results) {
  const succeeded = results.filter((result) => result.ok).length;
  return {
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    artifactCount: results.flatMap((result) => (result.ok ? result.artifactIds : [])).length,
  };
}


function manifestFailure(error) {
  const candidateCode = error?.code;
  const code = isStableToolErrorCode(candidateCode) ? candidateCode : "image_task_failed";
  return {
    manifestReady: false,
    manifestError: {
      code,
      message: stableToolErrorMessages.get(code),
    },
  };
}


function machineTaskFor(item, context) {
  const {
    requestId: _requestId,
    operation,
    prompt,
    modelProfileId = context?.activeProfile || DEFAULT_MODEL_PROFILE_ID,
    transparency,
    delivery,
    ...rest
  } = item;
  if (operation === "generate") {
    return {
      operation,
      executionMode: "batch-item",
      modelProfileId,
      prompt,
      inputArtifactIds: [],
      annotationId: null,
      ...(transparency ? { transparency } : {}),
      ...(delivery ? { delivery } : {}),
      output: rest,
    };
  }
  const {
    parentImageId,
    referenceImageIds = [],
    ...output
  } = rest;
  return {
    operation,
    executionMode: "batch-item",
    modelProfileId,
    prompt,
    inputArtifactIds: [parentImageId, ...referenceImageIds],
    annotationId: null,
    ...(transparency ? { transparency } : {}),
    ...(delivery ? { delivery } : {}),
    output,
  };
}


function batchFailure(item, error, fallbackCode) {
  const candidateCode = error?.code;
  const code = isStableToolErrorCode(candidateCode) ? candidateCode : fallbackCode;
  return {
    requestId: item.requestId,
    operation: item.operation,
    ok: false,
    error: {
      code,
      message: stableToolErrorMessages.get(code),
    },
  };
}


function failedBatchOutcome(item, error, fallbackCode) {
  const result = batchFailure(item, error, fallbackCode);
  return {
    result,
    manifestResult: {
      requestId: item.requestId,
      operation: item.operation,
      ok: false,
      errorCode: result.error.code,
    },
    publishedArtifactIds: [],
  };
}


function unmanifestableBatchOutcome(item, artifactIds) {
  return {
    result: batchFailure(item, null, "image_task_failed"),
    manifestResult: null,
    publishedArtifactIds: artifactIds,
  };
}


function requireBatchDependencies({
  items,
  concurrency,
  runTask,
  readArtifact,
  validateEdit,
  recordManifest,
}) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 64) {
    throw new TypeError("items must contain between 1 and 64 batch tasks");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new TypeError("concurrency must be an integer between 1 and 8");
  }
  let totalCount = 0;
  for (const item of items) {
    const count = item?.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 16) {
      throw new TypeError("each batch task count must be an integer between 1 and 16");
    }
    totalCount += count;
  }
  if (totalCount > 64) {
    throw new TypeError("batch image count must not exceed 64");
  }
  for (const [name, value] of Object.entries({
    runTask,
    readArtifact,
    validateEdit,
    recordManifest,
  })) {
    if (typeof value !== "function") {
      throw new TypeError(`${name} must be a function`);
    }
  }
}
