import { randomBytes } from "node:crypto";

import { createImageJobStore } from "./image-job-store.mjs";
import {
  digestCanonical, generatedCheckpointSchema, jobError, jobIdentity, jobOutcomeSchema,
  jobSnapshot, jobSpecSchema, scopeHash,
} from "./image-job-contract.mjs";
import { isStableToolErrorCode, stableToolErrorMessages } from "./tool-errors.mjs";

const LEASE_MS = 60_000;
const HEARTBEAT_MS = 10_000;
const MAX_ACTIVE = 8;

export function createImageJobManager({ executeItem, finalizeBatch, store = createImageJobStore(), now = Date.now } = {}) {
  if (typeof executeItem !== "function") throw new TypeError("executeItem is required");
  const owner = randomBytes(16).toString("hex");
  const jobs = new Map();
  const pending = new Set();
  let active = 0;
  let pumping = null;
  let closing = false;
  let nextJob = 0;

  return Object.freeze({ submit, get, cancel, resume, drain, close });

  async function submit({ context, submissionKey, spec: input }) {
    if (closing) throw jobError("image_job_state_unavailable");
    const spec = jobSpecSchema.parse(input);
    const jobId = jobIdentity(context, submissionKey);
    const requestHash = digestCanonical(spec);
    let created = false;
    const record = await store.update({ context, jobId }, (existing) => {
      if (existing) {
        if (existing.requestHash !== requestHash) throw jobError("image_job_conflict");
        return null;
      }
      created = true;
      const timestamp = new Date(now()).toISOString();
      return {
        schemaVersion: "image-job.v1", jobId, scopeHash: scopeHash(context), requestHash,
        configHash: context.effectiveConfigSha256, spec, createdAt: timestamp, updatedAt: timestamp,
        concurrency: spec.kind === "batch" ? spec.concurrency ?? context.runtimeDefaults?.concurrency ?? 3 : 1,
        revision: 0, cancelRequested: false, owner, leaseUntil: now() + LEASE_MS,
        items: Array.from({ length: spec.kind === "batch" ? spec.items.length : 1 }, () => ({
          state: "queued", checkpoint: null, outcome: null, localAttempt: 0,
        })),
        manifest: null, previousBatchIds: [],
      };
    });
    if (created) activate(context, record);
    return jobSnapshot(record, { now: now() });
  }

  async function get({ context, jobId, offset = 0, limit = 10 }) {
    if (!Number.isInteger(offset) || offset < 0 || offset > 63 || !Number.isInteger(limit) || limit < 1 || limit > 10) {
      throw jobError("image_job_state_invalid");
    }
    return jobSnapshot(await store.read({ context, jobId }), { now: now(), offset, limit });
  }

  async function cancel({ context, jobId }) {
    const record = await store.update({ context, jobId }, (record) => {
      if (!record) throw jobError("image_job_not_found");
      record.cancelRequested = true;
      for (const item of record.items) if (item.state === "queued") item.state = "cancelled";
      return touch(record);
    });
    const job = jobs.get(jobId);
    if (job) { job.record = record; kick(); }
    return jobSnapshot(record, { now: now() });
  }

  async function resume({ context, jobId, expectedRevision }) {
    if (closing) throw jobError("image_job_state_unavailable");
    let claimed = false;
    const record = await store.update({ context, jobId }, (record) => {
      if (!record) throw jobError("image_job_not_found");
      if (record.configHash !== context.effectiveConfigSha256) throw jobError("image_job_config_changed");
      if (expectedRevision !== undefined && record.revision !== expectedRevision) return null;
      if (record.owner && record.leaseUntil > now()) return null;
      for (const item of record.items) {
        if (item.state === "running") item.state = item.checkpoint ? "local_failed" : "unknown";
        if (item.state === "local_failed" && item.checkpoint) {
          item.state = "queued";
          item.localAttempt += 1;
          item.outcome = null;
        }
      }
      if (!record.items.some((item) => item.state === "queued") && record.owner === null && (record.spec.kind !== "batch" || record.manifest !== null)) return null;
      if (record.previousBatchIds.length >= 128) throw jobError("image_job_state_invalid");
      if (record.manifest?.batchId) record.previousBatchIds.push(record.manifest.batchId);
      record.manifest = null;
      record.cancelRequested = false;
      record.owner = owner;
      record.leaseUntil = now() + LEASE_MS;
      claimed = true;
      return touch(record);
    });
    if (claimed) activate(context, record);
    return jobSnapshot(record, { now: now() });
  }

  function activate(context, record) {
    const job = { context, record, active: 0, finalizing: false, timer: null };
    jobs.set(record.jobId, job);
    job.timer = setInterval(() => {
      track(ownedUpdate(job, (record) => record).catch(() => halt(job)));
    }, HEARTBEAT_MS);
    job.timer.unref?.();
    kick();
  }

  function kick() {
    if (pumping || closing) return;
    pumping = new Promise((resolve) => setImmediate(resolve)).then(pump).finally(() => { pumping = null; });
  }

  async function pump() {
    while (!closing) {
      const candidates = [...jobs.values()];
      let selected = null;
      for (let offset = 0; offset < candidates.length; offset += 1) {
        const job = candidates[(nextJob + offset) % candidates.length];
        if (job.finalizing) continue;
        if (job.active === 0 && !job.record.items.some((item) => item.state === "queued" || item.state === "running")) {
          job.finalizing = true;
          track(finalize(job));
          continue;
        }
        const limit = job.record.concurrency;
        if (active < MAX_ACTIVE && job.active < limit && job.record.items.some((item) => item.state === "queued")) {
          selected = job;
          nextJob = (nextJob + offset + 1) % candidates.length;
          break;
        }
      }
      if (!selected) return;
      const job = selected;
      let index = -1;
      try {
        await ownedUpdate(job, (record) => {
          if (record.cancelRequested) return record;
          index = record.items.findIndex((item) => item.state === "queued");
          if (index >= 0) record.items[index].state = "running";
          return touch(record);
        });
      } catch { halt(job); continue; }
      if (index < 0) continue;
      active += 1;
      job.active += 1;
      track(runItem(job, index));
    }
  }

  async function runItem(job, index) {
    try {
      const saved = job.record.items[index].checkpoint;
      const outcome = jobOutcomeSchema.parse(await executeItem({
        jobId: job.record.jobId, spec: job.record.spec, index, context: job.context,
        saved, localAttempt: job.record.items[index].localAttempt,
        checkpoint: async (value) => {
          const checkpoint = generatedCheckpointSchema.parse(value);
          await ownedUpdate(job, (record) => {
            record.items[index].checkpoint = checkpoint;
            return touch(record);
          });
        },
        isCancelled: async () => {
          const record = await store.read({ context: job.context, jobId: job.record.jobId });
          assertOwned(record);
          return record.cancelRequested || closing;
        },
      }));
      await ownedUpdate(job, (record) => {
        const item = record.items[index];
        item.outcome = outcome;
        item.state = outcome.result.ok
          ? outcome.result.delivery && !outcome.result.delivery.deliveryReady ? "local_failed" : "succeeded"
          : item.checkpoint ? "local_failed" : outcome.result.error.code === "image_task_failed" ? "unknown" : "failed";
        return touch(record);
      });
    } catch (error) {
      try {
        await ownedUpdate(job, (record) => {
          const item = record.items[index];
          item.state = item.checkpoint ? "local_failed" : "unknown";
          item.outcome = failedOutcome(record, index, error?.code);
          return touch(record);
        });
      } catch { halt(job); }
    } finally {
      active -= 1;
      job.active -= 1;
      kick();
    }
  }

  async function finalize(job) {
    try {
      let manifest = null;
      if (job.record.spec.kind === "batch" && finalizeBatch) {
        const outcomes = job.record.items.map((item, index) => item.outcome ?? failedOutcome(job.record, index,
          item.state === "cancelled" ? "image_job_cancelled" : "image_job_outcome_unknown"));
        manifest = await finalizeBatch(outcomes, job.context);
      }
      await ownedUpdate(job, (record) => {
        record.manifest = manifest;
        record.owner = null;
        record.leaseUntil = 0;
        return touch(record);
      }, { release: true });
    } catch {
      // Leave the durable record in place. Recovery never reissues an uncertain image request.
    } finally {
      halt(job);
    }
  }

  async function ownedUpdate(job, change, { release = false } = {}) {
    const record = await store.update({ context: job.context, jobId: job.record.jobId }, (record) => {
      assertOwned(record);
      const changed = change(record);
      if (!release) changed.leaseUntil = now() + LEASE_MS;
      return changed;
    });
    if (record.revision >= job.record.revision) job.record = record;
    return record;
  }

  function assertOwned(record) {
    if (!record || record.owner !== owner || record.leaseUntil <= now()) throw jobError("image_job_ownership_lost");
  }

  function touch(record) {
    record.revision += 1;
    record.updatedAt = new Date(now()).toISOString();
    return record;
  }

  function halt(job) {
    clearInterval(job.timer);
    if (jobs.get(job.record.jobId) === job) jobs.delete(job.record.jobId);
  }

  function track(promise) {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => {});
  }

  async function drain() {
    for (;;) {
      if (pumping) await pumping;
      if (pending.size) await Promise.allSettled([...pending]);
      if (!pumping && !pending.size) return;
    }
  }

  async function close() {
    closing = true;
    await drain();
    for (const job of jobs.values()) {
      try {
        await ownedUpdate(job, (record) => { record.owner = null; record.leaseUntil = 0; return touch(record); }, { release: true });
      } catch { /* Another owner can only recover queued or checkpointed work. */ }
      halt(job);
    }
  }
}

function failedOutcome(record, index, candidateCode) {
  const code = isStableToolErrorCode(candidateCode) ? candidateCode : "image_task_failed";
  const operation = record.spec.kind === "batch" ? record.spec.items[index].operation : record.spec.kind;
  const requestId = record.spec.kind === "batch" ? record.spec.items[index].requestId : "image";
  return {
    result: { requestId, operation, ok: false, error: { code, message: stableToolErrorMessages.get(code) } },
    manifestResult: { requestId, operation, ok: false, errorCode: code },
    publishedArtifactIds: record.items[index].checkpoint?.artifacts.map(({ id }) => id) ?? [],
  };
}
