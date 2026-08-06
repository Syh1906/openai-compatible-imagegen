import assert from "node:assert/strict";
import test from "node:test";

import {
  addAnnotation,
  buildAnnotationPreview,
  createEditorState,
  normalizeAnnotation,
  removeAnnotation,
  serializeSubmission,
  toMcpAnnotationItems,
  updateAnnotation,
} from "../web/editor-state.mjs";

const image = {
  id: "img_01J00000000000000000000000",
  mimeType: "image/png",
  width: 1200,
  height: 800,
  operation: "generate",
  parentIds: [],
};

test("editor state can start without a bound image while waiting for host input", () => {
  const state = createEditorState({ image: { ...image, id: "" } });

  assert.equal(state.image.id, "");
  assert.deepEqual(state.lineage, []);
  assert.equal(state.annotations.length, 0);
});

test("editor state keeps the bound image and a compact parent/current/child lineage", () => {
  const state = createEditorState({
    image,
    parent: { ...image, id: "img_01J00000000000000000000001", operation: "generate" },
    children: [{ ...image, id: "img_01J00000000000000000000002", operation: "edit", parentIds: [image.id] }],
  });

  assert.equal(state.image.id, image.id);
  assert.deepEqual(state.lineage.map((item) => item.role), ["parent", "current", "child"]);
  assert.equal(state.lineage.find((item) => item.role === "current").id, image.id);
});

test("annotations normalize to original-image coordinates and submit together", () => {
  const state = createEditorState({ image });
  const arrow = normalizeAnnotation(
    { type: "arrow", x: 120, y: 80, width: 360, height: 160, text: "把标题放大" },
    { viewportWidth: 600, viewportHeight: 400 },
  );
  const next = addAnnotation(state, arrow);
  const withText = addAnnotation(next, normalizeAnnotation(
    { type: "text", x: 480, y: 200, width: 90, height: 40, text: "去掉阴影" },
    { viewportWidth: 600, viewportHeight: 400 },
  ));

  assert.deepEqual(withText.annotations.map((item) => item.type), ["arrow", "text"]);
  assert.equal(withText.annotations[0].x, 0.2);
  assert.equal(withText.annotations[0].width, 0.6);

  const payload = serializeSubmission(withText, "保持整体风格一致");
  assert.equal(payload.imageId, image.id);
  assert.equal(payload.annotations.length, 2);
  assert.equal(payload.prompt, "保持整体风格一致");
  assert.equal(payload.preview.mimeType, "image/svg+xml");
});

test("each annotation remains independently editable and maps to one MCP item", () => {
  const state = createEditorState({ image });
  const arrow = normalizeAnnotation(
    { id: "arrow-1", type: "arrow", x: 120, y: 80, width: 360, height: 160, text: "原始箭头" },
    { viewportWidth: 600, viewportHeight: 400 },
  );
  const pen = normalizeAnnotation(
    { id: "pen-1", type: "pen", points: [{ x: 20, y: 30 }, { x: 40, y: 50 }], text: "原始画笔" },
    { viewportWidth: 100, viewportHeight: 100 },
  );
  const withItems = addAnnotation(addAnnotation(state, arrow), pen);
  const edited = updateAnnotation(withItems, "arrow-1", { text: "只修改箭头" });

  assert.equal(edited.annotations.find((item) => item.id === "arrow-1").text, "只修改箭头");
  assert.equal(edited.annotations.find((item) => item.id === "pen-1").text, "原始画笔");
  assert.deepEqual(toMcpAnnotationItems(edited), [
    {
      id: "arrow-1",
      type: "arrow",
      from: { x: 0.2, y: 0.2 },
      to: { x: 0.8, y: 0.6 },
      text: "只修改箭头",
      color: "#ef4444",
      strokeWidth: 5,
    },
    {
      id: "pen-1",
      type: "pen",
      points: [{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.5 }],
      text: "原始画笔",
      color: "#ef4444",
      strokeWidth: 5,
    },
  ]);

  const removed = removeAnnotation(edited, "arrow-1");
  assert.deepEqual(removed.annotations.map((item) => item.id), ["pen-1"]);
});

test("arrow direction and visual styling survive normalization and preview rendering", () => {
  const state = createEditorState({ image });
  const arrow = normalizeAnnotation(
    {
      id: "reverse-arrow",
      type: "arrow",
      x: 120,
      y: 80,
      width: 360,
      height: 160,
      from: { x: 480, y: 240 },
      to: { x: 120, y: 80 },
      color: "#2563eb",
      strokeWidth: 3,
    },
    { viewportWidth: 600, viewportHeight: 400 },
  );
  const withArrow = addAnnotation(state, arrow);

  assert.deepEqual(toMcpAnnotationItems(withArrow), [
    {
      id: "reverse-arrow",
      type: "arrow",
      from: { x: 0.8, y: 0.6 },
      to: { x: 0.2, y: 0.2 },
      color: "#2563eb",
      strokeWidth: 3,
    },
  ]);
  assert.equal(arrow.color, "#2563eb");
  assert.equal(arrow.strokeWidth, 3);

  const preview = buildAnnotationPreview(withArrow);
  assert.match(preview, /stroke="#2563eb"/);
  assert.match(preview, /stroke-width="3"/);
  assert.match(preview, /M 800 600 L 200 200/);
  assert.match(preview, /class="annotation-index"/);
});

test("mask preview follows the same freehand path sent to MCP", () => {
  let state = createEditorState({ image });
  const mask = normalizeAnnotation(
    {
      type: "mask",
      x: 100,
      y: 100,
      width: 200,
      height: 200,
      points: [{ x: 100, y: 100 }, { x: 180, y: 220 }, { x: 300, y: 300 }],
    },
    { viewportWidth: 1000, viewportHeight: 1000 },
  );
  state = addAnnotation(state, mask);

  const [item] = toMcpAnnotationItems(state);
  const preview = buildAnnotationPreview(state);

  assert.equal(item.type, "mask");
  assert.deepEqual(item.points, mask.points);
  assert.match(preview, /<polyline[^>]+stroke-opacity="0\.35"/);
  assert.doesNotMatch(preview, /<rect[^>]+stroke-dasharray/);
});
