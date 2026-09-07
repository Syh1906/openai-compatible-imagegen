import { createHash } from "node:crypto";

import { executeBatchItem, finalizeImageBatch, safeApiDelivery } from "./batch-images.mjs";
import { generatedCheckpointSchema } from "./image-job-contract.mjs";
import { stableToolErrorCodeFromText, stableToolErrorMessages } from "./tool-errors.mjs";

export function createImageJobExecutor({ runTask, readArtifact, validateEdit, executeSingle }) {
  return Object.freeze({ executeItem, finalizeBatch });

  async function executeItem({ jobId, spec, index, context, checkpoint, saved, localAttempt, isCancelled }) {
    const runJobTask = async (task) => {
      let generated = saved;
      if (!generated) {
        const result = await runTask({ ...task, ...(task.delivery ? { deferDelivery: true } : {}) }, context);
        if (!result?.ok) return result;
        const apiDelivery = safeApiDelivery(result.apiDelivery, result.artifacts.map(({ id }) => id), task.output?.count ?? 1);
        generated = generatedCheckpointSchema.parse({
          ok: true, artifacts: result.artifacts.map(({ id }) => ({ id })),
          ...(apiDelivery ? { apiDelivery } : {}),
        });
        // Persist the original IDs before metadata reads or any local delivery starts.
        await checkpoint(generated);
      }
      if (!task.delivery) return generated;
      const deliveries = [];
      const delivery = { ...task.delivery };
      if (!task.transparency) delete delivery.transparency;
      for (const { id: sourceId } of generated.artifacts) {
        if (await isCancelled()) {
          deliveries.push({ ok: false, sourceArtifactId: sourceId, error: { code: "image_job_cancelled" } });
          continue;
        }
        const deliveryReceiptId = `delivery_${createHash("sha256").update(`${jobId}\0${index}\0${localAttempt}\0${sourceId}`).digest("hex")}`;
        try {
          deliveries.push(await runTask({
            operation: "deliver", modelProfileId: task.modelProfileId,
            inputArtifactIds: [sourceId], delivery, deliveryReceiptId,
          }, context));
        } catch {
          deliveries.push({ ok: false, sourceArtifactId: sourceId, error: { code: "image_task_failed" } });
        }
      }
      return { ...generated, deliveries };
    };
    if (spec.kind === "batch") {
      return await executeBatchItem({ item: spec.items[index], context, runTask: runJobTask, readArtifact, validateEdit });
    }
    const result = await executeSingle({ kind: spec.kind, request: spec.request, context, runTask: runJobTask });
    const artifacts = result?.structuredContent?.artifacts;
    if (!result?.isError && artifacts?.length) {
      return {
        result: { requestId: "image", operation: spec.kind, ok: true, artifacts },
        manifestResult: null, publishedArtifactIds: artifacts.map(({ id }) => id),
      };
    }
    const code = stableToolErrorCodeFromText(result?.content?.[0]?.text) ?? "image_task_failed";
    return {
      result: { requestId: "image", operation: spec.kind, ok: false, error: { code, message: stableToolErrorMessages.get(code) } },
      manifestResult: null, publishedArtifactIds: [],
    };
  }

  async function finalizeBatch(outcomes, context) {
    const result = await finalizeImageBatch({ outcomes, context, recordManifest: async (manifest) => await runTask({
      operation: "record_batch", modelProfileId: context.activeProfile || "primary/gpt-image-2", manifest,
    }, context) });
    const { manifestReady, batchId, manifestCreatedAt, manifestError } = result;
    return { manifestReady, ...(batchId ? { batchId, manifestCreatedAt } : {}), ...(manifestError ? { manifestError } : {}) };
  }
}
