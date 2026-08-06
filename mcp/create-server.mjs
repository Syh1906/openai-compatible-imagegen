import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  createRuntimeObservation,
  MAX_RUNTIME_ROOT_ENTRIES,
  MAX_RUNTIME_ROOT_SCHEME_LENGTH,
} from "./runtime-diagnostics.mjs";
const imageIdSchema = z.string().regex(/^img_[0-9A-HJKMNP-TV-Z]{26}$/).describe("项目产物仓库中的稳定图片 ID");
const editorSessionIdSchema = z.string().regex(/^eds_[0-9a-f]{32}$/).describe("已打开画布的会话 ID");
const normalizedCoordinate = z.number().min(0).max(1);
const normalizedPoint = z.object({ x: normalizedCoordinate, y: normalizedCoordinate });
const annotationStyleSchema = {
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  strokeWidth: z.number().min(1).max(12).optional(),
};
const annotationItemSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1), type: z.literal("pen"), points: z.array(normalizedPoint).min(2), text: z.string().max(600).optional(), ...annotationStyleSchema }),
  z.object({ id: z.string().min(1), type: z.literal("arrow"), from: normalizedPoint, to: normalizedPoint, text: z.string().max(600).optional(), ...annotationStyleSchema }),
  z.object({ id: z.string().min(1), type: z.literal("rectangle"), x: normalizedCoordinate, y: normalizedCoordinate, width: normalizedCoordinate, height: normalizedCoordinate, text: z.string().max(600).optional(), ...annotationStyleSchema }),
  z.object({ id: z.string().min(1), type: z.literal("text"), x: normalizedCoordinate, y: normalizedCoordinate, text: z.string().min(1).max(600), ...annotationStyleSchema }),
  z.object({ id: z.string().min(1), type: z.literal("mask"), points: z.array(normalizedPoint).min(2), text: z.string().max(600).optional(), ...annotationStyleSchema }),
]);
const annotationIdSchema = z.string().regex(/^ann_[0-9A-HJKMNP-TV-Z]{26}$/);
const outputSchema = {
  size: z.string().optional(),
  quality: z.enum(["auto", "low", "medium", "high"]).optional(),
  format: z.enum(["png", "jpeg", "webp"]).optional(),
  count: z.number().int().min(1).max(10).optional(),
  background: z.enum(["auto", "opaque", "transparent"]).optional(),
};
const imageArtifactOutputSchema = z.object({
  id: imageIdSchema,
  parentIds: z.array(imageIdSchema),
  childIds: z.array(imageIdSchema),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  provider: z.string().min(1),
  model: z.string().min(1),
  operation: z.enum(["generate", "edit"]),
  prompt: z.string(),
  parameters: z.record(z.unknown()),
  annotationId: annotationIdSchema.nullable(),
  createdAt: z.string().datetime(),
}).strict();
const imageArtifactsOutputSchema = z.object({
  artifacts: z.array(imageArtifactOutputSchema).min(1).max(10),
  artifact: imageArtifactOutputSchema.optional(),
}).strict();
const imageModelOutputSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  capabilities: z.record(z.unknown()),
}).strict();
const editorSessionOutputSchema = z.object({
  id: editorSessionIdSchema,
  imageId: imageIdSchema.optional(),
  status: z.enum(["active", "destroyed", "released"]),
}).strict();
const openEditorSessionOutputSchema = z.object({
  id: editorSessionIdSchema,
  imageId: imageIdSchema,
  status: z.literal("active"),
}).strict();
const annotationOutputSchema = z.object({
  id: annotationIdSchema,
  imageId: imageIdSchema,
  itemCount: z.number().int().min(1).max(100),
  previewMimeType: z.literal("image/svg+xml"),
  hasMask: z.boolean(),
  maskMimeType: z.literal("image/png").nullable(),
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
  projectRootFingerprint: fingerprintSchema,
  cwdRelationToPlugin: z.enum(["same", "descendant", "outside"]),
  projectRootRelationToPlugin: z.enum(["same", "descendant", "outside"]),
  projectRootSource: z.string().min(1),
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
const hostFieldPathSchema = z.string().max(512).regex(/^\$(?:(?:\.[A-Za-z_][A-Za-z0-9_-]{0,63})|(?:\[(?:[0-9]|[12][0-9]|3[01])\])){0,8}$/);
const stableErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
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
const stableToolErrorMessages = new Map([
  ["annotation_image_mismatch", "标注与父图片不匹配。"],
  ["annotation_not_found", "未找到指定标注。"],
  ["annotation_save_failed", "保存图片标注失败。"],
  ["artifact_not_found", "未找到指定图片产物。"],
  ["artifact_read_failed", "读取图片产物失败。"],
  ["editor_session_not_found", "画布会话不存在或已经释放。"],
  ["image_canvas_destroyed", "当前图片的画布已经销毁。"],
  ["image_task_failed", "图片任务执行失败。"],
  ["invalid_json", "图片运行时输入不是有效 JSON。"],
  ["invalid_task", "图片任务参数无效。"],
  ["unsupported_capability", "当前图片模型不支持请求的能力。"],
  ["unsupported_model_profile", "当前图片模型配置不受支持。"],
  ["v2_config_missing", "V2 配置缺失。请创建用户配置或项目配置。"],
]);
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
  "artifact_result_invalid",
  "artifact_server_error",
  "artifact_tool_call_failed",
  "release_identity_mismatch",
  "roots_list_failed",
  "tools_call_rejected",
]);
const sensitiveHostFieldKeyPattern = /(api[_-]?key|authorization|credential|password|secret|token|cookie)/i;
const hostObservationShape = {
  fields: z.array(hostFieldSchema).max(256),
  errorCodes: z.array(stableErrorCodeSchema).max(32),
  truncated: z.boolean(),
};
const hostObservationOutputSchema = z.object({
  source: z.enum(["ui/notifications/tool-result", "tools/call"]),
  ...hostObservationShape,
}).strict();
const hostObservationProvenance = "unverified_widget_report";
const maxHostObservationReportSlots = 8;
const hostObservationScopeSchema = z.enum(["mcp_session_latest", "server_process_latest"]);
const hostObservationReportOutputSchema = z.object({
  provenance: z.literal(hostObservationProvenance),
  scope: hostObservationScopeSchema,
  observations: z.array(hostObservationOutputSchema).max(2),
}).strict().nullable();
const hostObservationInputSchema = z.tuple([
  z.object({ source: z.literal("ui/notifications/tool-result"), ...hostObservationShape }).strict(),
  z.object({ source: z.literal("tools/call"), ...hostObservationShape }).strict(),
]);

export function createImagegenServer({ releaseIdentity, launchContext, readWidgetHtml, runTask, readArtifact, readAnnotation, saveAnnotations }) {
  requireReleaseIdentity(releaseIdentity);
  requireLaunchContext(launchContext);
  const { result: resultWidgetUri, editor: editorWidgetUri } = releaseIdentity.resourceUris;
  const server = new McpServer({
    name: releaseIdentity.pluginId,
    version: releaseIdentity.pluginVersion,
  });
  const editorSessions = new Map();
  const destroyedCanvasImageIds = new Set();
  const hostObservationReports = new Map();

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

  server.registerTool(
    "inspect_imagegen_runtime",
    {
      title: "检查图片运行环境",
      description: "返回当前 MCP server、启动根关系和客户端 roots 能力的脱敏诊断信息，不返回本机路径或 root URI。",
      inputSchema: {},
      outputSchema: {
        hostObservationReport: hostObservationReportOutputSchema,
        releaseIdentity: releaseIdentityOutputSchema,
        runtime: runtimeObservationOutputSchema,
      },
      annotations: readAnnotations(),
    },
    async (_arguments, extra) => {
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
      const runtime = createRuntimeObservation({
        ...launchContext,
        clientVersion: server.server.getClientVersion(),
        clientCapabilities,
        rootsSupported,
        roots,
        rootsErrorCode,
      });
      const hostObservationReport = hostObservationReports.get(getHostObservationScope(extra).key) ?? null;
      return {
        content: [{ type: "text", text: "已读取图片 MCP 的脱敏运行环境。" }],
        structuredContent: { hostObservationReport, releaseIdentity, runtime },
        _meta: { releaseIdentity },
      };
    },
  );

  server.registerTool(
    "report_imagegen_host_observation",
    {
      title: "记录图片工作台宿主形状",
      description: "记录当前发布版本下两类标准宿主结果的脱敏结构。该报告只能标记为未验证的 widget 上报，不是宿主来源证明；不记录图片、文本值、本机路径或客户端身份。",
      inputSchema: {
        releaseFingerprint: fingerprintSchema,
        observations: hostObservationInputSchema,
      },
      outputSchema: {
        accepted: z.number().int().min(0).max(2),
        provenance: z.literal(hostObservationProvenance),
        scope: hostObservationScopeSchema,
        error: z.object({ code: stableErrorCodeSchema }).strict().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ releaseFingerprint, observations }, extra) => {
      if (releaseFingerprint !== releaseIdentity.fingerprint) {
        return stableToolError("release_identity_mismatch", {
          provenance: hostObservationProvenance,
          scope: getHostObservationScope(extra).label,
        });
      }
      const scope = getHostObservationScope(extra);
      const copiedObservations = observations.map(copyHostObservation);
      retainLatestHostObservationReport(hostObservationReports, scope.key, {
        provenance: hostObservationProvenance,
        scope: scope.label,
        observations: copiedObservations,
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
  );

  server.registerTool(
    "list_image_models",
    {
      title: "读取图片模型",
      description: "返回当前 V2 配置中可用的图片模型及安全能力声明。",
      inputSchema: {},
      outputSchema: z.object({ models: z.array(imageModelOutputSchema) }).strict(),
      annotations: readAnnotations(),
    },
    async () => {
      try {
        const result = await runTask({ operation: "list_models", modelProfileId: "primary/gpt-image-2" });
        if (!result?.ok) return toolError(new Error(result?.error?.message || "model catalog unavailable"), result?.error?.code);
        return {
          content: [{ type: "text", text: `已读取 ${result.models.length} 个图片模型。` }],
          structuredContent: { models: result.models },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "generate_image",
    {
      title: "生成图片",
      description: "使用已配置的 gpt-image-2 生成一张或多张独立候选图片。",
      inputSchema: {
        prompt: z.string().min(1),
        modelProfileId: z.literal("primary/gpt-image-2").optional(),
        ...outputSchema,
      },
      outputSchema: imageArtifactsOutputSchema,
      annotations: writeAnnotations(),
    },
    async ({ prompt, modelProfileId = "primary/gpt-image-2", ...output }) =>
      await executeImageTask(
        { operation: "generate", modelProfileId, prompt, inputArtifactIds: [], annotationId: null, output },
        runTask,
        readArtifact,
      ),
  );

  server.registerTool(
    "edit_image",
    {
      title: "编辑图片",
      description: "基于父图片和提示创建新的不可变图片版本。",
      inputSchema: {
        parentImageId: imageIdSchema,
        prompt: z.string().min(1),
        referenceImageIds: z.array(imageIdSchema).optional(),
        annotationId: z.string().min(1).optional(),
        modelProfileId: z.literal("primary/gpt-image-2").optional(),
        ...outputSchema,
      },
      outputSchema: imageArtifactsOutputSchema,
      annotations: writeAnnotations(),
    },
    async ({ parentImageId, referenceImageIds = [], annotationId = null, prompt, modelProfileId = "primary/gpt-image-2", ...output }) => {
      let annotation = null;
      if (annotationId) {
        try {
          annotation = await readAnnotation(annotationId);
        } catch (error) {
          return toolError(error, "annotation_not_found");
        }
        if (annotation.imageId !== parentImageId) {
          return toolError(new Error("标注不属于当前父图片"), "annotation_image_mismatch");
        }
      }
      return await executeImageTask(
        {
          operation: "edit",
          modelProfileId,
          prompt,
          inputArtifactIds: [parentImageId, ...referenceImageIds],
          annotationId,
          ...(annotation?.maskPath ? { mask: annotation.maskPath } : {}),
          output,
        },
        runTask,
        readArtifact,
      );
    },
  );

  server.registerTool(
    "get_image_artifact",
    {
      title: "读取图片产物",
      description: "按稳定图片 ID 读取图片内容、安全元数据和当前画布可用状态。",
      inputSchema: { imageId: imageIdSchema },
      outputSchema: z.object({
        artifact: imageArtifactOutputSchema,
        canvasStatus: z.enum(["available", "destroyed"]),
      }).strict(),
      annotations: readAnnotations(),
    },
    async ({ imageId }) => {
      try {
        const artifact = await readArtifact(imageId);
        return {
          content: [imageContent(artifact), { type: "text", text: `已读取图片 ${imageId}。` }],
          structuredContent: {
            artifact: imageArtifactMetadata(artifact.metadata),
            canvasStatus: destroyedCanvasImageIds.has(imageId) ? "destroyed" : "available",
          },
          _meta: { imageId },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "read_image_artifact_data",
    {
      title: "读取工作台图片数据",
      description: "供图片工作台按稳定图片 ID 读取图片像素数据。该工具只对 app/widget 可见。",
      inputSchema: { imageId: imageIdSchema },
      outputSchema: z.object({
        id: imageIdSchema,
        mimeType: z.string().regex(/^image\/(png|jpeg|webp)$/),
      }).strict(),
      annotations: readAnnotations(),
      _meta: {
        ui: { visibility: ["app"] },
        "openai/widgetAccessible": true,
      },
    },
    async ({ imageId }) => {
      try {
        const artifact = await readArtifact(imageId);
        return {
          content: [{ type: "text", text: `已为图片工作台读取图片 ${imageId}。` }],
          structuredContent: {
            id: artifact.metadata.id,
            mimeType: artifact.metadata.mimeType,
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
        return toolError(error, "artifact_read_failed");
      }
    },
  );

  server.registerTool(
    "render_image_results",
    {
      title: "显示图片结果",
      description: "在一个会话结果容器中按顺序显示一张或多张已创建图片，并为每张图片提供独立画布入口。生成或编辑成功后只调用一次。",
      inputSchema: { imageIds: z.array(imageIdSchema).min(1).max(10) },
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
    async ({ imageIds }) => {
      try {
        const records = await Promise.all(imageIds.map((imageId) => readArtifact(imageId)));
        const artifacts = records.map(({ metadata }) => ({
          ...imageArtifactMetadata(metadata),
          canvasStatus: destroyedCanvasImageIds.has(metadata.id) ? "destroyed" : "available",
        }));
        return {
          content: [
            ...records.map((record) => imageContent(record)),
            { type: "text", text: `正在显示 ${imageIds.length} 张图片。` },
          ],
          structuredContent: { imageIds, artifacts },
          _meta: {
            ui: { resourceUri: resultWidgetUri },
            releaseIdentity,
            imageIds,
          },
        };
      } catch (error) {
        return toolError(error, "artifact_read_failed");
      }
    },
  );

  server.registerTool(
    "open_image_editor",
    {
      title: "打开图片画布",
      description: "按稳定图片 ID 打开对应的聚焦图片画布；已显式销毁的图片画布在当前 MCP server 生命周期内不能再次打开。",
      inputSchema: { imageId: imageIdSchema },
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
    async ({ imageId }) => {
      try {
        const artifact = await readArtifact(imageId);
        if (destroyedCanvasImageIds.has(imageId)) {
          return toolError(new Error("当前图片的画布已经销毁"), "image_canvas_destroyed");
        }
        const editorSession = {
          id: `eds_${randomUUID().replaceAll("-", "")}`,
          imageId,
          status: "active",
        };
        editorSessions.set(editorSession.id, editorSession);
        return {
          content: [{ type: "text", text: `已打开图片 ${imageId} 的聚焦画布，画布会话 ID 为 ${editorSession.id}。` }],
          structuredContent: { editorSession, artifact: imageArtifactMetadata(artifact.metadata) },
          _meta: {
            ui: { resourceUri: editorWidgetUri },
            releaseIdentity,
            imageId,
            editorSessionId: editorSession.id,
          },
        };
      } catch (error) {
        return toolError(error, "artifact_not_found");
      }
    },
  );

  server.registerTool(
    "save_image_annotations",
    {
      title: "保存图片标注",
      description: "一次保存当前图片上的多条独立归一化标注，并返回稳定标注 ID。",
      inputSchema: {
        imageId: imageIdSchema,
        items: z.array(annotationItemSchema).min(1).max(100),
      },
      outputSchema: z.object({ annotation: annotationOutputSchema }).strict(),
      annotations: writeAnnotations(),
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ imageId, items }) => {
      try {
        await readArtifact(imageId);
        const annotation = await saveAnnotations({ imageId, items });
        return {
          content: [{ type: "text", text: `已保存图片 ${imageId} 的 ${annotation.itemCount} 条标注。` }],
          structuredContent: { annotation },
        };
      } catch (error) {
        return toolError(error, "annotation_save_failed");
      }
    },
  );

  server.registerTool(
    "get_image_editor_session",
    {
      title: "读取画布会话状态",
      description: "供图片画布检查自身是否仍处于活动状态。",
      inputSchema: { editorSessionId: editorSessionIdSchema },
      outputSchema: z.object({ editorSession: editorSessionOutputSchema }).strict(),
      annotations: readAnnotations(),
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ editorSessionId }) => editorSessionResult(editorSessions.get(editorSessionId)),
  );

  server.registerTool(
    "destroy_image_editor",
    {
      title: "销毁图片画布",
      description: "结束并释放指定图片的全部活动画布会话，并终止当前 MCP server 生命周期内的重新打开入口。仅在用户明确要求销毁，或任务已明确转移且当前图片不再需要继续查看、标注或修改时调用；普通隐藏、关闭右栏或暂时讨论其他内容时不要调用。",
      inputSchema: { editorSessionId: editorSessionIdSchema },
      outputSchema: z.object({ editorSession: editorSessionOutputSchema }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ editorSessionId }) => {
      const editorSession = editorSessions.get(editorSessionId);
      if (!editorSession) return editorSessionResult({ id: editorSessionId }, "released");
      destroyedCanvasImageIds.add(editorSession.imageId);
      for (const session of editorSessions.values()) {
        if (session.imageId === editorSession.imageId) session.status = "destroyed";
      }
      return editorSessionResult(editorSession);
    },
  );

  server.registerTool(
    "finalize_image_editor_session",
    {
      title: "释放画布会话状态",
      description: "供图片画布在宿主卸载前释放自身的临时会话状态。",
      inputSchema: { editorSessionId: editorSessionIdSchema },
      outputSchema: z.object({ editorSession: editorSessionOutputSchema }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ editorSessionId }) => {
      const editorSession = editorSessions.get(editorSessionId);
      editorSessions.delete(editorSessionId);
      return editorSessionResult(editorSession || { id: editorSessionId }, "released");
    },
  );

  return server;
}

function editorSessionResult(editorSession, status = editorSession?.status) {
  if (!editorSession) return toolError(new Error("画布会话不存在或已经释放"), "editor_session_not_found");
  const result = { ...editorSession, status };
  return {
    content: [{ type: "text", text: `画布会话 ${result.id} 当前状态为 ${result.status}。` }],
    structuredContent: { editorSession: result },
  };
}

async function executeImageTask(task, runTask, readArtifact) {
  try {
    const result = await runTask(task);
    if (!result?.ok) {
      return toolError(new Error(result?.error?.message || "image task failed"), result?.error?.code);
    }
    const artifacts = await Promise.all(result.artifacts.map((item) => readArtifact(item.id)));
    const artifactMetadata = artifacts.map(({ metadata: item }) => imageArtifactMetadata(item));
    const structuredContent = { artifacts: artifactMetadata };
    const metadata = artifactMetadata.length === 1 ? artifactMetadata[0] : null;
    if (metadata) structuredContent.artifact = metadata;
    return {
      content: [
        ...artifacts.map(imageContent),
        { type: "text", text: `已创建 ${artifacts.length} 张图片。` },
      ],
      structuredContent,
      _meta: {
        imageIds: result.artifacts.map((item) => item.id),
        artifacts: artifactMetadata,
        ...(metadata ? { imageId: metadata.id } : {}),
      },
    };
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
    || typeof launchContext.projectRoot !== "string"
    || typeof launchContext.projectRootSource !== "string"
  ) {
    throw new Error("launchContext is required to create the MCP server");
  }
}

function imageContent(artifact) {
  return { type: "image", data: artifact.data, mimeType: artifact.metadata.mimeType };
}

function imageArtifactMetadata(metadata) {
  return { ...metadata };
}

function getHostObservationScope(extra) {
  const sessionId = extra?.sessionId;
  if (typeof sessionId === "string" && sessionId.length > 0) {
    return { key: `session:${sessionId}`, label: "mcp_session_latest" };
  }
  return { key: "server-process", label: "server_process_latest" };
}

function retainLatestHostObservationReport(reports, key, report) {
  reports.delete(key);
  reports.set(key, report);
  while (reports.size > maxHostObservationReportSlots) {
    reports.delete(reports.keys().next().value);
  }
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
  const stableCode = stableToolErrorMessages.has(code) ? code : "image_task_failed";
  const message = stableToolErrorMessages.get(stableCode);
  return {
    isError: true,
    content: [{ type: "text", text: `${stableCode}: ${message}` }],
    structuredContent: { error: { code: stableCode, message } },
  };
}

function readAnnotations() {
  return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
}

function writeAnnotations() {
  return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
}
