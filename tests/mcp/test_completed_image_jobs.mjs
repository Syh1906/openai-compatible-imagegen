import assert from "node:assert/strict";
import test from "node:test";

import { withCompletedImageJobs } from "../support/image-job-test-client.mjs";

const completed = {
  content: [],
  structuredContent: {
    jobId: "job-test", done: true, revision: 1, nextOffset: null,
    items: [{ state: "succeeded", artifactIds: ["image-test"], result: { ok: true, artifacts: [{ id: "image-test" }] } }],
  },
};

for (const phase of ["progress", "results"]) {
  test(`completed image client honors caller cancellation during ${phase} queries`, async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled the request");
    const call = withCompletedImageJobs(async (request, _schema, options) => {
      if (request.name === "generate_image") {
        controller.abort(reason);
        return { ...completed, structuredContent: { ...completed.structuredContent, done: phase === "results" } };
      }
      options?.signal?.throwIfAborted();
      return completed;
    });
    await assert.rejects(call({ name: "generate_image", arguments: { prompt: "image" } }, undefined, {
      signal: controller.signal, timeout: 50,
    }), (error) => error === reason);
  });
}

test("completed image client reports terminal items without an outcome explicitly", async () => {
  const call = withCompletedImageJobs(async () => ({
    ...completed,
    structuredContent: { ...completed.structuredContent, items: [{ state: "cancelled", artifactIds: [] }] },
  }));
  await assert.rejects(call({ name: "batch_images", arguments: { items: [] } }), {
    name: "AssertionError", message: /image job item ended as cancelled without a completed outcome/,
  });
});
