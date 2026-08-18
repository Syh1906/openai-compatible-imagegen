import { z } from "zod";


export const imageIdSchema = z.string().regex(/^img_[0-9A-HJKMNP-TV-Z]{26}$/).describe("Stable image ID in the project artifact repository");
export const batchIdSchema = z.string().regex(/^batch_[0-9A-HJKMNP-TV-Z]{26}$/).describe("Immutable batch manifest ID");
export const deliveryReceiptIdSchema = z.string().regex(/^delivery_[0-9a-f]{64}$/);
export const outputSchema = {
  size: z.string().optional(),
  quality: z.enum(["auto", "low", "medium", "high"]).optional(),
  format: z.enum(["png", "jpeg", "webp"]).optional(),
  count: z.number().int().min(1).max(10).optional(),
  background: z.enum(["auto", "opaque"]).optional(),
};
export const transparencyInputSchema = z.object({
  route: z.enum(["chroma-matting", "emissive-alpha", "mask-alpha", "prompt-alpha"]).optional(),
  options: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  maskImageId: imageIdSchema.optional(),
}).strict();

const batchRequestIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const batchCountSchema = z.number().int().min(1).max(16).optional();
const batchDeliverySchema = z.object({
  deliverySize: z.string().regex(/^\d+[x*]\d+$/).optional(),
  fit: z.enum(["stretch", "contain"]).optional(),
  resample: z.enum(["nearest", "bilinear"]).optional(),
  safeMargin: z.number().min(0).lt(0.5).optional(),
  qa: z.boolean().optional(),
  components: z.boolean().optional(),
  grid: z.union([
    z.string().regex(/^\d+[x*]\d+$/),
    z.object({ rows: z.number().int().positive(), cols: z.number().int().positive() }).strict(),
  ]).optional(),
  expectedCount: z.number().int().min(1).max(10).optional(),
  preview: z.object({
    sizes: z.array(z.string().regex(/^\d+[x*]\d+$/)).min(1).max(10),
    backgrounds: z.array(z.enum(["transparent", "white", "black", "gray", "checker"])).min(1).max(5).optional(),
    resample: z.enum(["nearest", "bilinear"]).optional(),
  }).strict().optional(),
  transparency: transparencyInputSchema.optional(),
}).strict();

const batchGenerateItemSchema = z.object({
  requestId: batchRequestIdSchema,
  operation: z.literal("generate"),
  prompt: z.string().min(1),
  modelProfileId: z.literal("primary/gpt-image-2").optional(),
  transparency: transparencyInputSchema.optional(),
  delivery: batchDeliverySchema.optional(),
  ...outputSchema,
  count: batchCountSchema,
}).strict();
const batchEditItemSchema = z.object({
  requestId: batchRequestIdSchema,
  operation: z.literal("edit"),
  parentImageId: imageIdSchema,
  referenceImageIds: z.array(imageIdSchema).max(10).optional(),
  prompt: z.string().min(1),
  modelProfileId: z.literal("primary/gpt-image-2").optional(),
  transparency: transparencyInputSchema.optional(),
  delivery: batchDeliverySchema.optional(),
  ...outputSchema,
  count: batchCountSchema,
}).strict();
export const batchItemsSchema = z.array(z.discriminatedUnion("operation", [
  batchGenerateItemSchema,
  batchEditItemSchema,
])).min(1).max(64).superRefine((items, context) => {
  const seen = new Set();
  let totalCount = 0;
  for (const [index, item] of items.entries()) {
    if (seen.has(item.requestId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "requestId must be unique within a batch",
        path: [index, "requestId"],
      });
    }
    seen.add(item.requestId);
    totalCount += item.count ?? 1;
  }
  if (totalCount > 64) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "batch image count must not exceed 64",
      path: [],
    });
  }
});

export const imageArtifactOutputSchema = z.object({
  id: imageIdSchema,
  parentIds: z.array(imageIdSchema),
  childIds: z.array(imageIdSchema),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  provider: z.string().min(1),
  model: z.string().min(1),
  operation: z.enum(["generate", "edit", "derive"]),
  prompt: z.string(),
  parameters: z.record(z.unknown()),
  annotationId: z.string().regex(/^ann_[0-9A-HJKMNP-TV-Z]{26}$/).nullable(),
  createdAt: z.string().datetime(),
  derivedFrom: imageIdSchema.optional(),
  deliveryKind: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
}).strict();
export const imageArtifactsOutputSchema = z.object({
  artifacts: z.array(imageArtifactOutputSchema).min(1).max(10),
  artifact: imageArtifactOutputSchema.optional(),
}).strict();
const deliveryReceiptResultSchema = z.object({
  sourceArtifactId: imageIdSchema,
  deliveryReceiptId: deliveryReceiptIdSchema.optional(),
  deliveryReady: z.boolean(),
  artifacts: z.array(imageArtifactOutputSchema).max(10),
  qa: z.record(z.unknown()).nullable().optional(),
  warnings: z.array(z.string()).max(20).optional(),
  summary: z.record(z.unknown()).optional(),
  error: z.object({
    code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    message: z.string().min(1),
  }).strict().optional(),
}).strict();
const batchDeliveryReceiptSchema = z.object({
  deliveryReady: z.boolean(),
  results: z.array(deliveryReceiptResultSchema).min(1).max(16),
  artifactIds: z.array(imageIdSchema).max(160),
}).strict();
const apiDeliverySchema = z.object({
  status: z.enum(["published", "published_with_warnings", "partial"]),
  requestedCount: z.number().int().min(1).max(16),
  returnedCount: z.number().int().nonnegative(),
  publishedCount: z.number().int().min(1).max(16),
  items: z.array(z.object({
    responseIndex: z.number().int().min(1).max(16),
    artifactId: imageIdSchema,
    actualFormat: z.enum(["png", "jpeg", "webp"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).strict()).max(16),
  issues: z.array(z.object({
    code: z.enum([
      "count_mismatch",
      "format_mismatch",
      "item_publish_failed",
      "item_unusable",
      "size_mismatch",
      "total_bytes_exceeded",
    ]),
    responseIndex: z.number().int().min(1).max(16).optional(),
  }).strict()).max(64),
}).strict();
const batchManifestResultSchema = z.discriminatedUnion("ok", [
  z.object({
    requestId: batchRequestIdSchema,
    operation: z.enum(["generate", "edit"]),
    ok: z.literal(true),
    artifactIds: z.array(imageIdSchema).max(16),
    apiDelivery: apiDeliverySchema.optional(),
    deliveryReceiptIds: z.array(deliveryReceiptIdSchema).max(16),
    deliveryArtifactIds: z.array(imageIdSchema).max(160),
  }).strict(),
  z.object({
    requestId: batchRequestIdSchema,
    operation: z.enum(["generate", "edit"]),
    ok: z.literal(false),
    errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  }).strict(),
]);
export const batchManifestOutputSchema = z.object({
  schemaVersion: z.literal("batch-manifest.v1"),
  summary: z.object({
    total: z.number().int().min(1).max(64),
    succeeded: z.number().int().min(0).max(64),
    failed: z.number().int().min(0).max(64),
    artifactCount: z.number().int().min(0).max(64),
  }).strict(),
  results: z.array(batchManifestResultSchema).min(1).max(64),
  batchId: batchIdSchema,
  createdAt: z.string().datetime(),
}).strict();
const imageBatchResultOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    requestId: batchRequestIdSchema,
    operation: z.enum(["generate", "edit"]),
    ok: z.literal(true),
    artifacts: z.array(imageArtifactOutputSchema).min(1).max(16),
    apiDelivery: apiDeliverySchema.optional(),
    delivery: batchDeliveryReceiptSchema.optional(),
  }).strict(),
  z.object({
    requestId: batchRequestIdSchema,
    operation: z.enum(["generate", "edit"]),
    ok: z.literal(false),
    error: z.object({
      code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
      message: z.string().min(1),
    }).strict(),
  }).strict(),
]);
export const imageBatchOutputSchema = z.object({
  results: z.array(imageBatchResultOutputSchema).min(1).max(64),
  summary: z.object({
    total: z.number().int().min(1).max(64),
    succeeded: z.number().int().min(0).max(64),
    failed: z.number().int().min(0).max(64),
    artifactCount: z.number().int().min(0).max(64),
  }).strict(),
  artifactIds: z.array(imageIdSchema).max(64),
  manifestReady: z.boolean(),
  batchId: batchIdSchema.optional(),
  manifestCreatedAt: z.string().datetime().optional(),
  manifestError: z.object({
    code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    message: z.string().min(1),
  }).strict().optional(),
}).strict();

export const deliveryInputSchema = batchDeliverySchema;
export const imageDeliveryOutputSchema = z.object({
  sourceArtifactId: imageIdSchema,
  deliveryReceiptId: deliveryReceiptIdSchema.optional(),
  deliveryReady: z.boolean(),
  artifacts: z.array(imageArtifactOutputSchema).max(10),
  qa: z.record(z.unknown()).nullable().optional(),
  warnings: z.array(z.string()).max(20).optional(),
  summary: z.record(z.unknown()).optional(),
}).strict();
