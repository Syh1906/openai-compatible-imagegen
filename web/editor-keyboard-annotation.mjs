import { normalizeAnnotation, translateAnnotation } from "./editor-state.mjs";
import { maskColor } from "./editor-annotation-view.mjs";


const DRAWING_TOOLS = new Set(["pen", "arrow", "rectangle", "mask"]);
const KEYBOARD_TOOLS = new Set([...DRAWING_TOOLS, "text"]);
const DIRECTIONS = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export function createKeyboardAnnotationState(imageId = "") {
  return {
    imageId: String(imageId || ""),
    cursor: { x: 0.5, y: 0.5 },
    drawing: null,
    engaged: false,
  };
}

export function advanceKeyboardAnnotation(inputState, keyEvent, editor) {
  const state = stateForEditor(inputState, editor);
  const key = keyEvent?.key;
  if (!KEYBOARD_TOOLS.has(editor?.activeTool)) return result(false, state);

  if (key === "Escape") {
    if (!state.drawing) return result(false, state);
    return result(true, { ...state, drawing: null, engaged: true });
  }

  const direction = DIRECTIONS[key];
  if (direction) {
    const cursor = moveCursor(state.cursor, direction, editor.image, keyEvent?.shiftKey);
    const drawing = state.drawing
      ? advanceDrawing(state.drawing, cursor)
      : null;
    return result(true, { ...state, cursor, drawing, engaged: true });
  }

  if (key === " " && DRAWING_TOOLS.has(editor.activeTool)) {
    if (state.drawing) return result(true, state);
    return result(true, {
      ...state,
      drawing: {
        tool: editor.activeTool,
        start: state.cursor,
        current: state.cursor,
        points: [state.cursor],
      },
      engaged: true,
    });
  }

  if (key !== "Enter") return result(false, state);
  if (editor.activeTool === "text") {
    return result(true, { ...state, drawing: null, engaged: false }, annotationAtCursor(editor, state.cursor), true);
  }
  if (!state.drawing || !hasDrawingMovement(state.drawing)) return result(true, state);
  return result(true, { ...state, drawing: null, engaged: false }, annotationFromDrawing(editor, state.drawing));
}

export function keyboardAnnotationPreview(inputState, editor) {
  const state = stateForEditor(inputState, editor);
  return state.drawing && hasDrawingMovement(state.drawing)
    ? annotationFromDrawing(editor, state.drawing, "keyboard-preview")
    : null;
}

export function nudgeSelectedAnnotation(editor, keyEvent) {
  const direction = DIRECTIONS[keyEvent?.key];
  if (!direction || ["text", "mask"].includes(editor?.activeTool) || editor?.editingTextAnnotationId) return null;
  const selected = editor.annotations.find((item) => item.id === editor.selectedAnnotationId);
  if (!selected || selected.type === "mask") return null;
  const width = positiveDimension(editor.image?.width);
  const height = positiveDimension(editor.image?.height);
  const step = keyEvent?.shiftKey ? 10 : 1;
  const moved = translateAnnotation(selected, direction[0] * step / width, direction[1] * step / height);
  return moved.x === selected.x && moved.y === selected.y ? null : moved;
}

export function isNativeEditingTarget(target) {
  return Boolean(target?.closest?.('textarea, select, input, [contenteditable]:not([contenteditable="false"])'));
}

function stateForEditor(state, editor) {
  return state?.imageId === editor?.image?.id
    ? state
    : createKeyboardAnnotationState(editor?.image?.id);
}

function moveCursor(cursor, direction, image, accelerated) {
  const step = accelerated ? 10 : 1;
  return {
    x: round(clamp(cursor.x + direction[0] * step / positiveDimension(image?.width))),
    y: round(clamp(cursor.y + direction[1] * step / positiveDimension(image?.height))),
  };
}

function advanceDrawing(drawing, cursor) {
  const points = drawing.tool === "pen" || drawing.tool === "mask"
    ? appendDistinctPoint(drawing.points, cursor)
    : drawing.points;
  return { ...drawing, current: cursor, points };
}

function appendDistinctPoint(points, point) {
  const last = points.at(-1);
  return last?.x === point.x && last?.y === point.y ? points : [...points, point];
}

function hasDrawingMovement(drawing) {
  return drawing.points.length > 1
    || drawing.start.x !== drawing.current.x
    || drawing.start.y !== drawing.current.y;
}

function annotationAtCursor(editor, cursor) {
  const dimensions = imageDimensions(editor.image);
  return normalizeAnnotation({
    type: "text",
    x: cursor.x * dimensions.width,
    y: cursor.y * dimensions.height,
    width: 0,
    height: 0,
    points: [],
    text: "标注文字",
    color: editor.color || "#ef4444",
    strokeWidth: editor.strokeWidth || 5,
  }, { viewportWidth: dimensions.width, viewportHeight: dimensions.height });
}

function annotationFromDrawing(editor, drawing, id = null) {
  const dimensions = imageDimensions(editor.image);
  const start = toPixels(drawing.start, dimensions);
  const end = toPixels(drawing.current, dimensions);
  const points = drawing.points.map((point) => toPixels(point, dimensions));
  return normalizeAnnotation({
    ...(id ? { id } : {}),
    type: drawing.tool,
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
    points,
    text: "",
    color: drawing.tool === "mask" ? maskColor(editor.maskMode) : (editor.color || "#ef4444"),
    strokeWidth: editor.strokeWidth || 5,
    ...(drawing.tool === "mask" ? {
      mode: editor.maskMode,
      operation: editor.maskOperation,
      brushRadius: editor.maskBrushRadius,
    } : {}),
    ...(drawing.tool === "arrow" ? { from: start, to: end } : {}),
  }, { viewportWidth: dimensions.width, viewportHeight: dimensions.height });
}

function imageDimensions(image) {
  return { width: positiveDimension(image?.width), height: positiveDimension(image?.height) };
}

function positiveDimension(value) {
  const dimension = Number(value);
  return Number.isFinite(dimension) && dimension > 0 ? dimension : 1;
}

function toPixels(point, dimensions) {
  return { x: point.x * dimensions.width, y: point.y * dimensions.height };
}

function result(handled, state, annotation = null, startTextEditing = false) {
  return { handled, state, annotation, startTextEditing };
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
