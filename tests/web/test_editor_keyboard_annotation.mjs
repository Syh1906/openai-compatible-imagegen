import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceKeyboardAnnotation,
  createKeyboardAnnotationState,
  keyboardAnnotationPreview,
} from "../../web/editor-keyboard-annotation.mjs";
import { createEditorKeyboardController } from "../../web/editor-keyboard-controller.mjs";
import { createEditorState } from "../../web/editor-state.mjs";


test("keyboard drawing moves a visible cursor in image-pixel steps", () => {
  const editor = editorFor("rectangle", { width: 1000, height: 500 });
  let state = createKeyboardAnnotationState(editor.image.id);

  let result = advanceKeyboardAnnotation(state, { key: "ArrowRight" }, editor);
  assert.equal(result.handled, true);
  assert.deepEqual(result.state.cursor, { x: 0.501, y: 0.5 });

  result = advanceKeyboardAnnotation(result.state, { key: "ArrowDown", shiftKey: true }, editor);
  assert.deepEqual(result.state.cursor, { x: 0.501, y: 0.52 });
});

test("keyboard rectangle and arrow use Space, direction keys, and Enter", () => {
  for (const tool of ["rectangle", "arrow"]) {
    const editor = editorFor(tool);
    let state = createKeyboardAnnotationState(editor.image.id);
    state = advanceKeyboardAnnotation(state, { key: " " }, editor).state;
    state = advanceKeyboardAnnotation(state, { key: "ArrowRight", shiftKey: true }, editor).state;
    state = advanceKeyboardAnnotation(state, { key: "ArrowDown", shiftKey: true }, editor).state;

    const preview = keyboardAnnotationPreview(state, editor);
    assert.equal(preview.type, tool);
    assert.equal(preview.width, 0.01);
    assert.equal(preview.height, 0.01);

    const committed = advanceKeyboardAnnotation(state, { key: "Enter" }, editor);
    assert.equal(committed.handled, true);
    assert.equal(committed.annotation.type, tool);
    assert.equal(committed.state.drawing, null);
    if (tool === "arrow") {
      assert.deepEqual(committed.annotation.from, { x: 0.5, y: 0.5 });
      assert.deepEqual(committed.annotation.to, { x: 0.51, y: 0.51 });
    }
  }
});

test("keyboard pen samples a continuous path", () => {
  const editor = editorFor("pen");
  let state = createKeyboardAnnotationState(editor.image.id);
  state = advanceKeyboardAnnotation(state, { key: " " }, editor).state;
  state = advanceKeyboardAnnotation(state, { key: "ArrowRight" }, editor).state;
  state = advanceKeyboardAnnotation(state, { key: "ArrowDown" }, editor).state;

  const committed = advanceKeyboardAnnotation(state, { key: "Enter" }, editor);
  assert.equal(committed.annotation.type, "pen");
  assert.deepEqual(committed.annotation.points, [
    { x: 0.5, y: 0.5 },
    { x: 0.501, y: 0.5 },
    { x: 0.501, y: 0.501 },
  ]);
});

test("keyboard mask keeps the active mode, operation, and brush radius", () => {
  const editor = {
    ...editorFor("mask"),
    maskMode: "protect",
    maskOperation: "paint",
    maskBrushRadius: 0.06,
  };
  let state = createKeyboardAnnotationState(editor.image.id);
  state = advanceKeyboardAnnotation(state, { key: " " }, editor).state;
  state = advanceKeyboardAnnotation(state, { key: "ArrowLeft", shiftKey: true }, editor).state;

  const committed = advanceKeyboardAnnotation(state, { key: "Enter" }, editor);
  assert.deepEqual(
    {
      type: committed.annotation.type,
      mode: committed.annotation.mode,
      operation: committed.annotation.operation,
      brushRadius: committed.annotation.brushRadius,
      points: committed.annotation.points,
    },
    {
      type: "mask",
      mode: "protect",
      operation: "paint",
      brushRadius: 0.06,
      points: [{ x: 0.5, y: 0.5 }, { x: 0.49, y: 0.5 }],
    },
  );
});

test("keyboard text creates at the cursor and requests inline editing", () => {
  const editor = editorFor("text");
  let state = createKeyboardAnnotationState(editor.image.id);
  state = advanceKeyboardAnnotation(state, { key: "ArrowLeft", shiftKey: true }, editor).state;

  const committed = advanceKeyboardAnnotation(state, { key: "Enter" }, editor);
  assert.equal(committed.annotation.type, "text");
  assert.equal(committed.annotation.text, "标注文字");
  assert.equal(committed.startTextEditing, true);
  assert.equal(committed.annotation.x, 0.49);
});

test("Escape cancels only the active keyboard drawing", () => {
  const editor = editorFor("rectangle");
  const idle = createKeyboardAnnotationState(editor.image.id);
  assert.equal(advanceKeyboardAnnotation(idle, { key: "Escape" }, editor).handled, false);

  const drawing = advanceKeyboardAnnotation(idle, { key: " " }, editor).state;
  const cancelled = advanceKeyboardAnnotation(drawing, { key: "Escape" }, editor);
  assert.equal(cancelled.handled, true);
  assert.equal(cancelled.state.drawing, null);
  assert.equal(cancelled.annotation, null);
});

test("keyboard controller blocks locked input and cancels a drawing after the active tool changes", () => {
  let editor = editorFor("rectangle");
  let locked = true;
  let historyCount = 0;
  const controller = createController({
    getEditor: () => editor,
    setEditor: (value) => { editor = value; },
    isInteractionLocked: () => locked,
    pushHistory: () => { historyCount += 1; },
  });
  const start = canvasKey(" ");

  assert.equal(controller.handleCanvasKeyDown(start), false);
  assert.equal(controller.hasDrawing(), false);
  assert.equal(historyCount, 0);

  locked = false;
  assert.equal(controller.handleCanvasKeyDown(start), true);
  assert.equal(controller.hasDrawing(), true);
  editor = { ...editor, activeTool: "select" };
  assert.equal(controller.cancel({ renderNow: false }), true);
  assert.equal(controller.hasDrawing(), false);
});

test("starting a keyboard annotation restores a hidden annotation layer", () => {
  let editor = { ...editorFor("rectangle"), annotationVisible: false };
  const controller = createController({
    getEditor: () => editor,
    setEditor: (value) => { editor = value; },
  });

  assert.equal(controller.handleCanvasKeyDown(canvasKey(" ")), true);
  assert.equal(editor.annotationVisible, true);
  assert.equal(controller.hasDrawing(), true);
});

function editorFor(activeTool, dimensions = {}) {
  return {
    ...createEditorState({
      image: {
        id: "img_keyboard",
        mimeType: "image/png",
        width: dimensions.width || 1000,
        height: dimensions.height || 1000,
        parentIds: [],
      },
    }),
    activeTool,
  };
}

function createController(overrides = {}) {
  return createEditorKeyboardController({
    renderer: { renderAnnotationLayer() {}, renderPreviewAnnotation() {} },
    getEditor: overrides.getEditor,
    setEditor: overrides.setEditor,
    hasPointerInteraction: () => false,
    isInteractionLocked: overrides.isInteractionLocked || (() => false),
    pushHistory: overrides.pushHistory || (() => {}),
    clearStatus() {},
    openIntentPanel() {},
    startTextEditing() {},
    render() {},
  });
}

function canvasKey(key, options = {}) {
  return {
    key,
    ...options,
    target: { closest: (selector) => selector === "[data-canvas]" ? {} : null },
  };
}
