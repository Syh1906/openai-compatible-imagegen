import { isStableToolErrorCode, stableToolErrorMessages } from "./tool-errors.mjs";


const DEFAULT_MODEL_PROFILE_ID = "primary/gpt-image-2";


export async function executeImageBatch({
  items,
  concurrency,
  context,
  runTask,
  readArtifact,
  validateEdit,
}) {
  requireBatchDependencies({ items, concurrency, runTask, readArtifact, validateEdit });
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await executeBatchItem({
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
  const succeeded = results.filter((item) => item.ok).length;
  const artifactIds = results.flatMap((item) => (
    item.ok ? item.artifacts.map((artifact) => artifact.id) : []
  ));
  return {
    results,
    summary: {
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
      artifactCount: artifactIds.length,
    },
    artifactIds,
  };
}


async function executeBatchItem({ item, context, runTask, readArtifact, validateEdit }) {
  try {
    if (item.operation === "edit") {
      await validateEdit(item, context);
    }
    const result = await runTask(machineTaskFor(item), context);
    if (!result?.ok) {
      return batchFailure(item, result?.error, "image_task_failed");
    }
    const artifactIds = (result.artifacts || []).map((artifact) => artifact?.id);
    if (
      artifactIds.length < 1
      || artifactIds.some((id) => typeof id !== "string")
    ) {
      return batchFailure(item, null, "image_task_failed");
    }
    try {
      const records = await Promise.all(artifactIds.map((id) => readArtifact(id, context)));
      return {
        requestId: item.requestId,
        operation: item.operation,
        ok: true,
        artifacts: records.map(({ metadata }) => ({ ...metadata })),
      };
    } catch (error) {
      return batchFailure(item, error, "artifact_read_failed");
    }
  } catch (error) {
    return batchFailure(item, error, "image_task_failed");
  }
}


function machineTaskFor(item) {
  const {
    requestId: _requestId,
    operation,
    prompt,
    modelProfileId = DEFAULT_MODEL_PROFILE_ID,
    ...rest
  } = item;
  if (operation === "generate") {
    return {
      operation,
      modelProfileId,
      prompt,
      inputArtifactIds: [],
      annotationId: null,
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
    modelProfileId,
    prompt,
    inputArtifactIds: [parentImageId, ...referenceImageIds],
    annotationId: null,
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


function requireBatchDependencies({ items, concurrency, runTask, readArtifact, validateEdit }) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 10) {
    throw new TypeError("items must contain between 1 and 10 batch tasks");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) {
    throw new TypeError("concurrency must be an integer between 1 and 3");
  }
  for (const [name, value] of Object.entries({ runTask, readArtifact, validateEdit })) {
    if (typeof value !== "function") {
      throw new TypeError(`${name} must be a function`);
    }
  }
}
