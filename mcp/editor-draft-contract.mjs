import { z } from "zod";


const normalizedCoordinate = z.number().min(0).max(1);
const normalizedPoint = z.object({ x: normalizedCoordinate, y: normalizedCoordinate });
const annotationStyleSchema = {
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  strokeWidth: z.number().min(1).max(12).optional(),
};

export const annotationItemSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1), type: z.literal("pen"), points: z.array(normalizedPoint).min(2).max(4096), text: z.string().max(600).optional(), ...annotationStyleSchema }),
  z.object({ id: z.string().min(1), type: z.literal("arrow"), from: normalizedPoint, to: normalizedPoint, text: z.string().max(600).optional(), ...annotationStyleSchema }),
  z.object({ id: z.string().min(1), type: z.literal("rectangle"), x: normalizedCoordinate, y: normalizedCoordinate, width: normalizedCoordinate, height: normalizedCoordinate, text: z.string().max(600).optional(), ...annotationStyleSchema }),
  z.object({ id: z.string().min(1), type: z.literal("text"), x: normalizedCoordinate, y: normalizedCoordinate, text: z.string().min(1).max(600), ...annotationStyleSchema }),
  z.object({
    id: z.string().min(1),
    type: z.literal("mask"),
    mode: z.enum(["edit", "protect"]),
    operation: z.enum(["paint", "erase"]).default("paint"),
    brushRadius: z.number().min(0.001).max(0.5),
    points: z.array(normalizedPoint).min(2).max(4096),
    text: z.string().max(600).optional(),
    color: annotationStyleSchema.color,
  }),
]);

export const editorDraftSchema = z.object({
  annotations: z.array(annotationItemSchema).max(100),
  prompt: z.string().max(600),
}).strict();

export function parseEditorDraft(value, { allowNull = false } = {}) {
  if (allowNull && value === null) return null;
  const parsed = editorDraftSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("invalid editor draft");
  if (parsed.data.annotations.length === 0 && parsed.data.prompt.trim() === "") return null;
  return structuredClone(parsed.data);
}
