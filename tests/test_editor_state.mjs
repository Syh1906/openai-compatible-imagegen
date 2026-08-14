import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAnnotationPreview,
  createEditorState,
  normalizeEditorColorState,
  normalizeAnnotation,
  normalizeMaskOperationState,
  toMcpAnnotationItems,
  translateAnnotation,
  updateAnnotation,
} from "../web/editor-state.mjs";
import { textAnnotationBounds } from "../web/editor-text-geometry.mjs";


const image = {
  id: "img_01J00000000000000000000000",
  width: 1200,
  height: 800,
  mimeType: "image/png",
  parentIds: [],
};

test("editor state exposes four distinct editable foreground slots and a bidirectional mask brush", () => {
  const editor = createEditorState({ image });

  assert.equal(editor.color, "#ef4444");
  assert.deepEqual(editor.colorSlots, ["#ef4444", "#2563eb", "#16a34a", "#111827"]);
  assert.equal(new Set(editor.colorSlots).size, 4);
  assert.equal(editor.activeColorSlot, 0);
  assert.equal(editor.maskMode, "edit");
  assert.equal(editor.maskOperation, "paint");
  assert.equal(editor.maskBrushRadius, 0.035);
});

test("editor color migration converts the legacy preset and custom model into four slots", () => {
  assert.deepEqual(
    normalizeEditorColorState({ color: "#2563eb", colorSource: "preset", customColor: "#22c55e" }),
    {
      color: "#2563eb",
      colorSlots: ["#ef4444", "#2563eb", "#16a34a", "#22c55e"],
      activeColorSlot: 1,
    },
  );
  assert.deepEqual(
    normalizeEditorColorState({ color: "#a855f7", colorSource: "custom", customColor: "#a855f7" }),
    {
      color: "#a855f7",
      colorSlots: ["#ef4444", "#2563eb", "#16a34a", "#a855f7"],
      activeColorSlot: 3,
    },
  );
});

test("editor color restore preserves the active slot when multiple slots share a color", () => {
  assert.deepEqual(
    normalizeEditorColorState({
      color: "#ef4444",
      colorSlots: ["#ef4444", "#2563eb", "#16a34a", "#ef4444"],
      activeColorSlot: 3,
    }),
    {
      color: "#ef4444",
      colorSlots: ["#ef4444", "#2563eb", "#16a34a", "#ef4444"],
      activeColorSlot: 3,
    },
  );
});

test("mask annotations preserve mode and normalized short-edge radius through MCP serialization", () => {
  const annotation = normalizeAnnotation({
    id: "mask_1",
    type: "mask",
    mode: "protect",
    operation: "erase",
    brushRadius: 0.06,
    points: [{ x: 120, y: 80 }, { x: 360, y: 240 }],
    color: "#2563eb",
  }, { viewportWidth: 1200, viewportHeight: 800 });
  const editor = {
    ...createEditorState({ image }),
    annotations: [annotation],
  };

  assert.deepEqual(toMcpAnnotationItems(editor), [{
    id: "mask_1",
    type: "mask",
    mode: "protect",
    operation: "erase",
    brushRadius: 0.06,
    points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }],
    color: "#2563eb",
  }]);
  assert.doesNotMatch(buildAnnotationPreview(editor), /stroke-dasharray=/);
});

test("ordinary annotations keep their contrast treatment in the submitted preview", () => {
  const editor = {
    ...createEditorState({ image }),
    annotations: [normalizeAnnotation({
      id: "rectangle_1",
      type: "rectangle",
      x: 120,
      y: 80,
      width: 360,
      height: 240,
      color: "#22c55e",
      strokeWidth: 5,
    }, { viewportWidth: 1200, viewportHeight: 800 })],
  };

  assert.match(buildAnnotationPreview(editor), /data-contrast-outline="true"/);
  assert.match(buildAnnotationPreview(editor), /stroke="#22c55e"/);
});

test("mask annotations reject missing modes and invalid brush radii", () => {
  const viewport = { viewportWidth: 1200, viewportHeight: 800 };
  const base = {
    id: "mask_1",
    type: "mask",
    points: [{ x: 120, y: 80 }, { x: 360, y: 240 }],
  };

  assert.throws(() => normalizeAnnotation({ ...base, brushRadius: 0.035 }, viewport), /mode/i);
  assert.throws(() => normalizeAnnotation({ ...base, mode: "edit", brushRadius: 0 }, viewport), /brushRadius/i);
  assert.throws(() => normalizeAnnotation({ ...base, mode: "protect", brushRadius: 0.51 }, viewport), /brushRadius/i);
  assert.throws(() => normalizeAnnotation({ ...base, mode: "edit", operation: "replace", brushRadius: 0.035 }, viewport), /operation/i);
});

test("text translation keeps the visible glyph area inside the viewport", () => {
  const text = normalizeAnnotation({
    id: "text_boundary",
    type: "text",
    x: 200,
    y: 300,
    text: "边界文字",
  }, { viewportWidth: 1000, viewportHeight: 1000 });

  const bottomRight = translateAnnotation(text, 1, 1, { viewportWidth: 1000, viewportHeight: 1000 });
  assert.ok(bottomRight.x <= 0.88, `text right edge escaped with x=${bottomRight.x}`);
  assert.ok(bottomRight.y < 1, `text baseline escaped with y=${bottomRight.y}`);

  const topLeft = translateAnnotation(text, -1, -1, { viewportWidth: 1000, viewportHeight: 1000 });
  assert.equal(topLeft.x, 0);
  assert.ok(topLeft.y > 0, `text top edge escaped with y=${topLeft.y}`);
});

test("text creation and edits keep the visible block inside the image bounds", () => {
  const viewport = { viewportWidth: 1000, viewportHeight: 1000 };
  const edgeText = normalizeAnnotation({
    id: "text_edge",
    type: "text",
    x: 1000,
    y: 0,
    text: "右上角很长的标注文字",
  }, viewport);
  const edgeBounds = textAnnotationBounds(edgeText, { width: 1000, height: 1000 });
  assert.ok(edgeBounds.left >= 0, `text left edge escaped with ${edgeBounds.left}`);
  assert.ok(edgeBounds.right <= 1, `text right edge escaped with ${edgeBounds.right}`);
  assert.ok(edgeBounds.top >= 0, `text top edge escaped with ${edgeBounds.top}`);
  assert.ok(edgeBounds.bottom <= 1, `text bottom edge escaped with ${edgeBounds.bottom}`);

  const state = createEditorState({ image: { ...image, width: 1000, height: 1000 } });
  const withText = { ...state, annotations: [edgeText] };
  const edited = updateAnnotation(withText, edgeText.id, { text: "这是一个会很长很长很长很长很长很长很长很长很长很长的说明" });
  const editedBounds = textAnnotationBounds(edited.annotations[0], { width: 1000, height: 1000 });
  assert.ok(editedBounds.left >= 0);
  assert.ok(editedBounds.right <= 1);
  assert.ok(editedBounds.top >= 0);
  assert.ok(editedBounds.bottom <= 1);
});

test("mask state normalization removes erase strokes without an earlier paint in the same layer", () => {
  const paint = { id: "paint", type: "mask", mode: "edit", operation: "paint" };
  const editErase = { id: "edit_erase", type: "mask", mode: "edit", operation: "erase" };
  const protectErase = { id: "protect_erase", type: "mask", mode: "protect", operation: "erase" };
  const protectPaint = { id: "protect_paint", type: "mask", mode: "protect", operation: "paint" };
  const state = normalizeMaskOperationState({
    ...createEditorState({ image }),
    annotations: [protectErase, paint, editErase, protectPaint],
    selectedAnnotationId: "protect_erase",
    maskMode: "protect",
    maskOperation: "erase",
  });

  assert.deepEqual(state.annotations.map(({ id }) => id), ["paint", "edit_erase", "protect_paint"]);
  assert.equal(state.selectedAnnotationId, null);
  assert.equal(state.maskOperation, "erase");
});
