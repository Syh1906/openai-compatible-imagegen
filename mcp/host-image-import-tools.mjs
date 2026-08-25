import { z } from "zod";

import { imageArtifactOutputSchema, projectBindingIdSchema } from "./image-tool-schemas.mjs";


const handoffIdSchema = z.string().regex(/^handoff_[0-9a-f]{64}$/);
const imageIdSchema = z.string().regex(/^img_[0-9A-HJKMNP-TV-Z]{26}$/);
const annotationIdSchema = z.string().regex(/^ann_[0-9A-HJKMNP-TV-Z]{26}$/);
const submissionIdSchema = z.string().regex(/^sub_[0-9a-f]{32}$/);


export function registerHostImageImportTools(server, {
  projectContext,
  importer,
  editSubmissions,
  readArtifact,
  toolError,
}) {
  server.registerTool("prepare_host_image_import", {
    title: "Prepare host image import",
    description: "Freeze one ChatGPT image generation or canvas edit intent before invoking the Codex host image generation capability. Edit preparation returns the clean parent image as model-visible content.",
    inputSchema: {
      projectBindingId: projectBindingIdSchema,
      route: z.literal("chatgpt"),
      intent: z.enum(["generate", "edit"]),
      prompt: z.string().trim().min(1),
      count: z.literal(1).default(1),
      parentImageId: imageIdSchema.optional(),
      annotationId: annotationIdSchema.nullable().optional(),
      submissionId: submissionIdSchema.optional(),
    },
    outputSchema: z.object({ handoffId: handoffIdSchema, status: z.literal("prepared") }).strict(),
    annotations: writeAnnotations(false),
  }, async ({ projectBindingId, ...input }) => await withProject(
    projectContext,
    projectBindingId,
    toolError,
    async (context) => await prepareImport(input, context, {
      importer,
      editSubmissions,
      readArtifact,
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
      await settleEditSubmission(result, input.action, context, editSubmissions);
      const publicResult = withoutEditContext(result);
      return {
        content: [{
          type: "text",
          text: publicResult.status === "committed"
            ? "已将宿主图片发布为项目工件。请使用 render_image_results 展示返回的图片 ID。"
            : "已终止本次宿主图片交接。",
        }],
        structuredContent: publicResult,
      };
    },
  ));
}


async function prepareImport(input, context, { importer, editSubmissions, readArtifact }) {
  if (input.intent === "generate") {
    assertNoEditFields(input);
    return {
      content: [{ type: "text", text: "已准备本次宿主图片生成交接。" }],
      structuredContent: await importer.prepare(input, context),
    };
  }
  if (!input.parentImageId || !input.submissionId || !Object.hasOwn(input, "annotationId")) {
    throw new Error("ChatGPT canvas edit requires parentImageId, annotationId, and submissionId");
  }
  let claimed;
  try {
    claimed = await editSubmissions.claimForEdit({
      artifactRoot: context.artifactRoot,
      bindingKey: context.bindingKey,
      parentImageId: input.parentImageId,
      submissionId: input.submissionId,
      annotationId: input.annotationId,
    });
    if (!claimed || claimed.completedArtifactIds) {
      throw new Error("ChatGPT canvas edit submission is not available");
    }
    const parent = await readArtifact(input.parentImageId, context);
    const structuredContent = await importer.prepare({
      ...input,
      annotationId: claimed.receipt.annotationId,
      submissionId: claimed.receipt.id,
      revisionSha256: claimed.receipt.revisionSha256,
      claimGeneration: claimed.claimGeneration,
    }, context);
    return {
      content: [
        {
          type: "text",
          text: "已准备本次 ChatGPT 画布编辑交接。以下图片是无标注的干净父图；会话中的画布预览只用于定位修改区域。",
        },
        imageContent(parent),
      ],
      structuredContent,
    };
  } catch (error) {
    if (claimed && !claimed.completedArtifactIds) {
      await editSubmissions.releaseForEdit({
        artifactRoot: context.artifactRoot,
        bindingKey: context.bindingKey,
        parentImageId: claimed.receipt.parentImageId,
        submissionId: claimed.receipt.id,
        claimGeneration: claimed.claimGeneration,
      });
    }
    throw error;
  }
}


function assertNoEditFields(input) {
  if (
    input.parentImageId !== undefined
    || input.annotationId !== undefined
    || input.submissionId !== undefined
  ) {
    throw new Error("ChatGPT generation handoff does not accept canvas edit fields");
  }
}


async function settleEditSubmission(result, action, context, editSubmissions) {
  const edit = result?.editContext;
  if (!edit) return;
  const request = {
    artifactRoot: context.artifactRoot,
    bindingKey: context.bindingKey,
    parentImageId: edit.parentImageId,
    submissionId: edit.submissionId,
    claimGeneration: edit.claimGeneration,
  };
  if (action === "commit") {
    await editSubmissions.complete({
      ...request,
      artifactIds: result.artifacts.map((artifact) => artifact.id),
    });
    return;
  }
  await editSubmissions.releaseForEdit(request);
}


function withoutEditContext(result) {
  const { editContext: _editContext, ...publicResult } = result;
  return publicResult;
}


function imageContent(artifact) {
  return { type: "image", data: artifact.data, mimeType: artifact.metadata.mimeType };
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
