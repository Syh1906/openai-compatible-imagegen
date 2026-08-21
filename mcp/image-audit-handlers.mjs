import {
  safeDeliveryQa,
  safeDeliverySummary,
  safeDeliveryWarnings,
} from "./delivery-result.mjs";
import {
  batchManifestOutputSchema,
  imageIdSchema,
} from "./image-tool-schemas.mjs";


export function createImageAuditHandlers({ runTask, readArtifact }) {
  return {
    getBatchManifest: async ({ batchId, context }) => {
      requireDependency(runTask, "runTask");
      const result = await runTask({
        operation: "get_batch_manifest",
        modelProfileId: context.activeProfile,
        batchId,
      }, context);
      if (!result?.ok) {
        throw runtimeFailure(result, "batch manifest read failed");
      }
      const parsed = batchManifestOutputSchema.safeParse(result.manifest);
      if (!parsed.success || parsed.data.batchId !== batchId) {
        throw new Error("batch manifest result is invalid");
      }
      const imageIds = parsed.data.results.flatMap((item) => (
        item.ok ? [...item.artifactIds, ...item.deliveryArtifactIds] : []
      ));
      return {
        content: [{
          type: "text",
          text: `批处理记录 ${batchId}：成功 ${parsed.data.summary.succeeded} 项，失败 ${parsed.data.summary.failed} 项。`,
        }],
        structuredContent: parsed.data,
        _meta: { imageIds, batchId },
      };
    },

    getDeliveryReceipt: async ({ deliveryReceiptId, context }) => {
      requireDependency(runTask, "runTask");
      requireDependency(readArtifact, "readArtifact");
      const result = await runTask({
        operation: "get_delivery_receipt",
        modelProfileId: context.activeProfile,
        deliveryReceiptId,
      }, context);
      if (!result?.ok) {
        throw runtimeFailure(result, "delivery receipt read failed");
      }
      const receipt = result.receipt;
      if (
        result.deliveryReceiptId !== deliveryReceiptId
        || !receipt
        || !imageIdSchema.safeParse(receipt.sourceArtifactId).success
      ) {
        throw new Error("delivery receipt result is invalid");
      }
      const artifactIds = Array.isArray(receipt.artifacts)
        ? receipt.artifacts.map((artifact) => artifact?.id)
        : [];
      if (
        artifactIds.length > 10
        || artifactIds.some((id) => !imageIdSchema.safeParse(id).success)
      ) {
        throw new Error("delivery receipt artifacts are invalid");
      }

      let records;
      try {
        records = await Promise.all(artifactIds.map((id) => readArtifact(id, context)));
      } catch (error) {
        throw stableFailure("artifact_read_failed", "delivery receipt artifact read failed", error);
      }
      const qa = safeDeliveryQa(receipt.qa);
      const warnings = safeDeliveryWarnings(receipt.warnings);
      const summary = safeDeliverySummary(receipt.summary);
      return {
        content: [{
          type: "text",
          text: `图片交付记录 ${deliveryReceiptId}：${receipt.deliveryReady ? "交付条件已满足" : "交付条件未满足"}。`,
        }],
        structuredContent: {
          deliveryReceiptId,
          sourceArtifactId: receipt.sourceArtifactId,
          deliveryReady: Boolean(receipt.deliveryReady),
          artifacts: records.map(({ metadata }) => ({ ...metadata })),
          ...(qa !== undefined ? { qa } : {}),
          ...(warnings.length ? { warnings } : {}),
          ...(summary !== undefined ? { summary } : {}),
        },
        _meta: { imageIds: artifactIds, deliveryReceiptId },
      };
    },
  };
}


function requireDependency(dependency, name) {
  if (typeof dependency !== "function") {
    throw new TypeError(`image audit handler requires ${name}`);
  }
}


function runtimeFailure(result, fallbackMessage) {
  return stableFailure(result?.error?.code, result?.error?.message || fallbackMessage);
}


function stableFailure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  if (typeof code === "string") error.code = code;
  return error;
}
