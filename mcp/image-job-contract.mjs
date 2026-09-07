import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

import {
  apiDeliverySchema, batchIdSchema, batchItemsSchema, batchManifestResultSchema,
  imageBatchResultOutputSchema, imageIdSchema, outputSchema, transparencyInputSchema,
} from "./image-tool-schemas.mjs";

export const jobIdSchema = z.string().regex(/^job_[a-f0-9]{64}$/);
export const submissionKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .describe("Stable key for this intended submission. Reuse exactly after a lost reply; use a new key only for a new generation intent.");
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const generationRequestSchema = z.object({
  prompt: z.string().min(1), modelProfileId: z.string().min(1).optional(),
  transparency: transparencyInputSchema.optional(), ...outputSchema,
}).strict();
const editRequestSchema = generationRequestSchema.extend({
  parentImageId: imageIdSchema,
  referenceImageIds: z.array(imageIdSchema).optional(),
  annotationId: z.string().regex(/^ann_[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  submissionId: z.string().regex(/^sub_[0-9a-f]{32}$/).optional(),
});
export const jobSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("batch"), items: batchItemsSchema, concurrency: z.number().int().min(1).max(8).optional() }).strict(),
  z.object({ kind: z.literal("generate"), request: generationRequestSchema }).strict(),
  z.object({ kind: z.literal("edit"), request: editRequestSchema }).strict(),
]);
export const generatedCheckpointSchema = z.object({
  ok: z.literal(true), artifacts: z.array(z.object({ id: imageIdSchema }).strict()).min(1).max(16),
  apiDelivery: apiDeliverySchema.optional(),
}).strict();
export const jobOutcomeSchema = z.object({
  result: imageBatchResultOutputSchema,
  manifestResult: batchManifestResultSchema.nullable(),
  publishedArtifactIds: z.array(imageIdSchema).max(16),
}).strict();
export const itemStateSchema = z.enum(["queued", "running", "succeeded", "failed", "unknown", "cancelled", "local_failed"]);
const itemRecordSchema = z.object({
  state: itemStateSchema, checkpoint: generatedCheckpointSchema.nullable(),
  outcome: jobOutcomeSchema.nullable(), localAttempt: z.number().int().nonnegative(),
}).strict();
const manifestSchema = z.object({
  manifestReady: z.boolean(), batchId: batchIdSchema.optional(), manifestCreatedAt: z.string().datetime().optional(),
  manifestError: z.object({ code: z.string(), message: z.string() }).strict().optional(),
}).strict();
export const jobRecordSchema = z.object({
  schemaVersion: z.literal("image-job.v1"), jobId: jobIdSchema, scopeHash: digestSchema,
  requestHash: digestSchema, configHash: digestSchema, spec: jobSpecSchema,
  concurrency: z.number().int().min(1).max(8),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), revision: z.number().int().nonnegative(),
  cancelRequested: z.boolean(), owner: z.string().regex(/^[a-f0-9]{32}$/).nullable(),
  leaseUntil: z.number().nonnegative(), items: z.array(itemRecordSchema).min(1).max(64),
  manifest: manifestSchema.nullable(), previousBatchIds: z.array(batchIdSchema).max(128),
}).strict().superRefine((record, context) => {
  if (record.items.length !== (record.spec.kind === "batch" ? record.spec.items.length : 1)
    || record.requestHash !== digestCanonical(record.spec)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "image job request does not match its record" });
  }
});
const countSchema = z.number().int().min(0).max(64);
export const imageJobOutputSchema = z.object({
  jobId: jobIdSchema, kind: z.enum(["batch", "generate", "edit"]),
  status: z.enum(["queued", "running", "completed", "partial", "failed", "cancelled", "interrupted"]),
  done: z.boolean(), resumable: z.boolean(), cancelRequested: z.boolean(), revision: z.number().int().nonnegative(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  summary: z.object({ total: countSchema, queued: countSchema, running: countSchema, succeeded: countSchema,
    failed: countSchema, unknown: countSchema, cancelled: countSchema, localFailed: countSchema }).strict(),
  items: z.array(z.object({
    index: z.number().int().min(0).max(63), requestId: z.string(), state: itemStateSchema,
    artifactIds: z.array(imageIdSchema).max(16), result: imageBatchResultOutputSchema.optional(),
  }).strict()).max(10),
  nextOffset: z.number().int().min(1).max(63).nullable(),
  manifest: manifestSchema.nullable(),
}).strict();

export function jobError(code) {
  return Object.assign(new Error(code), { code });
}

export function scopeHash(context) {
  if (typeof context?.projectRoot !== "string" || !path.isAbsolute(context.projectRoot)) throw jobError("image_job_state_invalid");
  const root = path.resolve(context.projectRoot);
  return digestCanonical(process.platform === "win32" ? root.toLowerCase() : root);
}

export function jobIdentity(context, submissionKey) {
  submissionKeySchema.parse(submissionKey);
  return `job_${digestCanonical(["image-job.v1", scopeHash(context), submissionKey])}`;
}

export function digestCanonical(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function jobSnapshot(record, { now = Date.now(), offset = 0, limit = 10 } = {}) {
  const expired = record.owner !== null && record.leaseUntil <= now;
  const summary = { total: record.items.length, queued: 0, running: 0, succeeded: 0, failed: 0, unknown: 0, cancelled: 0, localFailed: 0 };
  const states = record.items.map((item) => expired && item.state === "running" ? (item.checkpoint ? "local_failed" : "unknown") : item.state);
  for (const state of states) summary[state === "local_failed" ? "localFailed" : state] += 1;
  const pending = summary.queued + summary.running;
  const interrupted = expired || (record.owner === null && pending > 0);
  const status = interrupted ? "interrupted"
    : summary.running ? "running" : summary.queued ? "queued"
      : summary.succeeded === summary.total ? "completed"
        : summary.cancelled === summary.total ? "cancelled"
          : summary.succeeded || summary.localFailed ? "partial" : "failed";
  return imageJobOutputSchema.parse({
    jobId: record.jobId, kind: record.spec.kind, status, done: !pending && !interrupted && record.owner === null,
    resumable: Boolean(summary.localFailed || interrupted),
    cancelRequested: record.cancelRequested, revision: record.revision,
    createdAt: record.createdAt, updatedAt: record.updatedAt, summary,
    items: record.items.slice(offset, offset + limit).map((item, i) => ({
      index: offset + i, requestId: record.spec.kind === "batch" ? record.spec.items[offset + i].requestId : "image",
      state: states[offset + i],
      artifactIds: item.checkpoint?.artifacts.map(({ id }) => id) ?? item.outcome?.publishedArtifactIds ?? [],
      ...(item.outcome ? { result: item.outcome.result } : {}),
    })),
    nextOffset: offset + limit < record.items.length ? offset + limit : null,
    manifest: record.manifest,
  });
}
