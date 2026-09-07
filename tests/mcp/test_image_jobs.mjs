import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createImageJobManager } from "../../mcp/image-job-manager.mjs";
import { createImageJobStore } from "../../mcp/image-job-store.mjs";

const IMAGE_ID = `img_${"0".repeat(26)}`;
const outcome = (index) => ({
  result: { requestId: `item-${index}`, operation: "generate", ok: false,
    error: { code: "image_task_failed", message: "图片任务执行失败。" } },
  manifestResult: { requestId: `item-${index}`, operation: "generate", ok: false, errorCode: "image_task_failed" },
  publishedArtifactIds: [],
});
const spec = (count = 40, concurrency = 8) => ({
  kind: "batch", concurrency,
  items: Array.from({ length: count }, (_, i) => ({ requestId: `item-${i}`, operation: "generate", prompt: `Image ${i}` })),
});

test("submission returns a durable ID before a 40-item pool completes, and repeated submissions do not regenerate", async () => {
  await fixture(async (context) => {
    const gates = [];
    let started = 0;
    const manager = createImageJobManager({ executeItem: async ({ index }) => {
      started += 1;
      await new Promise((resolve) => gates.push(resolve));
      return outcome(index);
    } });
    try {
      const receipt = await manager.submit({ context, submissionKey: "forty-images", spec: spec() });
      assert.match(receipt.jobId, /^job_[a-f0-9]{64}$/);
      assert.equal(receipt.summary.total, 40);
      await until(() => started === 8);
      const duplicate = await manager.submit({ context, submissionKey: "forty-images", spec: spec() });
      assert.equal(duplicate.jobId, receipt.jobId);
      assert.equal(started, 8);
      const fromDisk = await createImageJobStore().read({ context, jobId: receipt.jobId });
      assert.equal(fromDisk.items.length, 40);
      for (let wave = 0; wave < 5; wave += 1) {
        await until(() => gates.length === 8);
        gates.splice(0).forEach((resolve) => resolve());
        if (wave < 4) await until(() => started === (wave + 2) * 8);
      }
      await manager.drain();
      const final = await manager.get({ context, jobId: receipt.jobId });
      assert.equal(final.done, true);
      assert.equal(started, 40);
      assert.equal(final.summary.failed + final.summary.unknown, 40);
    } finally {
      gates.splice(0).forEach((resolve) => resolve());
      await manager.close();
    }
  });
});

test("one executor shares its eight slots across batches and honors a smaller per-job limit", async () => {
  await fixture(async (context) => {
    let active = 0;
    let peak = 0;
    const counts = new Map();
    const gates = [];
    const manager = createImageJobManager({ executeItem: async ({ jobId, index }) => {
      active += 1; peak = Math.max(peak, active);
      counts.set(jobId, (counts.get(jobId) ?? 0) + 1);
      await new Promise((resolve) => gates.push(resolve));
      active -= 1;
      counts.set(jobId, counts.get(jobId) - 1);
      return outcome(index);
    } });
    try {
      const first = await manager.submit({ context, submissionKey: "limited", spec: spec(8, 2) });
      await manager.submit({ context, submissionKey: "other", spec: spec(8) });
      await until(() => active === 8);
      assert.equal(counts.get(first.jobId), 2);
      assert.equal(peak, 8);
      await manager.cancel({ context, jobId: first.jobId });
    } finally {
      const closing = manager.close();
      gates.splice(0).forEach((resolve) => resolve());
      await closing;
      assert.ok(peak <= 8);
    }
  });
});

test("cancellation stops queued work and does not claim in-flight provider requests were revoked", async () => {
  await fixture(async (context) => {
    let release;
    let started = 0;
    const manager = createImageJobManager({ executeItem: async ({ index }) => {
      started += 1;
      await new Promise((resolve) => { release = resolve; });
      return outcome(index);
    } });
    const receipt = await manager.submit({ context, submissionKey: "cancel", spec: spec(3, 1) });
    await until(() => release);
    const cancelled = await manager.cancel({ context, jobId: receipt.jobId });
    assert.equal(cancelled.summary.running, 1);
    assert.equal(cancelled.summary.cancelled, 2);
    release();
    await manager.drain();
    assert.equal(started, 1);
    await manager.close();
  });
});

test("a second executor cannot run a live job, and an expired in-flight item is never replayed", async () => {
  await fixture(async (context) => {
    let now = 1000;
    let release;
    let firstCalls = 0;
    let secondCalls = 0;
    const first = createImageJobManager({ now: () => now, executeItem: async ({ index }) => {
      firstCalls += 1;
      await new Promise((resolve) => { release = resolve; });
      return outcome(index);
    } });
    const second = createImageJobManager({ now: () => now, executeItem: async ({ index }) => {
      secondCalls += 1;
      return outcome(index);
    } });
    try {
      const receipt = await first.submit({ context, submissionKey: "restart", spec: spec(2, 1) });
      await until(() => release);
      await second.submit({ context, submissionKey: "restart", spec: spec(2, 1) });
      assert.equal(secondCalls, 0);
      now += 120_000;
      const interrupted = await second.get({ context, jobId: receipt.jobId });
      assert.equal(interrupted.status, "interrupted");
      await second.resume({ context, jobId: receipt.jobId });
      await second.drain();
      assert.equal(secondCalls, 1);
      release();
      await first.drain();
      const final = await second.get({ context, jobId: receipt.jobId });
      assert.equal(firstCalls, 1);
      assert.equal(final.items[0].state, "unknown");
    } finally {
      release?.();
      await first.close();
      await second.close();
    }
  });
});

test("a saved generation checkpoint allows local recovery without another image request", async () => {
  await fixture(async (context) => {
    let calls = 0;
    const manager = createImageJobManager({ executeItem: async ({ index, checkpoint, saved }) => {
      if (!saved) {
        calls += 1;
        await checkpoint({ ok: true, artifacts: [{ id: IMAGE_ID }] });
        throw new Error("lost local result");
      }
      assert.equal(saved.artifacts[0].id, IMAGE_ID);
      return outcome(index);
    } });
    const receipt = await manager.submit({ context, submissionKey: "checkpoint", spec: spec(1, 1) });
    await manager.drain();
    const before = await manager.get({ context, jobId: receipt.jobId });
    assert.deepEqual(before.items[0].artifactIds, [IMAGE_ID]);
    await manager.resume({ context, jobId: receipt.jobId });
    await manager.drain();
    assert.equal(calls, 1);
    await manager.close();
  });
});

test("submission keys reject changed requests and recovery rejects a changed configuration", async () => {
  await fixture(async (context) => {
    const manager = createImageJobManager({ executeItem: async ({ index }) => outcome(index) });
    const receipt = await manager.submit({ context, submissionKey: "stable", spec: spec(1) });
    await assert.rejects(manager.submit({ context, submissionKey: "stable", spec: spec(2) }), { code: "image_job_conflict" });
    await assert.rejects(manager.resume({ context: { ...context, effectiveConfigSha256: "1".repeat(64) }, jobId: receipt.jobId }), { code: "image_job_config_changed" });
    await manager.close();
  });
});

test("status queries return bounded pages without replaying any work", async () => {
  await fixture(async (context) => {
    const manager = createImageJobManager({ executeItem: async ({ index }) => outcome(index) });
    const receipt = await manager.submit({ context, submissionKey: "pages", spec: spec(40) });
    await manager.drain();
    const page = await manager.get({ context, jobId: receipt.jobId, offset: 10, limit: 10 });
    assert.equal(page.items.length, 10);
    assert.equal(page.items[0].index, 10);
    assert.equal(page.nextOffset, 20);
    await manager.close();
  });
});

test("a lost reply can be recovered with the same key after defaults change without changing the saved concurrency", async () => {
  await fixture(async (context) => {
    const manager = createImageJobManager({ executeItem: async ({ index }) => outcome(index) });
    const request = { kind: "batch", items: spec(1).items };
    const receipt = await manager.submit({ context: { ...context, runtimeDefaults: { concurrency: 2 } }, submissionKey: "defaults", spec: request });
    const repeated = await manager.submit({ context: { ...context, runtimeDefaults: { concurrency: 8 }, effectiveConfigSha256: "1".repeat(64) }, submissionKey: "defaults", spec: request });
    assert.equal(repeated.jobId, receipt.jobId);
    assert.equal((await createImageJobStore().read({ context, jobId: receipt.jobId })).concurrency, 2);
    await manager.close();
  });
});

test("interrupted manifest publication can resume without issuing another image request", async () => {
  await fixture(async (context) => {
    let now = 1000;
    let calls = 0;
    let finalizations = 0;
    const manager = createImageJobManager({ now: () => now,
      executeItem: async ({ index }) => { calls += 1; return outcome(index); },
      finalizeBatch: async () => {
        if (++finalizations === 1) throw new Error("interrupted manifest write");
        return { manifestReady: true };
      },
    });
    try {
      const receipt = await manager.submit({ context, submissionKey: "manifest-recovery", spec: spec(1) });
      await manager.drain();
      now += 120_000;
      const interrupted = await manager.get({ context, jobId: receipt.jobId });
      assert.equal(interrupted.status, "interrupted");
      assert.equal(interrupted.resumable, true);
      await manager.resume({ context, jobId: receipt.jobId, expectedRevision: interrupted.revision });
      await manager.drain();
      const final = await manager.get({ context, jobId: receipt.jobId });
      assert.equal(final.done, true);
      assert.equal(final.manifest.manifestReady, true);
      assert.equal(calls, 1);
    } finally { await manager.close(); }
  });
});

test("missing job queries create no state and linked state directories are rejected", async () => {
  await fixture(async (context) => {
    const store = createImageJobStore();
    const jobId = `job_${"0".repeat(64)}`;
    await assert.rejects(store.read({ context, jobId }), { code: "image_job_not_found" });
    assert.deepEqual(await readdir(context.artifactRoot), []);
    const outside = path.join(context.projectRoot, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(context.artifactRoot, ".runtime"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(store.read({ context, jobId }), { code: "image_job_state_invalid" });
    await assert.rejects(store.update({ context, jobId }, () => { throw new Error("must not mutate"); }), { code: "image_job_state_invalid" });
    assert.deepEqual(await readdir(outside), []);
  });
});

async function fixture(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-jobs-"));
  const artifactRoot = path.join(projectRoot, "images");
  await mkdir(artifactRoot);
  try {
    await callback({ projectRoot, artifactRoot, bindingKey: "0".repeat(64), effectiveConfigSha256: "0".repeat(64) });
  } finally {
    await rm(projectRoot, { recursive: true });
  }
}

async function until(predicate) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("job did not reach the expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
