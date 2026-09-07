import assert from "node:assert/strict";
import test from "node:test";

import { artifact, withClient } from "../support/mcp-tool-client.mjs";

const IMAGE_ID = `img_${"0".repeat(26)}`;
const DERIVED_ID = `img_${"1".repeat(26)}`;

test("MCP generation returns a queryable job before the provider completes and deduplicates the submission key", async () => {
  let finish;
  let requests = 0;
  await withClient({ rawImageJobs: true,
    runTask: async () => {
      requests += 1;
      await new Promise((resolve) => { finish = resolve; });
      return { ok: true, artifacts: [{ id: IMAGE_ID }] };
    }, readArtifact: async (id) => ({ metadata: artifact(id) }),
  }, async (client) => {
    const request = { name: "generate_image", arguments: { submissionKey: "single-generation", prompt: "one image", count: 3 } };
    const submitted = await client.callTool(request);
    assert.equal(submitted.isError, undefined);
    assert.match(submitted.structuredContent.jobId, /^job_/);
    assert.equal(submitted.structuredContent.done, false);
    await until(() => finish);
    try {
      const repeated = await client.callTool(request);
      assert.equal(repeated.structuredContent.jobId, submitted.structuredContent.jobId);
      assert.equal(requests, 1);
      const tools = (await client.listTools()).tools;
      for (const name of ["generate_image", "edit_image", "batch_images"]) {
        const tool = tools.find((entry) => entry.name === name);
        assert.ok(tool.inputSchema.required.includes("submissionKey"));
        assert.ok(tool.outputSchema.required.includes("jobId"));
      }
      for (const name of ["get_image_job", "cancel_image_job", "resume_image_job"]) assert.ok(tools.some((tool) => tool.name === name));
      assert.equal(tools.find((tool) => tool.name === "cancel_image_job").annotations.destructiveHint, true);
    } finally { finish(); }
    const job = await waitDone(client, submitted.structuredContent.jobId);
    assert.equal(job.summary.succeeded, 1);
    assert.deepEqual(job.items[0].artifactIds, [IMAGE_ID]);
    assert.equal(job.items[0].result.artifacts[0].id, IMAGE_ID);
  });
});

test("an MCP query timeout cancels only the wait and the same job remains recoverable", async () => {
  let finish;
  let calls = 0;
  await withClient({ rawImageJobs: true,
    runTask: async () => {
      calls += 1;
      await new Promise((resolve) => { finish = resolve; });
      return { ok: true, artifacts: [{ id: IMAGE_ID }] };
    }, readArtifact: async (id) => ({ metadata: artifact(id) }),
  }, async (client) => {
    const submitted = await client.callTool({ name: "generate_image", arguments: { submissionKey: "timeout", prompt: "image" } });
    const jobId = submitted.structuredContent.jobId;
    await until(() => finish);
    try {
      const current = await client.callTool({ name: "get_image_job", arguments: { jobId } });
      await assert.rejects(client.callTool({ name: "get_image_job", arguments: { jobId, afterRevision: current.structuredContent.revision, waitMs: 20_000 } }, undefined, { timeout: 40 }), { code: -32001 });
      const after = await client.callTool({ name: "get_image_job", arguments: { jobId } });
      assert.equal(after.structuredContent.summary.running, 1);
      assert.equal(after.structuredContent.cancelRequested, false);
      assert.equal(calls, 1);
    } finally { finish(); }
    assert.equal((await waitDone(client, jobId)).status, "completed");
  });
});

async function waitDone(client, jobId) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await client.callTool({ name: "get_image_job", arguments: { jobId } });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    if (result.structuredContent.done) return result.structuredContent;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("job did not finish");
}

test("batch jobs checkpoint originals before delivery and resume local failures without regeneration", async () => {
  let imageRequests = 0;
  let deliveries = 0;
  let jobId;
  let activeClient;
  const receiptIds = [];
  await withClient({ rawImageJobs: true,
    runTask: async (task) => {
      if (task.operation === "record_batch") return { ok: true, manifest: { batchId: `batch_${"0".repeat(26)}`, createdAt: new Date().toISOString() } };
      if (task.operation === "generate") {
        imageRequests += 1;
        assert.equal(task.deferDelivery, true);
        return { ok: true, artifacts: [{ id: IMAGE_ID }], apiDelivery: {
          status: "published", requestedCount: 1, returnedCount: 1, publishedCount: 1,
          items: [{ responseIndex: 1, artifactId: IMAGE_ID, actualFormat: "png", width: 1, height: 1 }], issues: [],
        } };
      }
      assert.equal(task.operation, "deliver");
      const status = await activeClient.callTool({ name: "get_image_job", arguments: { jobId } });
      assert.deepEqual(status.structuredContent.items[0].artifactIds, [IMAGE_ID]);
      deliveries += 1;
      receiptIds.push(task.deliveryReceiptId);
      if (deliveries === 1) throw new Error("local processing failed");
      return { ok: true, sourceArtifactId: IMAGE_ID, deliveryReady: true, deliveryReceiptId: task.deliveryReceiptId, artifacts: [{ id: DERIVED_ID }] };
    }, readArtifact: async (id) => ({ metadata: artifact(id) }),
  }, async (client) => {
    activeClient = client;
    const submitted = await client.callTool({ name: "batch_images", arguments: { submissionKey: "local-recovery", items: [{
      requestId: "first", operation: "generate", prompt: "image", delivery: { deliverySize: "2x2" },
    }] } });
    jobId = submitted.structuredContent.jobId;
    const failed = await waitDone(client, jobId);
    assert.equal(failed.summary.localFailed, 1);
    const request = { name: "resume_image_job", arguments: { jobId, expectedRevision: failed.revision } };
    await client.callTool(request);
    const recovered = await waitDone(client, jobId);
    assert.equal(recovered.summary.succeeded, 1);
    assert.equal(recovered.items[0].result.delivery.deliveryReady, true);
    assert.equal(imageRequests, 1);
    assert.equal(deliveries, 2);
    assert.notEqual(receiptIds[0], receiptIds[1]);
    await client.callTool(request);
    assert.equal(deliveries, 2);
  });
});

async function until(predicate) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("provider stub did not start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
