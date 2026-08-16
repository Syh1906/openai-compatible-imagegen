import { z } from "zod";


const hostFieldPathSchema = z.string().max(512).regex(
  /^\$(?:(?:\.[A-Za-z_][A-Za-z0-9_-]{0,63})|(?:\[(?:[0-9]|[12][0-9]|3[01])\])){0,8}$/,
);
const hostReportedLengthSchema = z.number().int().min(0).max(64 * 1024 * 1024);
const hostFieldSchema = z.union([
  z.object({
    path: hostFieldPathSchema,
    type: z.enum(["string", "array"]),
    length: hostReportedLengthSchema,
  }).strict(),
  z.object({
    path: hostFieldPathSchema,
    type: z.enum(["null", "boolean", "number", "object", "unknown"]),
    length: z.null(),
  }).strict(),
]);
const hostObservationShape = {
  fields: z.array(hostFieldSchema).max(256),
  errorCodes: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(32),
  truncated: z.boolean(),
};
const notificationObservationSchema = z.object({
  source: z.literal("ui/notifications/tool-result"),
  ...hostObservationShape,
}).strict();
const toolCallObservationSchema = z.object({
  source: z.literal("tools/call"),
  ...hostObservationShape,
}).strict();


export const stableHostErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const hostObservationScopeSchema = z.literal("project_binding_latest");
export const hostObservationInputSchema = z.tuple([
  notificationObservationSchema,
  toolCallObservationSchema,
]);
export const hostObservationReportSchema = z.object({
  provenance: z.literal("unverified_widget_report"),
  scope: hostObservationScopeSchema,
  observations: hostObservationInputSchema,
}).strict();
export const hostObservationReportOutputSchema = hostObservationReportSchema.nullable();


export function parseHostObservationReport(value) {
  return hostObservationReportSchema.parse(value);
}
