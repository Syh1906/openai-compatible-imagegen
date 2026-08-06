import { serializeSubmission } from "./editor-state.mjs";
import { labelFor, summaryFor } from "./editor-annotation-view.mjs";
import { rasterizeSvgPreview } from "./preview-rasterizer.mjs";


export class SubmissionError extends Error {
  constructor(stage, cause) {
    super(cause?.message || "submission failed", { cause });
    this.name = "SubmissionError";
    this.stage = stage;
  }
}

export function createSubmissionCoordinator({
  app,
  rasterizePreview = rasterizeSvgPreview,
  createSubmissionId = defaultSubmissionId,
  contextTimeoutMs = 750,
}) {
  let savedSubmission = null;

  return {
    reset() {
      savedSubmission = null;
    },

    async submit(editor, onProgress = () => {}) {
      const payload = serializeSubmission(editor, editor.prompt);
      let stage = "preview";
      try {
        onProgress(stage);
        const messagePreview = await rasterizePreview(payload.preview.data, {
          width: editor.image.width,
          height: editor.image.height,
        });
        const text = buildSubmissionText(payload);
        const submissionKey = JSON.stringify({ imageId: payload.imageId, items: payload.items, prompt: payload.prompt });
        let submission = savedSubmission?.key === submissionKey ? savedSubmission : null;
        let annotationId = submission?.annotationId || null;

        stage = "annotations";
        onProgress(stage);
        if (payload.annotations.length && !annotationId) {
          const result = await app.callServerTool({
            name: "save_image_annotations",
            arguments: { imageId: payload.imageId, items: payload.items },
          });
          if (result.isError || !result.structuredContent?.annotation?.id) {
            throw new Error("annotation save failed");
          }
          annotationId = result.structuredContent.annotation.id;
        }

        submission ||= {
          key: submissionKey,
          annotationId,
          submissionId: createSubmissionId(),
          contextPublished: false,
        };
        savedSubmission = submission;
        const modelContext = {
          submissionId: submission.submissionId,
          imageId: payload.imageId,
          parentImageId: payload.parentImageId,
          annotationId,
          prompt: payload.prompt,
          annotationCount: payload.annotations.length,
          intents: text.intentLines,
          requestText: text.requestText,
        };

        stage = "context";
        onProgress(stage);
        if (!submission.contextPublished) {
          try {
            await withRequestTimeout(app.updateModelContext({
              content: [
                { type: "text", text: text.requestText },
                { type: "image", mimeType: messagePreview.mimeType, data: messagePreview.data },
              ],
              structuredContent: modelContext,
            }), contextTimeoutMs);
          } catch (error) {
            if (error?.code !== -32001) throw error;
          }
          submission.contextPublished = true;
        }

        stage = "message";
        onProgress(stage);
        const conversationText = buildConversationText(text.requestText, {
          submissionId: submission.submissionId,
          imageId: payload.imageId,
          parentImageId: payload.parentImageId,
          annotationId,
        });
        const messageResult = await app.sendMessage({
          role: "user",
          content: [{ type: "text", text: conversationText }],
        });
        if (messageResult?.isError) throw new Error("host rejected the conversation message");

        return {
          annotationId,
          submissionId: submission.submissionId,
          requestText: text.requestText,
        };
      } catch (error) {
        throw error instanceof SubmissionError ? error : new SubmissionError(stage, error);
      }
    },
  };
}

export function buildSubmissionText(payload) {
  const intentLines = payload.annotations.map(
    (item, index) => `${index + 1}. ${labelFor(item.type)}：${item.text || summaryFor(item.type)}`,
  );
  const requestText = [
    payload.annotations.length
      ? `请基于图片 ${payload.imageId} 的 ${payload.annotations.length} 处标注进行图改图。`
      : `请基于图片 ${payload.imageId} 进行图改图。`,
    ...(intentLines.length ? ["修改意图：", ...intentLines] : []),
    ...(payload.prompt ? [`补充要求：${payload.prompt}`] : []),
  ].join("\n");
  return { intentLines, requestText };
}

export function withRequestTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("MCP request timed out");
      error.code = -32001;
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function buildConversationText(requestText, submission) {
  return [
    requestText,
    "机器路由信息：",
    `提交 ID：${submission.submissionId}`,
    `图片 ID：${submission.imageId}`,
    `父图片 ID：${submission.parentImageId || submission.imageId}`,
    `标注 ID：${submission.annotationId || "无"}`,
  ].join("\n");
}

function defaultSubmissionId() {
  return `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
