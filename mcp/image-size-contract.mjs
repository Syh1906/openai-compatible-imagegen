import { z } from "zod";

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const aspectRatio = z.number().finite().min(1).max(Number.MAX_SAFE_INTEGER);
const pixelSize = z.string().regex(/^[1-9][0-9]*x[1-9][0-9]*$/)
  .refine((value) => value.split("x").every((edge) => Number.isSafeInteger(Number(edge))));
const sizeLimitFields = {
  allowed_sizes: z.array(pixelSize).min(1).optional(),
  multiple_of: positiveInteger.optional(),
  min_edge: positiveInteger.optional(),
  max_edge: positiveInteger.optional(),
  min_pixels: positiveInteger.optional(),
  max_pixels: positiveInteger.optional(),
  max_aspect_ratio: aspectRatio.optional(),
};

export const outputSizeLimitsSchema = z.object(sizeLimitFields).strict().superRefine((rules, context) => {
  const invalid = () => context.addIssue({ code: z.ZodIssueCode.custom, message: "inconsistent output size limits" });
  for (const unit of ["edge", "pixels"]) {
    if ((rules[`min_${unit}`] ?? 1) > (rules[`max_${unit}`] ?? Number.MAX_SAFE_INTEGER)) invalid();
  }
  for (const size of rules.allowed_sizes ?? []) {
    const [width, height] = size.split("x").map(Number);
    const short = Math.min(width, height), long = Math.max(width, height);
    if ((rules.multiple_of && (width % rules.multiple_of || height % rules.multiple_of))
      || (rules.max_aspect_ratio && long > short * rules.max_aspect_ratio)
      || short < (rules.min_edge ?? 1) || long > (rules.max_edge ?? Number.MAX_SAFE_INTEGER)
      || width * height < (rules.min_pixels ?? 1) || (rules.max_pixels && width * height > rules.max_pixels)) invalid();
  }
});

export const modelLimitsSchema = z.object({
  max_input_images: positiveInteger.optional(),
  output_size: outputSizeLimitsSchema.optional(),
}).strict();

export function validModelLimits(limits, protocol) {
  return modelLimitsSchema.safeParse(limits).success
    && (!Object.keys(limits.output_size ?? {}).length || ["openai-compatible", "atlas"].includes(protocol));
}

export const imageSizeErrorDetailsSchema = z.discriminatedUnion("constraint", Object.entries(sizeLimitFields)
  .map(([constraint, limit]) => z.object({ size: pixelSize, constraint: z.literal(constraint), limit: limit.unwrap() }).strict()));

// Rebuild messages only from validated dimensions and declared numeric constraints.
// Never pass arbitrary runtime/provider error strings through to tool results.
export function safeImageSizeError(error) {
  if (error?.code !== "image_size_unsupported") return undefined;
  const parsed = imageSizeErrorDetailsSchema.safeParse(error.details);
  if (!parsed.success) return undefined;
  const { size, constraint, limit } = parsed.data;
  const [width, height] = size.split("x").map(Number);
  let message;
  if (constraint === "allowed_sizes") message = `生成尺寸 ${size} 不在当前模型允许的尺寸中：${limit.join(", ")}。`;
  else if (constraint === "multiple_of") message = `生成尺寸 ${size} 的宽高必须都是 ${limit} 的倍数。`;
  else if (constraint === "max_aspect_ratio") message = `生成尺寸 ${size} 的长短边比例为 ${(Math.max(width, height) / Math.min(width, height)).toFixed(2)}:1，当前模型允许最大 ${limit}:1。`;
  else {
    const edge = constraint.endsWith("edge"), minimum = constraint.startsWith("min_");
    const actual = edge ? (minimum ? Math.min(width, height) : Math.max(width, height)) : width * height;
    message = `生成尺寸 ${size} 的${edge ? "边长" : "像素总量"}为 ${actual}，当前模型要求${minimum ? "至少" : "最多"} ${limit}。`;
  }
  return { code: error.code, message, details: parsed.data };
}
