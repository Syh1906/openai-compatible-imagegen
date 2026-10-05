import { z } from "zod";

import { imageArtifactOutputSchema, projectBindingIdSchema } from "./image-tool-schemas.mjs";
import { submissionKeySchema } from "./image-job-contract.mjs";
import { isStableToolErrorCode } from "./tool-errors.mjs";


const handoffIdSchema = z.string().regex(/^handoff_[0-9a-f]{64}$/);
const imageIdSchema = z.string().regex(/^img_[0-9A-HJKMNP-TV-Z]{26}$/);
const annotationIdSchema = z.string().regex(/^ann_[0-9A-HJKMNP-TV-Z]{26}$/);
const submissionIdSchema = z.string().regex(/^sub_[0-9a-f]{32}$/);
const handoffErrorSchema = z.object({
  code: z.string(), phase: z.enum(["prepare", "stage", "finalize", "get"]),
  fallbackEligible: z.literal(false),
  recoveryAction: z.enum(["fix_request", "retry_stage", "retry_finalize", "inspect_handoff"]),
}).strict();
const handoffSuccessSchema = z.object({
  handoffId: handoffIdSchema,
  status: z.enum(["prepared", "staged", "committed", "aborted"]),
  replayed: z.boolean().optional(),
  artifacts: z.array(imageArtifactOutputSchema).min(1).max(1).optional(),
}).strict();
const handoffReceiptSchema = handoffSuccessSchema.partial({ handoffId: true }).extend({
  status: z.enum(["prepared", "staged", "committed", "aborted", "failed"]),
  error: handoffErrorSchema.optional(),
});
const stagedSuccessSchema = z.object({ handoffId: handoffIdSchema, status: z.literal("staged"), imageCount: z.literal(1) }).strict();


export function registerHostImageImportTools(server, {
  projectContext,
  importer,
  editSubmissions,
  readArtifact,
  toolError,
}) {
  server.registerTool("prepare_host_image_import", {
    title: "Prepare host image import",
    description: "Freeze one ChatGPT generation, conversation edit, or canvas edit intent. Preserve submissionKey after a lost reply. A replay is not permission to invoke the host again. Edit preparation returns the clean parent image as model-visible content.",
    inputSchema: {
      projectBindingId: projectBindingIdSchema,
      route: z.literal("chatgpt"),
      intent: z.enum(["generate", "edit"]),
      prompt: z.string().trim().min(1),
      count: z.literal(1).default(1),
      parentImageId: imageIdSchema.optional(),
      annotationId: annotationIdSchema.nullable().optional(),
      submissionId: submissionIdSchema.optional(),
      submissionKey: submissionKeySchema.optional(),
    },
    outputSchema: handoffReceiptSchema,
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

  server.registerTool("get_host_image_handoff", {
    title: "Get host image handoff",
    description: "Read a local host image handoff by handoffId or submissionKey. Prepared state does not prove the host was never invoked. Querying does not regenerate images or settle canvas submissions.",
    inputSchema: {
      projectBindingId: projectBindingIdSchema,
      handoffId: handoffIdSchema.optional(),
      submissionKey: submissionKeySchema.optional(),
    },
    outputSchema: handoffReceiptSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ projectBindingId, ...input }) => await withProject(projectContext, projectBindingId, toolError,
    async (context) => {
      if (Boolean(input.handoffId) === Boolean(input.submissionKey)) throw requestError();
      return {
        content: [{ type: "text", text: "以下是本地交接状态；prepared 不证明宿主尚未调用，结果未知时不要重新生成。" }],
        structuredContent: withoutEditContext(await importer.get(input, context)),
      };
    }, "get",
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
      handoffId: handoffIdSchema.optional(),
      status: z.enum(["staged", "failed"]),
      imageCount: z.literal(1).optional(),
      error: handoffErrorSchema.optional(),
    }).strict(),
    annotations: writeAnnotations(false),
  }, async ({ projectBindingId, ...input }) => await withProject(
    projectContext,
    projectBindingId,
    toolError,
    async (context) => ({
      content: [{ type: "text", text: "已暂存本次宿主图片输出。" }],
      structuredContent: stagedSuccessSchema.parse(await importer.stage(input, context)),
    }), "stage",
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
      handoffId: handoffIdSchema.optional(),
      status: z.enum(["committed", "aborted", "failed"]),
      artifacts: z.array(imageArtifactOutputSchema).min(1).max(1).optional(),
      error: handoffErrorSchema.optional(),
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
            ? "已将宿主图片发布为项目工件。收集返回的图片 ID 及其用途和版本关系；需要中途查看时可调用 render_image_results。最终回复或请求用户选择前，汇总应交付的图片统一展示，中途已展示的图片也可纳入。"
            : "已终止本次宿主图片交接。",
        }],
        structuredContent: publicResult,
      };
    }, "finalize",
  ));
}


async function prepareImport(input, context, { importer, editSubmissions, readArtifact }) {
  validateIntent(input);
  if (input.submissionKey) {
    let existing;
    try {
      existing = await importer.get({ submissionKey: input.submissionKey }, context);
    } catch (error) {
      if (error.code !== "host_image_handoff_not_found") throw error;
    }
    if (existing) {
      const edit = existing.editContext;
      const receipt = await importer.prepare({ ...input, ...(edit ? {
        revisionSha256: edit.revisionSha256, claimGeneration: edit.claimGeneration,
      } : {}) }, context);
      return await preparationResult(receipt, input, context, readArtifact);
    }
  }
  if (input.intent === "generate") {
    return await preparationResult(await importer.prepare(input, context), input, context, readArtifact);
  }
  let claimed;
  let preparationStarted = false;
  try {
    claimed = await editSubmissions.claimForEdit({
      artifactRoot: context.artifactRoot,
      bindingKey: context.bindingKey,
      parentImageId: input.parentImageId,
      ...(input.submissionId ? { submissionId: input.submissionId } : {}),
      ...(Object.hasOwn(input, "annotationId") ? { annotationId: input.annotationId } : {}),
    });
    if (claimed?.completedArtifactIds) {
      const error = new Error("stale_edit_submission");
      error.code = "stale_edit_submission";
      throw error;
    }
    if (claimed?.receipt.modelSelection?.authMode === "apikey") throw requestError();
    const parent = await readArtifact(input.parentImageId, context);
    preparationStarted = true;
    const structuredContent = await importer.prepare({
      ...input,
      ...(claimed ? {
        annotationId: claimed.receipt.annotationId,
        submissionId: claimed.receipt.id,
        revisionSha256: claimed.receipt.revisionSha256,
        claimGeneration: claimed.claimGeneration,
      } : {}),
    }, context);
    return await preparationResult(structuredContent, input, context, readArtifact, parent);
  } catch (error) {
    if (claimed && !claimed.completedArtifactIds && (!preparationStarted
      || ["host_image_request_invalid", "host_image_handoff_conflict"].includes(error.code))) {
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


function validateIntent(input) {
  if (input.intent === "generate") {
    if (input.parentImageId !== undefined || input.annotationId !== undefined || input.submissionId !== undefined) throw requestError();
    return;
  }
  if (!input.parentImageId
    || (input.submissionId && !Object.hasOwn(input, "annotationId"))
    || (!input.submissionId && input.annotationId != null)) throw requestError();
}

function requestError() {
  const error = new Error("host_image_request_invalid");
  error.code = "host_image_request_invalid";
  return error;
}

async function preparationResult(receipt, input, context, readArtifact, parent) {
  const replayMessages = {
    prepared: "已恢复原交接。不要再次调用宿主生图；先核对本次调用结果，再暂存原输出。",
    staged: "原交接已暂存图片。继续提交同一交接，不要再次调用宿主生图。",
    committed: "原交接已发布图片。收集现有图片 ID 并展示结果，不要再次调用宿主生图。",
    aborted: "原交接已终止，不能恢复生成。新的图片意图需要新的提交键。",
  };
  const content = [{ type: "text", text: receipt.replayed
    ? replayMessages[receipt.status]
    : "已准备本次 ChatGPT 图片交接。编辑使用以下干净父图作为参考，保持父子版本关系。" }];
  if (input.intent === "edit" && receipt.status === "prepared") {
    content.push(imageContent(parent ?? await readArtifact(input.parentImageId, context)));
  }
  return { content, structuredContent: withoutEditContext(receipt) };
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
  return handoffSuccessSchema.parse(publicResult);
}


function imageContent(artifact) {
  return { type: "image", data: artifact.data, mimeType: artifact.metadata.mimeType };
}


async function withProject(projectContext, projectBindingId, toolError, operation, phase = "prepare") {
  let context;
  try { context = await projectContext.require(projectBindingId); } catch (error) { return toolError(error); }
  try {
    return await operation(context);
  } catch (error) {
    const code = isStableToolErrorCode(error.code) ? error.code : "host_image_import_failed";
    return {
      ...toolError(error, code),
      structuredContent: { status: "failed", error: { code, phase, fallbackEligible: false,
        recoveryAction: phase === "prepare" ? (code === "host_image_import_failed" || code === "host_image_handoff_conflict" ? "inspect_handoff" : "fix_request")
          : phase === "stage" ? "retry_stage" : phase === "finalize" ? "retry_finalize" : "inspect_handoff" } },
    };
  }
}


function writeAnnotations(idempotentHint) {
  return { readOnlyHint: false, destructiveHint: false, idempotentHint, openWorldHint: false };
}
