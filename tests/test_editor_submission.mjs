import assert from "node:assert/strict";
import test from "node:test";

import { createSubmissionCoordinator } from "../web/editor-submission.mjs";


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

test("submission coordinator publishes the transaction in strict order", async () => {
  const calls = [];
  const app = {
    async callServerTool(request) {
      calls.push(request.name);
      return { structuredContent: { annotation: { id: "ann_01" } } };
    },
    async updateModelContext(request) {
      calls.push("context");
      assert.equal(request.structuredContent.annotationId, "ann_01");
      assert.equal(request.content[1].type, "image");
      return {};
    },
    async sendMessage(request) {
      calls.push("message");
      assert.deepEqual(request.content.map((item) => item.type), ["text"]);
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

  assert.deepEqual(calls, ["preview", "save_image_annotations", "context", "message"]);
  assert.equal(result.annotationId, "ann_01");
  assert.equal(result.submissionId, "sub_01");
  assert.match(result.requestText, /1\. 箭头指引：提亮这里/);
});

test("retry after a message failure does not save or publish context twice", async () => {
  const counts = { save: 0, context: 0, message: 0 };
  const app = {
    async callServerTool() {
      counts.save += 1;
      return { structuredContent: { annotation: { id: "ann_01" } } };
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
