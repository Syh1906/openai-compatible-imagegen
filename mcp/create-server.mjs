import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";


export const RESULT_WIDGET_URI = "ui://openai-compatible-imagegen-v2/result.html";
export const EDITOR_WIDGET_URI = "ui://openai-compatible-imagegen-v2/editor.html";
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
const outputSchema = {
  size: z.string().optional(),
  quality: z.enum(["auto", "low", "medium", "high"]).optional(),
  format: z.enum(["png", "jpeg", "webp"]).optional(),
  count: z.number().int().min(1).max(10).optional(),
  background: z.enum(["auto", "opaque", "transparent"]).optional(),
};

export function createImagegenServer({ readWidgetHtml, runTask, readArtifact, readAnnotation, saveAnnotations, version = "0.1.0" }) {
  const server = new McpServer({ name: "openai-compatible-imagegen-v2", version });
  const editorSessions = new Map();
  const destroyedCanvasImageIds = new Set();

  registerWidgetResource(server, {
    name: "image-result",
    uri: RESULT_WIDGET_URI,
    title: "图片结果",
    description: "在会话结果中持续显示图片，并提供在同一宿主实例展开聚焦画布的入口。",
    readWidgetHtml,
  });
  registerWidgetResource(server, {
    name: "image-editor",
    uri: EDITOR_WIDGET_URI,
    title: "图片编辑画布",
    description: "为会话图片结果展开与稳定图片 ID 绑定的聚焦画布。",
    readWidgetHtml,
  });

  server.registerTool(
    "list_image_models",
    {
      title: "读取图片模型",
      description: "返回当前 V2 配置中可用的图片模型及安全能力声明。",
      inputSchema: {},
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
      outputSchema: {
        id: imageIdSchema,
        mimeType: z.string().regex(/^image\/(png|jpeg|webp)$/),
      },
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
      annotations: readAnnotations(),
      _meta: { ui: { resourceUri: RESULT_WIDGET_URI } },
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
            ui: { resourceUri: RESULT_WIDGET_URI },
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: EDITOR_WIDGET_URI, visibility: ["app"] } },
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
          _meta: { ui: { resourceUri: EDITOR_WIDGET_URI }, imageId, editorSessionId: editorSession.id },
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

function registerWidgetResource(server, { name, uri, title, description, readWidgetHtml }) {
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

function imageContent(artifact) {
  return { type: "image", data: artifact.data, mimeType: artifact.metadata.mimeType };
}

function imageArtifactMetadata(metadata) {
  return { ...metadata };
}

function toolError(error, code = "image_task_failed") {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } },
  };
}

function readAnnotations() {
  return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
}

function writeAnnotations() {
  return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
}
