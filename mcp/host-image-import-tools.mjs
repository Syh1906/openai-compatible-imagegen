import { z } from "zod";

import { imageArtifactOutputSchema, projectBindingIdSchema } from "./image-tool-schemas.mjs";


const handoffIdSchema = z.string().regex(/^handoff_[0-9a-f]{64}$/);


export function registerHostImageImportTools(server, { projectContext, importer, toolError }) {
  server.registerTool("prepare_host_image_import", {
    title: "Prepare host image import",
    description: "Freeze one ChatGPT image generation intent before invoking the Codex host image generation capability.",
    inputSchema: {
      projectBindingId: projectBindingIdSchema,
      route: z.literal("chatgpt"),
      intent: z.literal("generate"),
      prompt: z.string().trim().min(1),
      count: z.literal(1).default(1),
    },
    outputSchema: z.object({ handoffId: handoffIdSchema, status: z.literal("prepared") }).strict(),
    annotations: writeAnnotations(false),
  }, async ({ projectBindingId, ...input }) => await withProject(
    projectContext,
    projectBindingId,
    toolError,
    async (context) => ({
      content: [{ type: "text", text: "已准备本次宿主图片生成交接。" }],
      structuredContent: await importer.prepare(input, context),
    }),
  ));

  server.registerTool("stage_host_image_import", {
    title: "Stage host image import",
    description: "Snapshot the exact local path returned by the current Codex host image generation call into its prepared handoff.",
    inputSchema: {
      projectBindingId: projectBindingIdSchema,
      handoffId: handoffIdSchema,
      hostOutput: z.object({
        type: z.literal("codex-imagegen-saved-path"),
        savedPath: z.string().min(1),
      }).strict(),
    },
    outputSchema: z.object({
      handoffId: handoffIdSchema,
      status: z.literal("staged"),
      imageCount: z.literal(1),
    }).strict(),
    annotations: writeAnnotations(false),
  }, async ({ projectBindingId, ...input }) => await withProject(
    projectContext,
    projectBindingId,
    toolError,
    async (context) => ({
      content: [{ type: "text", text: "已暂存本次宿主图片输出。" }],
      structuredContent: await importer.stage(input, context),
    }),
  ));

  server.registerTool("finalize_host_image_import", {
    title: "Finalize host image import",
    description: "Commit or abort a prepared host image handoff without accepting another path, prompt, or source declaration.",
    inputSchema: {
      projectBindingId: projectBindingIdSchema,
      handoffId: handoffIdSchema,
      action: z.enum(["commit", "abort"]),
    },
    outputSchema: z.object({
      handoffId: handoffIdSchema,
      status: z.enum(["committed", "aborted"]),
      artifacts: z.array(imageArtifactOutputSchema).min(1).max(1).optional(),
    }).strict(),
    annotations: writeAnnotations(true),
  }, async ({ projectBindingId, ...input }) => await withProject(
    projectContext,
    projectBindingId,
    toolError,
    async (context) => {
      const result = await importer.finalize(input, context);
      return {
        content: [{
          type: "text",
          text: result.status === "committed"
            ? "已将宿主图片发布为项目工件。请使用 render_image_results 展示返回的图片 ID。"
            : "已终止本次宿主图片交接。",
        }],
        structuredContent: result,
      };
    },
  ));
}


async function withProject(projectContext, projectBindingId, toolError, operation) {
  try {
    return await operation(await projectContext.require(projectBindingId));
  } catch (error) {
    return toolError(error);
  }
}


function writeAnnotations(idempotentHint) {
  return { readOnlyHint: false, destructiveHint: false, idempotentHint, openWorldHint: false };
}
