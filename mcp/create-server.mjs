import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { createEditSubmissionRegistry } from "./edit-submission-registry.mjs";
import { annotationItemSchema, editorDraftSchema } from "./editor-draft-contract.mjs";
import { createEditorStateRegistry } from "./editor-state-registry.mjs";
import { executeImageBatch } from "./batch-images.mjs";
import { createImageAuditHandlers } from "./image-audit-handlers.mjs";
import {
  safeDeliveryQa,
  safeDeliverySummary,
  safeDeliveryWarnings,
} from "./delivery-result.mjs";
import {
  batchIdSchema,
  batchManifestOutputSchema,
  batchItemsSchema,
  deliveryReceiptIdSchema,
  deliveryInputSchema,
  imageArtifactOutputSchema,
  imageArtifactsOutputSchema,
  imageBatchOutputSchema,
  imageDeliveryOutputSchema,
  imageIdSchema,
  outputSchema,
  transparencyInputSchema,
} from "./image-tool-schemas.mjs";
import {
  createRuntimeObservation,
  MAX_RUNTIME_ROOT_ENTRIES,
  MAX_RUNTIME_ROOT_SCHEME_LENGTH,
} from "./runtime-diagnostics.mjs";
import { createProjectContext } from "./project-context.mjs";
import {
  hostObservationInputSchema,
  hostObservationReportOutputSchema,
  hostObservationScopeSchema,
  stableHostErrorCodeSchema,
} from "./host-observation-contract.mjs";
import { createInMemoryHostObservationStore } from "./host-observation-store.mjs";
import { isStableToolErrorCode, stableToolErrorMessages } from "./tool-errors.mjs";
import { registerConfigTools } from "./config-tools.mjs";
import { initializeImageConfig, inspectImageConfig, updateImageConfig } from "./config-resolution.mjs";
const legacyWidgetResourceFingerprints = [
  "43c3a69a85db10633692",
  "9caad8c28a921a55611b",
];
const editorSessionIdSchema = z.string().regex(/^eds_[0-9a-f]{32}$/).describe("已打开画布的会话 ID");
const projectBindingIdSchema = z.string().regex(/^pbind_[0-9a-f]{64}$/).describe("图片项目绑定 ID");
const projectBindingInputSchema = { projectBindingId: projectBindingIdSchema };
const annotationIdSchema = z.string().regex(/^ann_[0-9A-HJKMNP-TV-Z]{26}$/);
const submissionIdSchema = z.string().regex(/^sub_[0-9a-f]{32}$/);
const deliveryReceiptIdPattern = /^delivery_[0-9a-f]{64}$/;
const imageModelCapabilitiesOutputSchema = z.object({
  generate: z.boolean().optional(),
  edit: z.boolean().optional(),
  mask: z.boolean().optional(),
  multi_reference: z.boolean().optional(),
}).strict();
const imageModelOutputSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  capabilities: imageModelCapabilitiesOutputSchema,
}).strict();
const editorSessionOutputSchema = z.object({
  id: editorSessionIdSchema,
  imageId: imageIdSchema.optional(),
  status: z.enum(["active", "destroyed", "released"]),
}).strict();
const maskPolicyOutputSchema = z.object({
  policyVersion: z.literal("mask-policy-v2"),
  modelProfileId: z.literal("primary/gpt-image-2"),
  requiredCapabilities: z.object({ mask: z.literal(true) }).strict(),
  strategy: z.enum(["edit-only", "protect-only", "mixed"]),
  parentImageId: imageIdSchema,
  annotationId: annotationIdSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  masks: z.array(z.object({
    id: z.string().min(1),
    mode: z.enum(["edit", "protect"]),
    operation: z.enum(["paint", "erase"]),
    radiusPx: z.number().positive(),
  }).strict()).min(1),
  hardBoundary: z.object({
    source: z.enum(["none", "edit-strokes"]),
    postprocess: z.enum(["none", "parent-blend"]),
  }).strict(),
  semanticProtection: z.object({
    enabled: z.boolean(),
    source: z.literal("protect-strokes"),
    preserve: z.tuple([
      z.literal("identity"),
      z.literal("geometry"),
      z.literal("text"),
      z.literal("texture"),
    ]),
    allowAdaptation: z.tuple([
      z.literal("lighting"),
      z.literal("shadow"),
      z.literal("tone"),
    ]),
  }).strict(),
  transitionBand: z.object({
    kind: z.literal("outer-feather"),
    featherRatio: z.literal(0.35),
    minimumWidthPx: z.literal(1),
  }).strict(),
  maskSha256: z.string().regex(/^[a-f0-9]{64}$/),
  policySha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const openEditorSessionOutputSchema = z.object({
  id: editorSessionIdSchema,
  imageId: imageIdSchema,
  status: z.literal("active"),
  draft: editorDraftSchema.optional(),
}).strict();
const annotationOutputSchema = z.object({
  id: annotationIdSchema,
  imageId: imageIdSchema,
  itemCount: z.number().int().min(1).max(100),
  previewMimeType: z.literal("image/svg+xml"),
  hasMask: z.boolean(),
  maskMimeType: z.literal("image/png").nullable(),
  maskPolicy: maskPolicyOutputSchema.nullable(),
}).strict();
const editSubmissionOutputSchema = z.object({
  id: submissionIdSchema,
  parentImageId: imageIdSchema,
  annotationId: annotationIdSchema.nullable(),
  revisionSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const fingerprintSchema = z.string().regex(/^[a-f0-9]{20}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const releaseIdentityOutputSchema = z.object({
  pluginId: z.string().min(1),
  pluginVersion: z.string().min(1),
  serverBuildDigest: digestSchema,
  widgetAssetDigest: digestSchema,
  fingerprint: fingerprintSchema,
  resourceUris: z.object({ result: z.string().url(), editor: z.string().url() }),
});
const runtimeObservationOutputSchema = z.object({
  cwdFingerprint: fingerprintSchema,
  pluginRootFingerprint: fingerprintSchema,
  projectRootFingerprint: fingerprintSchema.nullable(),
  cwdRelationToPlugin: z.enum(["same", "descendant", "outside"]),
  projectRootRelationToPlugin: z.enum(["same", "descendant", "outside"]).nullable(),
  projectRootSource: z.enum(["unbound", "explicit_tool"]),
  client: z.object({
    reported: z.boolean(),
    nameFingerprint: fingerprintSchema.nullable(),
    nameLength: z.number().int().min(0),
    versionFingerprint: fingerprintSchema.nullable(),
    versionLength: z.number().int().min(0),
    capabilityCount: z.number().int().min(0),
    rootsDeclared: z.boolean(),
  }),
  roots: z.object({
    status: z.enum(["unsupported", "available", "error"]),
    count: z.number().int().min(0).max(MAX_RUNTIME_ROOT_ENTRIES),
    entries: z.array(z.object({
      scheme: z.string().min(1).max(MAX_RUNTIME_ROOT_SCHEME_LENGTH),
      fingerprint: fingerprintSchema,
      hasName: z.boolean(),
      comparable: z.boolean(),
      relationToCwd: z.enum(["same", "descendant", "outside"]).nullable(),
      relationToPlugin: z.enum(["same", "descendant", "outside"]).nullable(),
      relationToProject: z.enum(["same", "descendant", "outside"]).nullable(),
    })).max(MAX_RUNTIME_ROOT_ENTRIES),
    errorCode: z.string().nullable(),
    truncated: z.boolean(),
  }),
});
const retainedHostFieldKeys = new Set([
  "_meta", "accepted", "artifact", "artifacts", "blob", "canvasStatus", "capabilities",
  "childIds", "code", "content", "data", "dataBase64", "editorSession", "error", "errorCode",
  "field", "height", "id", "imageId", "imageIds", "isError", "mask", "message", "mimeType",
  "model", "models", "operation", "parentIds", "provider", "redacted", "resource", "status",
  "structuredContent", "text", "type", "uri", "widgetData", "width",
]);
const retainedHostErrorCodes = new Set([
  ...stableToolErrorMessages.keys(),
  "artifact_bridge_unavailable",
  "artifact_payload_invalid",
  "artifact_server_error",
  "artifact_tool_call_failed",
  "release_identity_mismatch",
  "roots_list_failed",
  "tools_call_rejected",
]);
const sensitiveHostFieldKeyPattern = /(api[_-]?key|authorization|credential|password|secret|token|cookie)/i;
const hostObservationProvenance = "unverified_widget_report";

export function createImagegenServer({
  releaseIdentity,
  launchContext,
  hostObservationStore = createInMemoryHostObservationStore(),
  editSubmissions = createEditSubmissionRegistry(),
  editorState = createEditorStateRegistry(),
  projectContext: providedProjectContext,
  readWidgetHtml,
  runTask,
  readArtifact,
  revealArtifact,
  readAnnotation,
  saveAnnotations,
  deleteAnnotation,
  configManager = { initialize: initializeImageConfig, inspect: inspectImageConfig, update: updateImageConfig },
}) {
  requireReleaseIdentity(releaseIdentity);
  requireLaunchContext(launchContext);
  const projectContext = providedProjectContext ?? createProjectContext({ pluginRoot: launchContext.pluginRoot });
  requireProjectContext(projectContext);
  const { result: resultWidgetUri, editor: editorWidgetUri } = releaseIdentity.resourceUris;
  const server = new McpServer(
    {
      name: releaseIdentity.pluginId,
      version: releaseIdentity.pluginVersion,
    },
    {
      capabilities: {
        experimental: {
          // Development-only: release-bound widget URIs require a fresh tools/list during pre-release validation.
          "codex/tool-catalog-cache": { cacheable: false },
        },
      },
    },
  );
  const imageAuditHandlers = createImageAuditHandlers({ runTask, readArtifact });
  registerConfigTools(server, configManager, toolError);

  registerWidgetResource(server, {
    name: "image-result",
    uri: resultWidgetUri,
    title: "图片结果",
    description: "在会话结果中持续显示图片，并提供在同一宿主实例展开聚焦画布的入口。",
    releaseIdentity,
    readWidgetHtml,
  });
  registerWidgetResource(server, {
    name: "image-editor",
    uri: editorWidgetUri,
    title: "图片编辑画布",
    description: "为会话图片结果展开与稳定图片 ID 绑定的聚焦画布。",
    releaseIdentity,
    readWidgetHtml,
  });
  registerWidgetResource(server, {
    name: "image-result-legacy-stable",
    uri: `ui://${releaseIdentity.pluginId}/result.html`,
    title: "图片结果",
    description: "在会话结果中持续显示图片，并提供在同一宿主实例展开聚焦画布的入口。",
    releaseIdentity,
    readWidgetHtml,
  });
  registerWidgetResource(server, {
    name: "image-editor-legacy-stable",
    uri: `ui://${releaseIdentity.pluginId}/editor.html`,
    title: "图片编辑画布",
    description: "为会话图片结果展开与稳定图片 ID 绑定的聚焦画布。",
    releaseIdentity,
    readWidgetHtml,
  });
  for (const fingerprint of legacyWidgetResourceFingerprints) {
    registerWidgetResource(server, {
      name: `image-result-legacy-${fingerprint}`,
      uri: `ui://${releaseIdentity.pluginId}/result-${fingerprint}.html`,
      title: "图片结果",
      description: "在会话结果中持续显示图片，并提供在同一宿主实例展开聚焦画布的入口。",
      releaseIdentity,
      readWidgetHtml,
    });
    registerWidgetResource(server, {
      name: `image-editor-legacy-${fingerprint}`,
      uri: `ui://${releaseIdentity.pluginId}/editor-${fingerprint}.html`,
      title: "图片编辑画布",
      description: "为会话图片结果展开与稳定图片 ID 绑定的聚焦画布。",
      releaseIdentity,
      readWidgetHtml,
    });
  }

  server.registerTool(
    "bind_imagegen_project",
    {
      title: "绑定图片项目",
      description: "把当前任务绑定到一个已存在的绝对项目根目录，确保实际图片产物目录包含只含 * 的本地 .gitignore，并返回供后续模型与 App-only 工具跨 MCP 进程使用的图片项目绑定 ID。配置变化后携带同一绑定 ID 再次绑定可更新配置摘要。",
      inputSchema: {
        projectRoot: z.string().min(1),
        projectBindingId: projectBindingIdSchema.optional(),
      },
      outputSchema: z.object({
        status: z.enum(["bound", "already_bound", "rebound"]),
        projectBindingId: projectBindingIdSchema,
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ projectRoot, projectBindingId }) => {
      try {
        const receipt = await projectContext.bind({
          projectRoot,
          ...(projectBindingId ? { projectBindingId } : {}),
        });
        const text = receipt.status === "bound"
          ? "已绑定当前图片项目。"
          : receipt.status === "rebound"
            ? "已更新当前图片项目的配置绑定。"
            : "当前图片项目已经绑定。";
        return { content: [{ type: "text", text }], structuredContent: receipt };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "inspect_imagegen_runtime",
    {
      title: "检查图片运行环境",
      description: "返回当前 MCP server、启动根关系和客户端 roots 能力的脱敏诊断信息，不返回本机路径或 root URI。",
      inputSchema: { projectBindingId: projectBindingIdSchema.optional() },
      outputSchema: {
        hostObservationReport: hostObservationReportOutputSchema,
        releaseIdentity: releaseIdentityOutputSchema,
        runtime: runtimeObservationOutputSchema,
      },
      annotations: readAnnotations(),
    },
    async ({ projectBindingId }) => {
      try {
        const clientCapabilities = server.server.getClientCapabilities() ?? {};
        const rootsSupported = Boolean(clientCapabilities.roots);
        let roots = [];
        let rootsErrorCode = null;
        if (rootsSupported) {
          try {
            roots = (await server.server.listRoots()).roots ?? [];
          } catch {
            rootsErrorCode = "roots_list_failed";
          }
        }
        const boundProject = await optionalProjectContext(projectContext, projectBindingId);
        const runtime = createRuntimeObservation({
          ...launchContext,
          projectRoot: boundProject?.projectRoot ?? null,
          projectRootSource: boundProject ? "explicit_tool" : "unbound",
          clientVersion: server.server.getClientVersion(),
          clientCapabilities,
          rootsSupported,
          roots,
          rootsErrorCode,
        });
        const hostObservationReport = boundProject
          ? await hostObservationStore.read({
            context: boundProject,
            releaseFingerprint: releaseIdentity.fingerprint,
          })
          : null;
        return {
          content: [{ type: "text", text: "已读取图片 MCP 的脱敏运行环境。" }],
          structuredContent: { hostObservationReport, releaseIdentity, runtime },
          _meta: { releaseIdentity },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "report_imagegen_host_observation",
    {
      title: "记录图片工作台宿主形状",
      description: "记录当前发布版本下两类标准宿主结果的脱敏结构。该报告只能标记为未验证的 widget 上报，不是宿主来源证明；不记录图片、文本值、本机路径或客户端身份。",
      inputSchema: {
        ...projectBindingInputSchema,
        releaseFingerprint: fingerprintSchema,
        observations: hostObservationInputSchema,
      },
      outputSchema: {
        accepted: z.number().int().min(0).max(2),
        provenance: z.literal(hostObservationProvenance),
        scope: hostObservationScopeSchema,
        error: z.object({ code: stableHostErrorCodeSchema }).strict().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ projectBindingId, releaseFingerprint, observations }) => await withBoundProject(
      projectContext,
      projectBindingId,
      async (context) => {
        const scope = getHostObservationScope(context);
      if (releaseFingerprint !== releaseIdentity.fingerprint) {
        return stableToolError("release_identity_mismatch", {
          provenance: hostObservationProvenance,
          scope: scope.label,
        });
      }
      const copiedObservations = observations.map(copyHostObservation);
      const report = {
        provenance: hostObservationProvenance,
        scope: scope.label,
        observations: copiedObservations,
      };
      await hostObservationStore.write({
        context,
        releaseFingerprint: releaseIdentity.fingerprint,
        report,
      });
      return {
        content: [{ type: "text", text: "已记录当前发布版本的未验证 widget 结果结构。" }],
        structuredContent: {
          accepted: copiedObservations.length,
          provenance: hostObservationProvenance,
          scope: scope.label,
        },
      };
      },
    ),
  );

  server.registerTool(
    "list_image_models",
    {
      title: "读取图片模型",
      description: "返回当前图片配置中可用的图片模型及安全能力声明。",
      inputSchema: { ...projectBindingInputSchema },
      outputSchema: z.object({ models: z.array(imageModelOutputSchema) }).strict(),
      annotations: readAnnotations(),
    },
    async ({ projectBindingId }) => await withBoundProject(projectContext, projectBindingId, async (context) => {
      try {
        const result = await runTask(
          { operation: "list_models", modelProfileId: "primary/gpt-image-2" },
          context,
        );
        if (!result?.ok) return toolError(new Error(result?.error?.message || "model catalog unavailable"), result?.error?.code);
        const models = z.array(imageModelOutputSchema).parse(result.models);
        return {
          content: [{ type: "text", text: `已读取 ${result.models.length} 个图片模型。` }],
          structuredContent: { models },
        };
      } catch (error) {
        return toolError(error);
      }
    }),
  );

  server.registerTool(
    "generate_image",
    {
      title: "生成图片",
      description: "使用已配置的 gpt-image-2 生成一张或多张独立候选图片。多候选由运行时按顺序执行等量单图请求，全部成功后才返回整组。",
      inputSchema: {
        ...projectBindingInputSchema,
        prompt: z.string().min(1),
        modelProfileId: z.literal("primary/gpt-image-2").optional(),
        transparency: transparencyInputSchema.optional(),
        ...outputSchema,
      },
      outputSchema: imageArtifactsOutputSchema,
      annotations: writeAnnotations(),
    },
    async ({ projectBindingId, prompt, modelProfileId = "primary/gpt-image-2", transparency, ...output }) =>
      await withBoundProject(projectContext, projectBindingId, async (context) => await executeImageTask(
        {
          operation: "generate",
          modelProfileId,
          prompt,
          inputArtifactIds: [],
          annotationId: null,
          ...(transparency ? { transparency } : {}),
          output,
        },
        context,
        runTask,
        readArtifact,
      )),
  );

  server.registerTool(
    "edit_image",
    {
      title: "编辑图片",
      description: "基于父图片和提示创建新的不可变图片版本。",
      inputSchema: {
        ...projectBindingInputSchema,
        parentImageId: imageIdSchema,
        prompt: z.string().min(1),
        referenceImageIds: z.array(imageIdSchema).optional(),
        annotationId: annotationIdSchema.optional(),
        submissionId: submissionIdSchema.optional(),
        modelProfileId: z.literal("primary/gpt-image-2").optional(),
        transparency: transparencyInputSchema.optional(),
        ...outputSchema,
      },
      outputSchema: imageArtifactsOutputSchema,
      annotations: writeAnnotations(),
    },
    async (arguments_) =>
      await withBoundProject(projectContext, arguments_.projectBindingId, async (context) => {
      const {
        parentImageId,
        referenceImageIds = [],
        prompt,
        modelProfileId = "primary/gpt-image-2",
        transparency,
        ...output
      } = arguments_;
      const annotationId = arguments_.annotationId ?? null;
      delete output.projectBindingId;
      delete output.annotationId;
      delete output.submissionId;
      let claimedSubmission;
      try {
        claimedSubmission = await editSubmissions.claimForEdit({
          artifactRoot: context.artifactRoot,
          bindingKey: context.bindingKey,
          parentImageId,
          ...(Object.hasOwn(arguments_, "submissionId") ? { submissionId: arguments_.submissionId } : {}),
          ...(Object.hasOwn(arguments_, "annotationId") ? { annotationId: arguments_.annotationId } : {}),
        });
      } catch (error) {
        return toolError(error);
      }
      let submissionCommitted = false;
      try {
        if (claimedSubmission?.completedArtifactIds) {
          submissionCommitted = true;
          return await readImageTaskResult(
            claimedSubmission.completedArtifactIds,
            context,
            readArtifact,
            { recovered: true },
          );
        }
        let annotation = null;
        if (annotationId) {
          try {
            annotation = await readAnnotation(annotationId, context);
          } catch (error) {
            return toolError(error, "annotation_not_found");
          }
          if (annotation.imageId !== parentImageId) {
            return toolError(new Error("标注不属于当前父图片"), "annotation_image_mismatch");
          }
        }
        let taskOutput = output;
        if (annotation?.maskPath) {
          if (!annotation.maskPolicy) {
            return toolError(new Error("legacy mask has no signed policy"), "mask_policy_missing");
          }
          if (annotation.maskPolicy.policyVersion !== "mask-policy-v2") {
            return toolError(
              new Error("legacy mask policy is read-only; reopen the canvas and submit the annotations again"),
              "mask_policy_unsupported",
            );
          }
          if (!claimedSubmission) {
            return toolError(new Error("masked edits require a pending canvas submission"), "missing_edit_submission");
          }
          if (
            claimedSubmission.maskSha256 !== annotation.maskPolicy.maskSha256
            || claimedSubmission.maskPolicySha256 !== annotation.maskPolicy.policySha256
            || annotation.maskPolicy.parentImageId !== parentImageId
            || annotation.maskPolicy.annotationId !== annotationId
          ) {
            return toolError(new Error("submission mask policy mismatch"), "edit_submission_mismatch");
          }
          if (annotation.maskPolicy.modelProfileId !== modelProfileId) {
            return toolError(new Error("mask policy model profile mismatch"), "invalid_task");
          }
          try {
            taskOutput = deriveMaskedEditOutput(output, annotation.maskPolicy);
          } catch (error) {
            return toolError(error, "invalid_task");
          }
        } else if (
          annotation?.maskPolicy
          || claimedSubmission?.maskSha256
          || claimedSubmission?.maskPolicySha256
        ) {
          return toolError(new Error("submission mask metadata mismatch"), "edit_submission_mismatch");
        }

        return await executeImageTask(
          {
            operation: "edit",
            modelProfileId,
            prompt,
            inputArtifactIds: [parentImageId, ...referenceImageIds],
            annotationId,
            ...(claimedSubmission ? { submissionId: claimedSubmission.receipt.id } : {}),
            ...(annotation?.maskPath ? { mask: annotation.maskPath } : {}),
            ...(annotation?.maskPolicy ? { maskPolicy: annotation.maskPolicy } : {}),
            ...(transparency ? { transparency } : {}),
            output: taskOutput,
          },
          context,
          runTask,
          readArtifact,
          {
            onTaskCommitted: async (artifacts) => {
              if (!claimedSubmission) return;
              await editSubmissions.complete({
                artifactRoot: context.artifactRoot,
                bindingKey: context.bindingKey,
                parentImageId,
                submissionId: claimedSubmission.receipt.id,
                claimGeneration: claimedSubmission.claimGeneration,
                artifactIds: artifacts.map((artifact) => artifact.id),
              });
              submissionCommitted = true;
            },
          },
        );
      } finally {
        if (claimedSubmission && !submissionCommitted) {
          await editSubmissions.releaseForEdit({
            artifactRoot: context.artifactRoot,
            bindingKey: context.bindingKey,
            parentImageId,
            submissionId: claimedSubmission.receipt.id,
            claimGeneration: claimedSubmission.claimGeneration,
          });
        }
      }
    }),
  );

  server.registerTool(
    "batch_images",
    {
      title: "批量处理图片",
      description: "执行一组相互独立的生成和普通编辑任务；结果按输入顺序逐项返回，允许部分成功，不自动展示图片。",
      inputSchema: {
        ...projectBindingInputSchema,
        items: batchItemsSchema,
        concurrency: z.number().int().min(1).max(8).optional(),
      },
      outputSchema: imageBatchOutputSchema,
      annotations: writeAnnotations(),
    },
    async ({ projectBindingId, items, concurrency = 3 }) =>
      await withBoundProject(projectContext, projectBindingId, async (context) => {
        const batch = await executeImageBatch({
          items,
          concurrency,
          context,
          runTask,
          readArtifact,
          validateEdit: async (item) => {
            await editSubmissions.resolveForEdit({
              artifactRoot: context.artifactRoot,
              bindingKey: context.bindingKey,
              parentImageId: item.parentImageId,
            });
          },
          recordManifest: async (manifest) => await runTask({
            operation: "record_batch",
            modelProfileId: "primary/gpt-image-2",
            manifest,
          }, context),
        });
        const artifacts = batch.results.flatMap((item) => (item.ok ? item.artifacts : []));
        return {
          content: [{
            type: "text",
            text: `批量图片任务完成：成功 ${batch.summary.succeeded} 项，失败 ${batch.summary.failed} 项。`,
          }],
          structuredContent: batch,
          _meta: {
            imageIds: batch.artifactIds,
            artifacts,
            ...(batch.batchId ? { batchId: batch.batchId } : {}),
          },
        };
      }),
  );

  server.registerTool(
    "get_image_batch_manifest",
    {
      title: "读取批处理记录",
      description: "按稳定批次 ID 读取不可变批处理 manifest；返回逐项原图、交付收据和错误状态，不自动展示图片。",
      inputSchema: { ...projectBindingInputSchema, batchId: batchIdSchema },
      outputSchema: batchManifestOutputSchema,
      annotations: readAnnotations(),
    },
    async ({ projectBindingId, batchId }) =>
      await withBoundProject(projectContext, projectBindingId, async (context) =>
        await imageAuditHandlers.getBatchManifest({ batchId, context })),
  );

  server.registerTool(
    "get_image_delivery_receipt",
    {
      title: "读取图片交付记录",
      description: "按稳定交付收据 ID 读取不可变派生产物和 QA 摘要；不自动展示图片。",
      inputSchema: { ...projectBindingInputSchema, deliveryReceiptId: deliveryReceiptIdSchema },
      outputSchema: imageDeliveryOutputSchema,
      annotations: readAnnotations(),
    },
    async ({ projectBindingId, deliveryReceiptId }) =>
      await withBoundProject(projectContext, projectBindingId, async (context) =>
        await imageAuditHandlers.getDeliveryReceipt({ deliveryReceiptId, context })),
  );

  server.registerTool(
    "deliver_image",
    {
      title: "交付图片",
      description: "基于稳定图片 ID 执行本地精确尺寸、网格、预览板和 QA 交付；原图保持不变，派生图单独存储，结果不会自动挂载图片画布。",
      inputSchema: {
        ...projectBindingInputSchema,
        imageId: imageIdSchema,
        modelProfileId: z.literal("primary/gpt-image-2").optional(),
        delivery: deliveryInputSchema,
      },
      outputSchema: imageDeliveryOutputSchema,
      annotations: writeAnnotations(),
    },
    async ({ projectBindingId, imageId, modelProfileId = "primary/gpt-image-2", delivery }) =>
      await withBoundProject(projectContext, projectBindingId, async (context) => {
        try {
          const result = await runTask(
            {
              operation: "deliver",
              modelProfileId,
              inputArtifactIds: [imageId],
              delivery,
            },
            context,
          );
          if (!result?.ok) {
            return toolError(
              new Error(result?.error?.message || "image delivery failed"),
              result?.error?.code,
            );
          }
          if (result.sourceArtifactId !== imageId) {
            return toolError(new Error("delivery source artifact mismatch"), "invalid_task");
          }
          const artifactIds = (result.artifacts || []).map((item) => item.id);
          const records = await Promise.all(artifactIds.map((id) => readArtifact(id, context)));
          const artifacts = records.map(({ metadata }) => imageArtifactMetadata(metadata));
          const qa = safeDeliveryQa(result.qa);
          const warnings = safeDeliveryWarnings(result.warnings);
          const summary = safeDeliverySummary(result.summary);
          return {
            content: [{
              type: "text",
              text: result.deliveryReady
                ? `已完成图片 ${imageId} 的本地交付。`
                : `图片 ${imageId} 已保留原图，交付条件尚未满足。`,
            }],
            structuredContent: {
              sourceArtifactId: imageId,
              ...(deliveryReceiptIdPattern.test(result.deliveryReceiptId)
                ? { deliveryReceiptId: result.deliveryReceiptId }
                : {}),
              deliveryReady: Boolean(result.deliveryReady),
              artifacts,
              ...(qa !== undefined ? { qa } : {}),
              ...(warnings.length ? { warnings } : {}),
              ...(summary !== undefined ? { summary } : {}),
            },
            _meta: {
              imageIds: artifactIds,
              artifacts,
              sourceArtifactId: imageId,
            },
          };
        } catch (error) {
          return toolError(error);
        }
      }),
  );

  server.registerTool(
    "get_image_artifact",
    {
      title: "读取图片产物",
      description: "按稳定图片 ID 读取图片内容、安全元数据和当前画布可用状态。",
      inputSchema: { ...projectBindingInputSchema, imageId: imageIdSchema },
      outputSchema: z.object({
        artifact: imageArtifactOutputSchema,
        canvasStatus: z.enum(["available", "destroyed"]),
      }).strict(),
      annotations: readAnnotations(),
    },
    async ({ projectBindingId, imageId }) => await withBoundProject(projectContext, projectBindingId, async (context) => {
      try {
        const artifact = await readArtifact(imageId, context);
        return {
          content: [imageContent(artifact), { type: "text", text: `已读取图片 ${imageId}。` }],
          structuredContent: {
            artifact: imageArtifactMetadata(artifact.metadata),
            canvasStatus: (await editorState.getCanvasStatuses({
              artifactRoot: context.artifactRoot,
              bindingKey: context.bindingKey,
              imageIds: [imageId],
            }))[0],
          },
          _meta: { imageId },
        };
      } catch (error) {
        return toolError(error);
      }
    }),
  );

  server.registerTool(
    "read_image_artifact_data",
    {
      title: "读取工作台图片数据",
      description: "供图片工作台按稳定图片 ID 读取图片像素数据。该工具只对 app/widget 可见。",
      inputSchema: { ...projectBindingInputSchema, imageId: imageIdSchema },
      outputSchema: z.object({
        artifact: imageArtifactOutputSchema,
        canvasStatus: z.enum(["available", "destroyed"]),
      }).strict(),
      annotations: readAnnotations(),
      _meta: {
        ui: { visibility: ["app"] },
        "openai/widgetAccessible": true,
      },
    },
    async ({ projectBindingId, imageId }) => await withBoundProject(projectContext, projectBindingId, async (context) => {
      try {
        const artifact = await readArtifact(imageId, context);
        assertArtifactIdentity(artifact, imageId);
        return {
          content: [{ type: "text", text: `已为图片工作台读取图片 ${imageId}。` }],
          structuredContent: {
            artifact: imageArtifactMetadata(artifact.metadata),
            canvasStatus: (await editorState.getCanvasStatuses({
              artifactRoot: context.artifactRoot,
              bindingKey: context.bindingKey,
              imageIds: [imageId],
            }))[0],
          },
          _meta: {
            widgetData: {
              id: artifact.metadata.id,
              mimeType: artifact.metadata.mimeType,
              dataBase64: artifact.data,
            },
          },
        };
      } catch (error) {
        return toolError(
          error,
          isStableToolErrorCode(error?.code) ? error.code : "artifact_read_failed",
        );
      }
    }),
  );

  server.registerTool(
    "reveal_image_artifact",
    {
      title: "在文件夹中显示图片",
      description: "按稳定图片 ID 在系统文件管理器中显示并选中对应的本机图片文件。该工具只对图片工作台可见，不返回本机路径。",
      inputSchema: { ...projectBindingInputSchema, imageId: imageIdSchema },
      outputSchema: z.object({
        status: z.literal("revealed"),
        imageId: imageIdSchema,
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: { visibility: ["app"] },
        "openai/widgetAccessible": true,
      },
    },
    async ({ projectBindingId, imageId }) => await withBoundProject(projectContext, projectBindingId, async (context) => {
      try {
        const revealResult = await revealArtifact(imageId, context);
        if (revealResult?.status !== "revealed" || revealResult.imageId !== imageId) {
          throw new Error("artifact reveal confirmation is invalid");
        }
        return {
          content: [{ type: "text", text: `已在文件夹中显示图片 ${imageId}。` }],
          structuredContent: { status: "revealed", imageId },
        };
      } catch (error) {
        return toolError(error, "artifact_reveal_failed");
      }
    }),
  );

  server.registerTool(
    "render_image_results",
    {
      title: "显示图片结果",
      description: "在一个会话结果容器中按顺序显示一张或多张已创建图片，并为每张图片提供独立画布入口。生成或编辑成功后只调用一次。",
      inputSchema: { ...projectBindingInputSchema, imageIds: z.array(imageIdSchema).min(1).max(10) },
      outputSchema: z.object({
        imageIds: z.array(imageIdSchema).min(1).max(10),
        artifacts: z.array(imageArtifactOutputSchema.extend({
          canvasStatus: z.enum(["available", "destroyed"]),
        })).min(1).max(10),
      }).strict(),
      annotations: readAnnotations(),
      _meta: {
        ui: { resourceUri: resultWidgetUri },
        releaseIdentity,
      },
    },
    async ({ projectBindingId, imageIds }) => await withBoundProject(projectContext, projectBindingId, async (context) => {
      try {
        if (new Set(imageIds).size !== imageIds.length) {
          return toolError(new Error("图片 ID 不得重复"), "invalid_task");
        }
        const records = await Promise.all(imageIds.map(async (imageId) => {
          const artifact = await readArtifact(imageId, context);
          assertArtifactIdentity(artifact, imageId);
          return artifact;
        }));
        const canvasStatuses = await editorState.getCanvasStatuses({
          artifactRoot: context.artifactRoot,
          bindingKey: context.bindingKey,
          imageIds,
        });
        const artifacts = records.map(({ metadata }, index) => ({
          ...imageArtifactMetadata(metadata),
          canvasStatus: canvasStatuses[index],
        }));
        return {
          content: [
            { type: "text", text: `已显示 ${imageIds.length} 张图片。` },
            ...records.map(imageContent),
          ],
          structuredContent: { imageIds, artifacts },
          _meta: {
            ui: { resourceUri: resultWidgetUri },
            releaseIdentity,
            imageIds,
          },
        };
      } catch (error) {
        return toolError(
          error,
          isStableToolErrorCode(error?.code) ? error.code : "artifact_read_failed",
        );
      }
    }),
  );

  server.registerTool(
    "open_image_editor",
    {
      title: "打开图片画布",
      description: "按稳定图片 ID 打开对应的聚焦图片画布；已在当前图片项目绑定中显式销毁的图片画布不能再次打开。",
      inputSchema: { ...projectBindingInputSchema, imageId: imageIdSchema },
      outputSchema: z.object({
        editorSession: openEditorSessionOutputSchema,
        artifact: imageArtifactOutputSchema,
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: editorWidgetUri, visibility: ["app"] },
        releaseIdentity,
      },
    },
    async ({ projectBindingId, imageId }) => await withBoundProject(projectContext, projectBindingId, async (context) => {
      let artifact;
      try {
        artifact = await readArtifact(imageId, context);
      } catch (error) {
        return toolError(error, "artifact_not_found");
      }
      try {
        const editorSession = await editorState.open({
          artifactRoot: context.artifactRoot,
          bindingKey: context.bindingKey,
          imageId,
        });
        return {
          content: [{ type: "text", text: `已打开图片 ${imageId} 的聚焦画布，画布会话 ID 为 ${editorSession.id}。` }],
          structuredContent: {
            editorSession: editorSessionOutput(editorSession),
            artifact: imageArtifactMetadata(artifact.metadata),
          },
          _meta: {
            ui: { resourceUri: editorWidgetUri },
            releaseIdentity,
            imageId,
            editorSessionId: editorSession.id,
          },
        };
      } catch (error) {
        return toolError(error);
      }
    }),
  );

  server.registerTool(
    "save_image_annotations",
    {
      title: "保存图片标注",
      description: "一次保存当前图片上的多条独立归一化标注，并返回稳定标注 ID。",
      inputSchema: {
        ...projectBindingInputSchema,
        imageId: imageIdSchema,
        items: z.array(annotationItemSchema).min(1).max(100),
      },
      outputSchema: z.object({ annotation: annotationOutputSchema }).strict(),
      annotations: writeAnnotations(),
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ projectBindingId, imageId, items }) => await withBoundProject(projectContext, projectBindingId, async (context) => {
      try {
        await readArtifact(imageId, context);
        const annotation = await saveAnnotations({ imageId, items }, context);
        return {
          content: [{ type: "text", text: `已保存图片 ${imageId} 的 ${annotation.itemCount} 条标注。` }],
          structuredContent: { annotation },
        };
      } catch (error) {
        return toolError(error, "annotation_save_failed");
      }
    }),
  );

  server.registerTool(
    "prepare_image_edit_submission",
    {
      title: "准备图片修改提交",
      description: "保存当前画布修订并签发一次服务端提交 ID，使后续 edit_image 只能使用同一父图、标注和 mask 策略。",
      inputSchema: {
        ...projectBindingInputSchema,
        parentImageId: imageIdSchema,
        items: z.array(annotationItemSchema).max(100),
        sourcePrompt: z.string().max(600),
      },
      outputSchema: z.object({
        annotation: annotationOutputSchema.nullable(),
        submission: editSubmissionOutputSchema,
      }).strict(),
      annotations: writeAnnotations(),
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ projectBindingId, parentImageId, items, sourcePrompt }) => await withBoundProject(
      projectContext,
      projectBindingId,
      async (context) => {
        try {
          await readArtifact(parentImageId, context);
        } catch (error) {
          return toolError(error, "artifact_not_found");
        }

        let annotation = null;
        if (items.length) {
          try {
            annotation = await saveAnnotations({ imageId: parentImageId, items }, context);
          } catch (error) {
            return toolError(error, "annotation_save_failed");
          }
          const containsMask = items.some((item) => item.type === "mask");
          if (containsMask && (!annotation.hasMask || !annotation.maskPolicy)) {
            return await rollbackPreparedAnnotation(
              annotation,
              deleteAnnotation,
              context,
              new Error("masked annotation has no signed mask policy"),
              "mask_policy_missing",
            );
          }
          if (containsMask !== annotation.hasMask || Boolean(annotation.maskPolicy) !== annotation.hasMask) {
            return await rollbackPreparedAnnotation(
              annotation,
              deleteAnnotation,
              context,
              new Error("annotation mask metadata is inconsistent"),
              "invalid_task",
            );
          }
        }

        try {
          const submission = await editSubmissions.issue({
            artifactRoot: context.artifactRoot,
            bindingKey: context.bindingKey,
            parentImageId,
            annotationId: annotation?.id ?? null,
            maskSha256: annotation?.maskPolicy?.maskSha256 ?? null,
            maskPolicySha256: annotation?.maskPolicy?.policySha256 ?? null,
            sourcePrompt,
            items,
          });
          return {
            content: [{ type: "text", text: `已准备图片 ${parentImageId} 的待发送修改。` }],
            structuredContent: { annotation, submission },
          };
        } catch (error) {
          return await rollbackPreparedAnnotation(
            annotation,
            deleteAnnotation,
            context,
            error,
            error?.code ?? "invalid_task",
          );
        }
      },
    ),
  );

  server.registerTool(
    "save_image_editor_draft",
    {
      title: "保存画布临时草稿",
      description: "在宿主卸载当前画布前保存未提交的标注和补充要求，供下一次打开同一图片画布时恢复一次。",
      inputSchema: {
        ...projectBindingInputSchema,
        editorSessionId: editorSessionIdSchema,
        draft: editorDraftSchema,
      },
      outputSchema: z.object({ editorSession: editorSessionOutputSchema }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ projectBindingId, editorSessionId, draft }) => await withBoundProject(
      projectContext,
      projectBindingId,
      async (context) => editorSessionResult(await editorState.saveDraft({
        artifactRoot: context.artifactRoot,
        bindingKey: context.bindingKey,
        editorSessionId,
        draft,
      })),
    ),
  );

  server.registerTool(
    "get_image_editor_session",
    {
      title: "读取画布会话状态",
      description: "供图片画布检查自身是否仍处于活动状态。",
      inputSchema: { ...projectBindingInputSchema, editorSessionId: editorSessionIdSchema },
      outputSchema: z.object({ editorSession: editorSessionOutputSchema }).strict(),
      annotations: readAnnotations(),
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ projectBindingId, editorSessionId }) => await withBoundProject(
      projectContext,
      projectBindingId,
      async (context) => editorSessionResult(await editorState.getSession({
        artifactRoot: context.artifactRoot,
        bindingKey: context.bindingKey,
        editorSessionId,
      })),
    ),
  );

  server.registerTool(
    "destroy_image_editor",
    {
      title: "销毁图片画布",
      description: "结束并释放指定图片在当前图片项目绑定中的全部活动画布会话，并终止该图片在此绑定中的重新打开入口。仅在用户明确要求销毁，或任务已明确转移且当前图片不再需要继续查看、标注或修改时调用；普通隐藏、关闭右栏或暂时讨论其他内容时不要调用。",
      inputSchema: { ...projectBindingInputSchema, editorSessionId: editorSessionIdSchema },
      outputSchema: z.object({ editorSession: editorSessionOutputSchema }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectBindingId, editorSessionId }) => await withBoundProject(projectContext, projectBindingId, async (context) => {
      const editorSession = await editorState.destroy({
        artifactRoot: context.artifactRoot,
        bindingKey: context.bindingKey,
        editorSessionId,
      });
      if (!editorSession) return editorSessionResult({ id: editorSessionId }, "released");
      return editorSessionResult(editorSession);
    }),
  );

  server.registerTool(
    "finalize_image_editor_session",
    {
      title: "释放画布会话状态",
      description: "供图片画布在宿主卸载前释放自身的临时会话状态。",
      inputSchema: { ...projectBindingInputSchema, editorSessionId: editorSessionIdSchema },
      outputSchema: z.object({ editorSession: editorSessionOutputSchema }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ projectBindingId, editorSessionId }) => await withBoundProject(projectContext, projectBindingId, async (context) => {
      const editorSession = await editorState.finalize({
        artifactRoot: context.artifactRoot,
        bindingKey: context.bindingKey,
        editorSessionId,
      });
      return editorSessionResult(editorSession || { id: editorSessionId }, "released");
    }),
  );

  return server;
}

async function rollbackPreparedAnnotation(annotation, deleteAnnotation, context, error, code) {
  if (!annotation) return toolError(error, code);
  try {
    await deleteAnnotation(annotation.id, context);
  } catch {
    return toolError(new Error("failed to remove rejected annotation"), "annotation_save_failed");
  }
  return toolError(error, code);
}

function assertArtifactIdentity(artifact, imageId) {
  if (artifact?.metadata?.id !== imageId) {
    throw new Error("artifact identity mismatch");
  }
}

function editorSessionResult(editorSession, status = editorSession?.status) {
  if (!editorSession) return toolError(new Error("画布会话不存在或已经释放"), "editor_session_not_found");
  const result = editorSessionOutput(editorSession, status);
  return {
    content: [{ type: "text", text: `画布会话 ${result.id} 当前状态为 ${result.status}。` }],
    structuredContent: { editorSession: result },
  };
}

function editorSessionOutput(editorSession, status = editorSession.status) {
  return {
    id: editorSession.id,
    ...(editorSession.imageId ? { imageId: editorSession.imageId } : {}),
    status,
    ...(editorSession.draft ? { draft: editorSession.draft } : {}),
  };
}

async function executeImageTask(task, context, runTask, readArtifact, { onTaskCommitted } = {}) {
  try {
    const result = await runTask(task, context);
    if (!result?.ok) {
      return toolError(new Error(result?.error?.message || "image task failed"), result?.error?.code);
    }
    await onTaskCommitted?.(result.artifacts);
    return await readImageTaskResult(
      result.artifacts.map((item) => item.id),
      context,
      readArtifact,
    );
  } catch (error) {
    return toolError(error);
  }
}


async function readImageTaskResult(artifactIds, context, readArtifact, { recovered = false } = {}) {
  try {
    const artifacts = await Promise.all(artifactIds.map((id) => readArtifact(id, context)));
    const artifactMetadata = artifacts.map(({ metadata: item }) => imageArtifactMetadata(item));
    const structuredContent = { artifacts: artifactMetadata };
    const metadata = artifactMetadata.length === 1 ? artifactMetadata[0] : null;
    if (metadata) structuredContent.artifact = metadata;
    return {
      content: [{
        type: "text",
        text: recovered ? `已恢复 ${artifacts.length} 张既有图片。` : `已创建 ${artifacts.length} 张图片。`,
      }],
      structuredContent,
      _meta: {
        imageIds: artifactIds,
        artifacts: artifactMetadata,
        ...(metadata ? { imageId: metadata.id } : {}),
      },
    };
  } catch (error) {
    return toolError(error);
  }
}


function deriveMaskedEditOutput(output, maskPolicy) {
  const required = {
    size: `${maskPolicy.width}x${maskPolicy.height}`,
    format: "png",
    count: 1,
  };
  for (const [key, value] of Object.entries(required)) {
    if (Object.hasOwn(output, key) && output[key] !== value) {
      throw new Error(`masked edit ${key} conflicts with the signed mask policy`);
    }
  }
  return { ...output, ...required };
}


async function withBoundProject(projectContext, projectBindingId, callback) {
  try {
    return await callback(await projectContext.require(projectBindingId));
  } catch (error) {
    return toolError(error);
  }
}

function registerWidgetResource(server, { name, uri, title, description, releaseIdentity, readWidgetHtml }) {
  const resourceDomains = ["data:", "blob:"];
  const metadata = {
    ui: {
      csp: {
        connectDomains: [],
        resourceDomains,
      },
    },
    "openai/widgetDescription": description,
    "openai/widgetCSP": {
      connect_domains: [],
      resource_domains: resourceDomains,
    },
    releaseIdentity,
  };
  registerAppResource(
    server,
    name,
    uri,
    { title, description },
    async () => ({
      contents: [{
        uri,
        mimeType: RESOURCE_MIME_TYPE,
        text: await readWidgetHtml(),
        _meta: metadata,
      }],
    }),
  );
}


function requireReleaseIdentity(releaseIdentity) {
  if (
    !releaseIdentity
    || typeof releaseIdentity.pluginId !== "string"
    || typeof releaseIdentity.pluginVersion !== "string"
    || typeof releaseIdentity.fingerprint !== "string"
    || typeof releaseIdentity.resourceUris?.result !== "string"
    || typeof releaseIdentity.resourceUris?.editor !== "string"
  ) {
    throw new Error("releaseIdentity is required to create the MCP server");
  }
}


function requireLaunchContext(launchContext) {
  if (
    !launchContext
    || typeof launchContext.cwd !== "string"
    || typeof launchContext.pluginRoot !== "string"
  ) {
    throw new Error("launchContext is required to create the MCP server");
  }
}


function requireProjectContext(projectContext) {
  if (
    !projectContext
    || typeof projectContext.bind !== "function"
    || typeof projectContext.require !== "function"
  ) {
    throw new Error("projectContext must provide bind and require");
  }
}


async function optionalProjectContext(projectContext, projectBindingId) {
  if (projectBindingId === undefined) return null;
  return await projectContext.require(projectBindingId);
}

function imageContent(artifact) {
  return { type: "image", data: artifact.data, mimeType: artifact.metadata.mimeType };
}

function imageArtifactMetadata(metadata) {
  return { ...metadata };
}

function getHostObservationScope(context) {
  return {
    key: `project-binding:${context.bindingKey}`,
    label: "project_binding_latest",
  };
}

function copyHostObservation(observation) {
  return {
    source: observation.source,
    fields: observation.fields.map((field) => ({
      ...field,
      path: sanitizeHostFieldPath(field.path),
    })),
    errorCodes: [...new Set(observation.errorCodes.filter((code) => retainedHostErrorCodes.has(code)))],
    truncated: observation.truncated,
  };
}

function sanitizeHostFieldPath(path) {
  return path.replace(/\.([A-Za-z_][A-Za-z0-9_-]{0,63})/g, (_match, key) => {
    if (sensitiveHostFieldKeyPattern.test(key)) return ".redacted";
    return retainedHostFieldKeys.has(key) ? `.${key}` : ".field";
  });
}

function stableToolError(code, extraStructuredContent = {}) {
  return {
    isError: true,
    content: [{ type: "text", text: code }],
    structuredContent: { accepted: 0, ...extraStructuredContent, error: { code } },
  };
}

function toolError(error, code = error?.code) {
  const stableCode = isStableToolErrorCode(code) ? code : "image_task_failed";
  const message = stableToolErrorMessages.get(stableCode);
  return {
    isError: true,
    content: [{ type: "text", text: `${stableCode}: ${message}` }],
  };
}

function readAnnotations() {
  return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
}

function writeAnnotations() {
  return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
}
