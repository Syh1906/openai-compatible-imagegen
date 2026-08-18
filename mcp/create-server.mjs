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
const editorSessionIdSchema = z.string().regex(/^eds_[0-9a-f]{32}$/).describe("Open canvas session ID");
const projectBindingIdSchema = z.string().regex(/^pbind_[0-9a-f]{64}$/).describe("Image project binding ID");
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
    title: "Image results",
    description: "Keep images visible in the conversation result and provide an entry point to the focused canvas in the same host instance.",
    releaseIdentity,
    readWidgetHtml,
  });
  registerWidgetResource(server, {
    name: "image-editor",
    uri: editorWidgetUri,
    title: "Image editing canvas",
    description: "Open a focused canvas bound to a stable image ID from a conversation result.",
    releaseIdentity,
    readWidgetHtml,
  });
  registerWidgetResource(server, {
    name: "image-result-legacy-stable",
    uri: `ui://${releaseIdentity.pluginId}/result.html`,
    title: "Image results",
    description: "Keep images visible in the conversation result and provide an entry point to the focused canvas in the same host instance.",
    releaseIdentity,
    readWidgetHtml,
  });
  registerWidgetResource(server, {
    name: "image-editor-legacy-stable",
    uri: `ui://${releaseIdentity.pluginId}/editor.html`,
    title: "Image editing canvas",
    description: "Open a focused canvas bound to a stable image ID from a conversation result.",
    releaseIdentity,
    readWidgetHtml,
  });
  for (const fingerprint of legacyWidgetResourceFingerprints) {
    registerWidgetResource(server, {
      name: `image-result-legacy-${fingerprint}`,
      uri: `ui://${releaseIdentity.pluginId}/result-${fingerprint}.html`,
      title: "Image results",
      description: "Keep images visible in the conversation result and provide an entry point to the focused canvas in the same host instance.",
      releaseIdentity,
      readWidgetHtml,
    });
    registerWidgetResource(server, {
      name: `image-editor-legacy-${fingerprint}`,
      uri: `ui://${releaseIdentity.pluginId}/editor-${fingerprint}.html`,
      title: "Image editing canvas",
      description: "Open a focused canvas bound to a stable image ID from a conversation result.",
      releaseIdentity,
      readWidgetHtml,
    });
  }

  server.registerTool(
    "bind_imagegen_project",
    {
      title: "Bind image project",
      description: "Bind the current task to an existing absolute project root, protect the resolved artifact directory with a local .gitignore containing only *, and return an image project binding ID for later model and app-only tools across MCP processes. Rebind with the same ID after configuration changes.",
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
      title: "Inspect image runtime",
      description: "Return redacted diagnostics for the MCP server, startup-root relationships, and client roots capability without returning local paths or root URIs.",
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
      title: "Report image host observation",
      description: "Record redacted structure for the two standard host results in the current release. The report remains an unverified widget observation, not proof of host provenance, and excludes images, text values, local paths, and client identity.",
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
      title: "List image models",
      description: "Return image models and safe capability declarations from the current image configuration.",
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
      title: "Generate images",
      description: "Generate one or more independent candidate images with the configured gpt-image-2 model. Multiple candidates run as ordered single-image requests and return only after the full group succeeds.",
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
      title: "Edit image",
      description: "Create a new immutable image version from a parent image and prompt.",
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
      title: "Batch image tasks",
      description: "Run independent generation and standard edit tasks, return ordered per-item results with partial success, and do not display images automatically.",
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
      title: "Get image batch manifest",
      description: "Read an immutable batch manifest by stable batch ID, including per-item originals, delivery receipts, and errors, without displaying images automatically.",
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
      title: "Get image delivery receipt",
      description: "Read immutable derived artifacts and QA summaries by stable delivery receipt ID without displaying images automatically.",
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
      title: "Deliver image",
      description: "Run local exact-size, grid, preview-board, and QA delivery for a stable image ID. Keep the original immutable, store derivatives separately, and do not attach a canvas automatically.",
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
      title: "Get image artifact",
      description: "Read image content, safe metadata, and current canvas availability by stable image ID.",
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
      title: "Read image artifact data",
      description: "Read image pixel data by stable image ID for the image workspace. This tool is visible only to the app/widget.",
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
      title: "Show image in folder",
      description: "Reveal and select the local image file in the system file manager by stable image ID. This workspace-only tool does not return the local path.",
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
      title: "Render image results",
      description: "Display one or more created images in order within one conversation result and provide an independent canvas entry for each image. Call once after generation or editing succeeds.",
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
      title: "Open image editor",
      description: "Open the focused canvas for a stable image ID. A canvas explicitly destroyed in the current project binding cannot be reopened.",
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
      title: "Save image annotations",
      description: "Save multiple independent normalized annotations for the current image and return a stable annotation ID.",
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
      title: "Prepare image edit submission",
      description: "Save the current canvas revision and issue a server submission ID that binds the next edit_image call to the same parent image, annotations, and mask policy.",
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
      title: "Save image editor draft",
      description: "Save unsent annotations and additional instructions before the host unloads the current canvas so the next canvas for the same image can restore them once.",
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
      title: "Get image editor session",
      description: "Let the image canvas check whether its own session is still active.",
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
      title: "Destroy image editor",
      description: "End all active canvas sessions for the selected image in the current project binding and remove its reopen entry point. Call only when the user explicitly requests destruction or the task has moved away and the image no longer needs viewing, annotation, or editing; do not call for ordinary hiding, panel closure, or temporary discussion.",
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
      title: "Finalize image editor session",
      description: "Release the image canvas temporary session state before the host unloads it.",
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
