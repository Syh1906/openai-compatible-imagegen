import { serializeSubmission } from "./editor-state.mjs";
import { isUserFacingAnnotation, labelFor, summaryFor } from "./editor-annotation-view.mjs";
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
  contextTimeoutMs = 750,
  isActive = () => true,
}) {
  if (typeof isActive !== "function") {
    throw new TypeError("isActive must be a function");
  }
  let savedSubmission = null;
  let activeSubmission = null;
  let unsettledContext = null;

  return {
    reset() {
      savedSubmission = null;
    },

    async submit(editor, onProgress = () => {}) {
      assertActive(isActive);
      const payload = serializeSubmission(editor, editor.prompt);
      let delivery;
      try {
        delivery = resolveDelivery(app.getHostCapabilities?.());
      } catch (error) {
        throw new SubmissionError("capabilities", error);
      }
      const submissionKey = JSON.stringify({ imageId: payload.imageId, items: payload.items, prompt: payload.prompt, delivery });
      if (activeSubmission) {
        if (activeSubmission.key === submissionKey) return activeSubmission.promise;
        throw new SubmissionError("busy", new Error("another submission is already in progress"));
      }
      if (
        unsettledContext
        && (
          unsettledContext.key !== submissionKey
          || savedSubmission?.key !== submissionKey
        )
      ) {
        throw new SubmissionError("busy", new Error("the previous context request is still in progress"));
      }
      if (
        savedSubmission?.contextRequest
        && !savedSubmission.contextPublished
        && savedSubmission.key !== submissionKey
      ) {
        throw new SubmissionError("busy", new Error("the previous context request is still in progress"));
      }

      const operation = Promise.resolve().then(async () => {
        let stage = "preview";
        try {
          onProgress(stage);
          const messagePreview = await rasterizePreview(payload.preview.data, {
            width: editor.image.width,
            height: editor.image.height,
          });
          assertActive(isActive);
          const text = buildSubmissionText(payload);
          let submission = savedSubmission?.key === submissionKey ? savedSubmission : null;
          let annotationId = submission?.annotationId || null;

          stage = "prepare";
          onProgress(stage);
          if (!submission) {
            const result = await app.callServerTool({
              name: "prepare_image_edit_submission",
              arguments: {
                parentImageId: payload.imageId,
                items: payload.items,
                sourcePrompt: payload.prompt,
              },
            });
            assertActive(isActive);
            const prepared = validatePreparedSubmission(result, payload);
            annotationId = prepared.annotation?.id || null;
            submission = {
              key: submissionKey,
              annotationId,
              submissionId: prepared.submission.id,
              revisionSha256: prepared.submission.revisionSha256,
              snapshot: submissionSnapshot(payload),
              contextPublished: false,
              contextAcknowledged: false,
              contextRequest: null,
            };
          }

          savedSubmission = submission;
          const modelContext = {
            submissionId: submission.submissionId,
            imageId: payload.imageId,
            parentImageId: payload.parentImageId,
            annotationId,
            prompt: payload.prompt,
            annotationCount: text.annotationCount,
            intents: text.intentLines,
            requestText: text.requestText,
          };
          const conversationText = buildConversationText(text.requestText, {
            submissionId: submission.submissionId,
            imageId: payload.imageId,
            parentImageId: payload.parentImageId,
            annotationId,
          });
          const conversationContent = [
            { type: "text", text: conversationText },
            { type: "image", mimeType: messagePreview.mimeType, data: messagePreview.data },
          ];

          stage = "context";
          onProgress(stage);
          if (!submission.contextPublished) {
            if (!submission.contextRequest) {
              assertActive(isActive);
              const contextRequest = trackContextRequest(
                submission,
                app.updateModelContext({
                  ...(delivery === "composer" ? { content: conversationContent } : {}),
                  structuredContent: modelContext,
                }),
              );
              submission.contextRequest = contextRequest;
              unsettledContext = { key: submissionKey, promise: contextRequest };
              void contextRequest.finally(() => {
                if (unsettledContext?.promise === contextRequest) unsettledContext = null;
              });
            }
            const contextOutcome = submission.contextRequest;
            try {
              const outcome = await withRequestTimeout(contextOutcome, contextTimeoutMs);
              if (!outcome.ok) throw outcome.error;
            } catch (error) {
              if (error?.code !== -32001) throw error;
              if (delivery === "message") submission.contextPublished = true;
            }
            assertActive(isActive);
            submission.lastContextOutcome = contextOutcome;
          }

          if (delivery === "message") {
            stage = "message";
            onProgress(stage);
            assertActive(isActive);
            const messageResult = await app.sendMessage({
              role: "user",
              content: conversationContent,
            });
            assertActive(isActive);
            if (messageResult?.isError) throw new Error("host rejected the conversation message");
          }

          assertActive(isActive);
          return {
            annotationId,
            submissionId: submission.submissionId,
            requestText: text.requestText,
            delivery,
            contextAcknowledged: submission.contextAcknowledged,
            contextOutcome: submission.lastContextOutcome
              || Promise.resolve({ ok: submission.contextAcknowledged }),
            revisionSha256: submission.revisionSha256,
            snapshot: submission.snapshot,
          };
        } catch (error) {
          throw error instanceof SubmissionError ? error : new SubmissionError(stage, error);
        }
      });
      activeSubmission = { key: submissionKey, promise: operation };
      try {
        return await operation;
      } finally {
        if (activeSubmission?.promise === operation) activeSubmission = null;
      }
    },
  };
}

function assertActive(isActive) {
  if (!isActive()) {
    throw new SubmissionError("inactive", new Error("the widget resource is no longer active"));
  }
}

function validatePreparedSubmission(result, payload) {
  const prepared = result?.structuredContent;
  const annotationId = prepared?.annotation?.id || null;
  const receipt = prepared?.submission;
  if (
    result?.isError
    || !receipt
    || typeof receipt.id !== "string"
    || !receipt.id
    || receipt.parentImageId !== payload.imageId
    || (receipt.annotationId || null) !== annotationId
    || (payload.items.length > 0) !== Boolean(annotationId)
    || typeof receipt.revisionSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(receipt.revisionSha256)
  ) {
    throw new Error("edit submission preparation failed");
  }
  return prepared;
}

function submissionSnapshot(payload) {
  return {
    imageId: payload.imageId,
    annotations: payload.annotations.map((item) => ({ ...item })),
    items: payload.items.map((item) => structuredClone(item)),
    prompt: payload.prompt,
    preview: { ...payload.preview },
  };
}

function resolveDelivery(capabilities = {}) {
  if (
    supports(capabilities.message, "text", "image")
    && supports(capabilities.updateModelContext, "structuredContent")
  ) {
    return "message";
  }
  if (supports(capabilities.updateModelContext, "text", "image", "structuredContent")) {
    return "composer";
  }
  throw new Error("host does not support atomic text and image submission");
}

function supports(modalities, ...required) {
  return required.every((name) => Boolean(modalities?.[name]));
}

export function buildSubmissionText(payload) {
  const visibleAnnotations = payload.annotations.filter(isUserFacingAnnotation);
  const intentLines = visibleAnnotations.map(
    (item, index) => `${index + 1}. ${labelFor(item)}：${item.text || summaryFor(item)}`,
  );
  const requestText = [
    visibleAnnotations.length
      ? `请基于图片 ${payload.imageId} 的 ${visibleAnnotations.length} 处标注进行图改图。`
      : `请基于图片 ${payload.imageId} 进行图改图。`,
    ...(intentLines.length ? ["修改意图：", ...intentLines] : []),
    ...(payload.prompt ? [`补充要求：${payload.prompt}`] : []),
  ].join("\n");
  return { annotationCount: visibleAnnotations.length, intentLines, requestText };
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

function trackContextRequest(submission, request) {
  return Promise.resolve(request).then(
    () => {
      submission.contextPublished = true;
      submission.contextAcknowledged = true;
      submission.contextRequest = null;
      return { ok: true };
    },
    (error) => {
      submission.contextRequest = null;
      return { ok: false, error };
    },
  );
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
