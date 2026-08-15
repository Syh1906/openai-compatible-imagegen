import assert from "node:assert/strict";
import test from "node:test";

import { executeImageBatch } from "../mcp/batch-images.mjs";


const PARENT_ID = "img_01J00000000000000000000000";
const REFERENCE_ID = "img_01J00000000000000000000001";
const RESULT_IDS = [
  "img_01J00000000000000000000002",
  "img_01J00000000000000000000003",
  "img_01J00000000000000000000004",
];
const BATCH_ID = "batch_01J00000000000000000000000";
const MANIFEST_CREATED_AT = "2026-08-14T00:00:00.000Z";


test("batch execution preserves input order and bounds heterogeneous task concurrency", async () => {
  const tasks = [];
  let active = 0;
  let maximumActive = 0;
  let nextResult = 0;
  let recordedManifest;
  const result = await executeImageBatch({
    items: [
      { requestId: "generate-a", operation: "generate", prompt: "first", count: 1 },
      {
        requestId: "edit-b",
        operation: "edit",
        parentImageId: PARENT_ID,
        referenceImageIds: [REFERENCE_ID],
        prompt: "second",
        quality: "high",
      },
      { requestId: "generate-c", operation: "generate", prompt: "third", format: "png" },
    ],
    concurrency: 2,
    context: { bindingKey: "project" },
    validateEdit: async () => {},
    recordManifest: async (manifest) => {
      recordedManifest = manifest;
      return {
        ok: true,
        manifest: { batchId: BATCH_ID, createdAt: MANIFEST_CREATED_AT },
      };
    },
    runTask: async (task) => {
      const resultId = RESULT_IDS[nextResult];
      nextResult += 1;
      tasks.push(task);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { ok: true, artifacts: [{ id: resultId }], apiDelivery: apiDelivery(resultId) };
    },
    readArtifact: async (id) => ({ metadata: artifact(id) }),
  });

  assert.equal(maximumActive, 2);
  assert.deepEqual(result.results.map((item) => item.requestId), ["generate-a", "edit-b", "generate-c"]);
  assert.deepEqual(result.artifactIds, RESULT_IDS);
  assert.deepEqual(result.summary, { total: 3, succeeded: 3, failed: 0, artifactCount: 3 });
  assert.equal(result.manifestReady, true);
  assert.equal(result.batchId, BATCH_ID);
  assert.deepEqual(result.results[0].apiDelivery, apiDelivery(RESULT_IDS[0]));
  assert.equal(recordedManifest.schemaVersion, "batch-manifest.v1");
  assert.equal(recordedManifest.results.length, 3);
  assert.deepEqual(tasks[0], {
    operation: "generate",
    executionMode: "batch-item",
    modelProfileId: "primary/gpt-image-2",
    prompt: "first",
    inputArtifactIds: [],
    annotationId: null,
    output: { count: 1 },
  });
  assert.deepEqual(tasks[1], {
    operation: "edit",
    executionMode: "batch-item",
    modelProfileId: "primary/gpt-image-2",
    prompt: "second",
    inputArtifactIds: [PARENT_ID, REFERENCE_ID],
    annotationId: null,
    output: { quality: "high" },
  });
});


test("batch execution returns safe per-item failures without discarding successful peers", async () => {
  const privateText = "provider secret at C:/Users/private/auth.json";
  const result = await executeImageBatch({
    items: [
      { requestId: "failed", operation: "generate", prompt: "first" },
      { requestId: "passed", operation: "generate", prompt: "second" },
    ],
    concurrency: 1,
    context: { bindingKey: "project" },
    validateEdit: async () => {},
    recordManifest: async () => ({
      ok: true,
      manifest: { batchId: BATCH_ID, createdAt: MANIFEST_CREATED_AT },
    }),
    runTask: async (task) => {
      if (task.prompt === "first") throw new Error(privateText);
      return { ok: true, artifacts: [{ id: RESULT_IDS[0] }], apiDelivery: apiDelivery(RESULT_IDS[0]) };
    },
    readArtifact: async (id) => ({ metadata: artifact(id) }),
  });

  assert.deepEqual(result.results[0], {
    requestId: "failed",
    operation: "generate",
    ok: false,
    error: { code: "image_task_failed", message: "图片任务执行失败。" },
  });
  assert.equal(result.results[1].ok, true);
  assert.deepEqual(result.summary, { total: 2, succeeded: 1, failed: 1, artifactCount: 1 });
  assert.equal(JSON.stringify(result).includes(privateText), false);
  assert.equal(JSON.stringify(result).includes("C:/Users/private"), false);
});


test("batch edit validation becomes a stable item failure before the runtime starts", async () => {
  let runtimeCalls = 0;
  const error = new Error("pending canvas details");
  error.code = "missing_edit_submission";
  const result = await executeImageBatch({
    items: [{ requestId: "edit-a", operation: "edit", parentImageId: PARENT_ID, prompt: "edit" }],
    concurrency: 1,
    context: { bindingKey: "project" },
    validateEdit: async () => { throw error; },
    recordManifest: async () => ({
      ok: true,
      manifest: { batchId: BATCH_ID, createdAt: MANIFEST_CREATED_AT },
    }),
    runTask: async () => {
      runtimeCalls += 1;
      return { ok: true, artifacts: [{ id: RESULT_IDS[0] }], apiDelivery: apiDelivery(RESULT_IDS[0]) };
    },
    readArtifact: async (id) => ({ metadata: artifact(id) }),
  });

  assert.equal(runtimeCalls, 0);
  assert.deepEqual(result.results[0].error, {
    code: "missing_edit_submission",
    message: "当前图片存在待发送画布提交，但缺少提交 ID。",
  });
});


function artifact(id) {
  return {
    id,
    parentIds: [],
    childIds: [],
    mimeType: "image/png",
    width: 1,
    height: 1,
    provider: "primary",
    model: "gpt-image-2",
    operation: "generate",
    prompt: "batch",
    parameters: {},
    annotationId: null,
    createdAt: "2026-08-14T00:00:00.000Z",
  };
}


function apiDelivery(artifactId, requestedCount = 1) {
  return {
    status: "published",
    requestedCount,
    returnedCount: requestedCount,
    publishedCount: 1,
    items: [{
      responseIndex: 1,
      artifactId,
      actualFormat: "png",
      width: 1,
      height: 1,
    }],
    issues: [],
  };
}
