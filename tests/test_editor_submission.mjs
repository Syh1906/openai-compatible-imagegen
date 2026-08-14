import assert from "node:assert/strict";
import test from "node:test";

import { buildSubmissionText, createSubmissionCoordinator } from "../web/editor-submission.mjs";


function editorState() {
  return {
    image: {
      id: "img_01J00000000000000000000000",
      parentIds: [],
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      data: "image-data",
    },
    annotations: [{
      id: "annotation_1",
      type: "arrow",
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
      from: { x: 0.1, y: 0.2 },
      to: { x: 0.4, y: 0.6 },
      points: [],
      text: "提亮这里",
      color: "#ef4444",
      strokeWidth: 5,
    }],
    prompt: "保持其余区域不变",
  };
}

function preparedResponse({ annotationId = "ann_01", submissionId = "sub_01" } = {}) {
  return {
    structuredContent: {
      annotation: annotationId ? { id: annotationId } : null,
      submission: {
        id: submissionId,
        parentImageId: editorState().image.id,
        annotationId,
        revisionSha256: "a".repeat(64),
      },
    },
  };
}

test("submission text keeps edit and protect mask intent explicit", () => {
  const result = buildSubmissionText({
    imageId: editorState().image.id,
    annotations: [
      { type: "mask", mode: "edit", text: "" },
      { type: "mask", mode: "protect", text: "" },
    ],
    prompt: "",
  });

  assert.deepEqual(result.intentLines, [
    "1. 改图区域：只允许模型修改该区域",
    "2. 保护内容：保留该内容的身份、形状、文字和纹理，允许光影自然适配",
  ]);
  assert.match(result.requestText, /1\. 改图区域：只允许模型修改该区域/);
  assert.match(result.requestText, /2\. 保护内容：保留该内容的身份、形状、文字和纹理，允许光影自然适配/);
});

test("mask erase strokes stay in the payload but do not become a user intent", () => {
  const result = buildSubmissionText({
    imageId: editorState().image.id,
    annotations: [
      { type: "mask", mode: "edit", operation: "paint", text: "" },
      { type: "mask", mode: "edit", operation: "erase", text: "" },
    ],
    prompt: "",
  });

  assert.equal(result.annotationCount, 1);
  assert.deepEqual(result.intentLines, ["1. 改图区域：只允许模型修改该区域"]);
  assert.match(result.requestText, /1 处标注/);
  assert.doesNotMatch(result.requestText, /擦除/);
});

test("submission coordinator publishes the transaction in strict order", async () => {
  const calls = [];
  const app = {
    getHostCapabilities() {
      return {
        message: { text: {}, image: {} },
        updateModelContext: { structuredContent: {} },
      };
    },
    async callServerTool(request) {
      calls.push(request.name);
      return preparedResponse();
    },
    async updateModelContext(request) {
      calls.push("context");
      assert.equal(request.structuredContent.annotationId, "ann_01");
      assert.equal(request.content, undefined);
      return {};
    },
    async sendMessage(request) {
      calls.push("message");
      assert.deepEqual(request.content.map((item) => item.type), ["text", "image"]);
      assert.equal(request.content[1].mimeType, "image/png");
      assert.equal(request.content[1].data, "preview-data");
      return {};
    },
  };
  const coordinator = createSubmissionCoordinator({
    app,
    createSubmissionId: () => "sub_01",
    rasterizePreview: async () => {
      calls.push("preview");
      return { mimeType: "image/png", data: "preview-data" };
    },
  });

  const result = await coordinator.submit(editorState());

  assert.deepEqual(calls, ["preview", "prepare_image_edit_submission", "context", "message"]);
  assert.equal(result.annotationId, "ann_01");
  assert.equal(result.submissionId, "sub_01");
  assert.match(result.requestText, /1\. 箭头指引：提亮这里/);
});

test("submission coordinator uses the server-issued edit revision", async () => {
  const calls = [];
  const serverSubmissionId = "sub_0123456789abcdef0123456789abcdef";
  const app = {
    getHostCapabilities() {
      return {
        message: {},
        updateModelContext: { text: {}, image: {}, structuredContent: {} },
      };
    },
    async callServerTool(request) {
      calls.push(request);
      return {
        structuredContent: {
          annotation: { id: "ann_01" },
          submission: {
            id: serverSubmissionId,
            parentImageId: editorState().image.id,
            annotationId: "ann_01",
            revisionSha256: "a".repeat(64),
          },
        },
      };
    },
    async updateModelContext(request) {
      assert.equal(request.structuredContent.submissionId, serverSubmissionId);
      assert.match(request.content[0].text, new RegExp(serverSubmissionId));
      return {};
    },
  };
  const coordinator = createSubmissionCoordinator({
    app,
    createSubmissionId: () => "sub_local_must_not_be_used",
    rasterizePreview: async () => ({ mimeType: "image/png", data: "preview-data" }),
  });

  const result = await coordinator.submit(editorState());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "prepare_image_edit_submission");
  assert.deepEqual(calls[0].arguments, {
    parentImageId: editorState().image.id,
    items: result.snapshot.items,
    sourcePrompt: editorState().prompt,
  });
  assert.equal(result.submissionId, serverSubmissionId);
  assert.equal(result.revisionSha256, "a".repeat(64));
  assert.equal(result.snapshot.prompt, editorState().prompt);
});

test("automatic message delivery remains complete when context acknowledgement is delayed", async () => {
  const counts = { save: 0, context: 0, message: 0 };
  let acknowledgeContext;
  const contextRequest = new Promise((resolve) => {
    acknowledgeContext = resolve;
  });
  const app = {
    getHostCapabilities() {
      return {
        message: { text: {}, image: {} },
        updateModelContext: { structuredContent: {} },
      };
    },
    async callServerTool() {
      counts.save += 1;
      return preparedResponse();
    },
    async updateModelContext() {
      counts.context += 1;
      return contextRequest;
    },
    async sendMessage(request) {
      counts.message += 1;
      assert.deepEqual(request.content.map((item) => item.type), ["text", "image"]);
      return {};
    },
  };
  const coordinator = createSubmissionCoordinator({
    app,
    contextTimeoutMs: 1,
    createSubmissionId: () => "sub_01",
    rasterizePreview: async () => ({ mimeType: "image/png", data: "preview-data" }),
  });

  const result = await coordinator.submit(editorState());
  acknowledgeContext({});
  assert.deepEqual(await result.contextOutcome, { ok: true });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.delivery, "message");
  assert.equal(result.contextAcknowledged, false);
  assert.deepEqual(counts, { save: 1, context: 1, message: 1 });
});

test("current Codex host stages one atomic text and image composer payload", async () => {
  const calls = [];
  const app = {
    getHostCapabilities() {
      return {
        message: {},
        updateModelContext: { text: {}, image: {}, structuredContent: {} },
      };
    },
    async callServerTool(request) {
      calls.push(request.name);
      return preparedResponse();
    },
    async updateModelContext(request) {
      calls.push("context");
      assert.deepEqual(request.content.map((item) => item.type), ["text", "image"]);
      assert.match(request.content[0].text, /提交 ID：sub_01/);
      assert.equal(request.content[1].mimeType, "image/png");
      assert.equal(request.content[1].data, "preview-data");
      assert.equal(request.structuredContent.annotationId, "ann_01");
      return {};
    },
    async sendMessage() {
      calls.push("message");
      throw new Error("the current Codex host must not split this payload through ui/message");
    },
  };
  const coordinator = createSubmissionCoordinator({
    app,
    createSubmissionId: () => "sub_01",
    rasterizePreview: async () => {
      calls.push("preview");
      return { mimeType: "image/png", data: "preview-data" };
    },
  });

  const result = await coordinator.submit(editorState());

  assert.deepEqual(calls, ["preview", "prepare_image_edit_submission", "context"]);
  assert.equal(result.delivery, "composer");
  assert.equal(result.contextAcknowledged, true);
});

test("concurrent calls for one submission share the same transaction", async () => {
  const counts = { preview: 0, save: 0, context: 0, message: 0 };
  const app = {
    getHostCapabilities() {
      return {
        message: { text: {}, image: {} },
        updateModelContext: { structuredContent: {} },
      };
    },
    async callServerTool() {
      counts.save += 1;
      return preparedResponse();
    },
    async updateModelContext() {
      counts.context += 1;
      return {};
    },
    async sendMessage() {
      counts.message += 1;
      return {};
    },
  };
  const coordinator = createSubmissionCoordinator({
    app,
    createSubmissionId: () => "sub_01",
    rasterizePreview: async () => {
      counts.preview += 1;
      return { mimeType: "image/png", data: "preview-data" };
    },
  });

  const first = coordinator.submit(editorState());
  const second = coordinator.submit(editorState());
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(secondResult.submissionId, firstResult.submissionId);
  assert.deepEqual(counts, { preview: 1, save: 1, context: 1, message: 1 });
});

test("reentrant submission calls are registered before the preview adapter runs", async () => {
  const counts = { preview: 0, save: 0, context: 0 };
  let releasePreview;
  let nestedSubmission;
  const previewRequest = new Promise((resolve) => {
    releasePreview = resolve;
  });
  const app = {
    getHostCapabilities() {
      return {
        message: {},
        updateModelContext: { text: {}, image: {}, structuredContent: {} },
      };
    },
    async callServerTool() {
      counts.save += 1;
      return preparedResponse();
    },
    async updateModelContext() {
      counts.context += 1;
      return {};
    },
  };
  let coordinator;
  coordinator = createSubmissionCoordinator({
    app,
    createSubmissionId: () => "sub_01",
    rasterizePreview: async () => {
      counts.preview += 1;
      if (!nestedSubmission) nestedSubmission = coordinator.submit(editorState());
      return previewRequest;
    },
  });

  const firstSubmission = coordinator.submit(editorState());
  await new Promise((resolve) => setTimeout(resolve, 0));
  releasePreview({ mimeType: "image/png", data: "preview-data" });
  const [firstResult, nestedResult] = await Promise.all([firstSubmission, nestedSubmission]);

  assert.equal(nestedResult.submissionId, firstResult.submissionId);
  assert.deepEqual(counts, { preview: 1, save: 1, context: 1 });
});

test("an unacknowledged composer update reuses one in-flight request until its late acknowledgement", async () => {
  const counts = { save: 0, context: 0, message: 0 };
  let acknowledgeContext;
  const contextRequest = new Promise((resolve) => {
    acknowledgeContext = resolve;
  });
  const app = {
    getHostCapabilities() {
      return {
        message: {},
        updateModelContext: { text: {}, image: {}, structuredContent: {} },
      };
    },
    async callServerTool() {
      counts.save += 1;
      return preparedResponse();
    },
    async updateModelContext() {
      counts.context += 1;
      return contextRequest;
    },
    async sendMessage() {
      counts.message += 1;
      return {};
    },
  };
  const coordinator = createSubmissionCoordinator({
    app,
    contextTimeoutMs: 1,
    createSubmissionId: () => "sub_01",
    rasterizePreview: async () => ({ mimeType: "image/png", data: "preview-data" }),
  });

  const first = await coordinator.submit(editorState());
  const second = await coordinator.submit(editorState());
  acknowledgeContext({});
  await contextRequest;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const third = await coordinator.submit(editorState());

  assert.equal(first.delivery, "composer");
  assert.equal(first.contextAcknowledged, false);
  assert.equal(second.submissionId, first.submissionId);
  assert.equal(second.contextAcknowledged, false);
  assert.equal(third.contextAcknowledged, true);
  assert.deepEqual(counts, { save: 1, context: 1, message: 0 });
});

test("a rejected composer update retries context once without saving annotations again", async () => {
  const counts = { save: 0, context: 0 };
  let rejectContext;
  const firstContextRequest = new Promise((_, reject) => {
    rejectContext = reject;
  });
  const app = {
    getHostCapabilities() {
      return {
        message: {},
        updateModelContext: { text: {}, image: {}, structuredContent: {} },
      };
    },
    async callServerTool() {
      counts.save += 1;
      return preparedResponse();
    },
    async updateModelContext() {
      counts.context += 1;
      if (counts.context === 1) return firstContextRequest;
      return {};
    },
  };
  const coordinator = createSubmissionCoordinator({
    app,
    contextTimeoutMs: 1,
    createSubmissionId: () => "sub_01",
    rasterizePreview: async () => ({ mimeType: "image/png", data: "preview-data" }),
  });

  const first = await coordinator.submit(editorState());
  const second = await coordinator.submit(editorState());
  assert.equal(first.contextAcknowledged, false);
  assert.equal(second.contextAcknowledged, false);
  assert.deepEqual(counts, { save: 1, context: 1 });

  rejectContext(new Error("host rejected model context"));
  await firstContextRequest.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  const third = await coordinator.submit(editorState());

  assert.equal(third.contextAcknowledged, true);
  assert.deepEqual(counts, { save: 1, context: 2 });
});

test("a changed composer payload waits for the previous context request to settle", async () => {
  const counts = { preview: 0, prepare: 0, context: 0 };
  let rejectContext;
  const firstContextRequest = new Promise((_, reject) => {
    rejectContext = reject;
  });
  const app = {
    getHostCapabilities() {
      return {
        message: {},
        updateModelContext: { text: {}, image: {}, structuredContent: {} },
      };
    },
    async callServerTool() {
      counts.prepare += 1;
      return preparedResponse({ annotationId: null, submissionId: `sub_0${counts.prepare}` });
    },
    async updateModelContext() {
      counts.context += 1;
      if (counts.context === 1) return firstContextRequest;
      return {};
    },
  };
  const coordinator = createSubmissionCoordinator({
    app,
    contextTimeoutMs: 1,
    rasterizePreview: async () => {
      counts.preview += 1;
      return { mimeType: "image/png", data: "preview-data" };
    },
  });
  const original = { ...editorState(), annotations: [], prompt: "保持构图" };
  const changed = { ...original, prompt: "保持构图并调整颜色" };

  await coordinator.submit(original);
  await assert.rejects(
    coordinator.submit(changed),
    (error) => error.stage === "busy",
  );
  assert.deepEqual(counts, { preview: 1, prepare: 1, context: 1 });

  rejectContext(new Error("host rejected model context"));
  await firstContextRequest.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  const result = await coordinator.submit(changed);

  assert.equal(result.contextAcknowledged, true);
  assert.deepEqual(counts, { preview: 2, prepare: 2, context: 2 });
});

test("reset keeps a global busy gate until an earlier composer update settles", async () => {
  const counts = { prepare: 0, context: 0 };
  let acknowledgeFirstContext;
  const firstContextRequest = new Promise((resolve) => {
    acknowledgeFirstContext = resolve;
  });
  const app = {
    getHostCapabilities() {
      return {
        message: {},
        updateModelContext: { text: {}, image: {}, structuredContent: {} },
      };
    },
    async callServerTool(request) {
      counts.prepare += 1;
      return {
        structuredContent: {
          annotation: null,
          submission: {
            id: `sub_${counts.prepare.toString(16).padStart(32, "0")}`,
            parentImageId: request.arguments.parentImageId,
            annotationId: null,
            revisionSha256: "a".repeat(64),
          },
        },
      };
    },
    async updateModelContext() {
      counts.context += 1;
      if (counts.context === 1) return firstContextRequest;
      return {};
    },
  };
  const coordinator = createSubmissionCoordinator({
    app,
    contextTimeoutMs: 1,
    rasterizePreview: async () => ({ mimeType: "image/png", data: "preview-data" }),
  });
  const first = { ...editorState(), annotations: [], prompt: "第一张图" };
  const second = {
    ...first,
    image: { ...first.image, id: "img_01J00000000000000000000001" },
    prompt: "第二张图",
  };

  const firstResult = await coordinator.submit(first);
  coordinator.reset();
  await assert.rejects(
    coordinator.submit(second),
    (error) => error.stage === "busy",
  );
  assert.deepEqual(counts, { prepare: 1, context: 1 });

  acknowledgeFirstContext({});
  assert.deepEqual(await firstResult.contextOutcome, { ok: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const secondResult = await coordinator.submit(second);

  assert.equal(secondResult.contextAcknowledged, true);
  assert.deepEqual(counts, { prepare: 2, context: 2 });
});

test("an inactive coordinator stops after preparation without publishing host context", async () => {
  const counts = { prepare: 0, context: 0 };
  let releasePreparation;
  let resourceActive = true;
  const preparation = new Promise((resolve) => {
    releasePreparation = resolve;
  });
  const app = {
    getHostCapabilities() {
      return {
        message: {},
        updateModelContext: { text: {}, image: {}, structuredContent: {} },
      };
    },
    async callServerTool() {
      counts.prepare += 1;
      return preparation;
    },
    async updateModelContext() {
      counts.context += 1;
      return {};
    },
  };
  const coordinator = createSubmissionCoordinator({
    app,
    isActive: () => resourceActive,
    rasterizePreview: async () => ({ mimeType: "image/png", data: "preview-data" }),
  });

  const submission = coordinator.submit(editorState());
  await new Promise((resolve) => setTimeout(resolve, 0));
  resourceActive = false;
  releasePreparation(preparedResponse());

  await assert.rejects(submission, (error) => error.stage === "inactive");
  assert.deepEqual(counts, { prepare: 1, context: 0 });
});

test("submission stops before side effects when the host has no atomic text and image route", async () => {
  const calls = [];
  const app = {
    getHostCapabilities() {
      return {
        message: {},
        updateModelContext: { text: {}, structuredContent: {} },
      };
    },
    async callServerTool() {
      calls.push("save");
      return {};
    },
    async updateModelContext() {
      calls.push("context");
      return {};
    },
    async sendMessage() {
      calls.push("message");
      return {};
    },
  };
  const coordinator = createSubmissionCoordinator({
    app,
    rasterizePreview: async () => {
      calls.push("preview");
      return { mimeType: "image/png", data: "preview-data" };
    },
  });

  await assert.rejects(
    coordinator.submit(editorState()),
    (error) => error.stage === "capabilities" && /atomic text and image/i.test(error.message),
  );
  assert.deepEqual(calls, []);
});

test("retry after a message failure does not save or publish context twice", async () => {
  const counts = { save: 0, context: 0, message: 0 };
  const app = {
    getHostCapabilities() {
      return {
        message: { text: {}, image: {} },
        updateModelContext: { structuredContent: {} },
      };
    },
    async callServerTool() {
      counts.save += 1;
      return preparedResponse();
    },
    async updateModelContext() {
      counts.context += 1;
      return {};
    },
    async sendMessage() {
      counts.message += 1;
      if (counts.message === 1) return { isError: true };
      return {};
    },
  };
  const coordinator = createSubmissionCoordinator({
    app,
    createSubmissionId: () => "sub_01",
    rasterizePreview: async () => ({ mimeType: "image/png", data: "preview-data" }),
  });

  await assert.rejects(coordinator.submit(editorState()), (error) => error.stage === "message");
  await coordinator.submit(editorState());

  assert.deepEqual(counts, { save: 1, context: 1, message: 2 });
});
