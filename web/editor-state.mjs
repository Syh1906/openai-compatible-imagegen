import { normalizeHexColor } from "./editor-color.mjs";
import { annotationLayerMarkup, annotationViewBox } from "./editor-annotation-view.mjs";
import { constrainTextAnnotation, textAnnotationBounds } from "./editor-text-geometry.mjs";

const ANNOTATION_TYPES = new Set(["select", "pen", "arrow", "rectangle", "text", "eraser", "mask"]);
export const DEFAULT_ANNOTATION_COLOR_SLOTS = Object.freeze(["#ef4444", "#2563eb", "#16a34a", "#111827"]);

export function createEditorState({ image, parent = null, children = [] } = {}) {
  if (!image) throw new Error("image is required");
  const lineage = [];
  if (parent?.id && parent.id !== image.id) lineage.push({ ...parent, role: "parent" });
  if (image.id) lineage.push({ ...image, role: "current" });
  for (const child of children) {
    if (child?.id && child.id !== image.id) lineage.push({ ...child, role: "child" });
  }
  return {
    image: { ...image },
    lineage,
    annotations: [],
    activeTool: "select",
    selectedAnnotationId: null,
    editingTextAnnotationId: null,
    color: DEFAULT_ANNOTATION_COLOR_SLOTS[0],
    colorSlots: [...DEFAULT_ANNOTATION_COLOR_SLOTS],
    activeColorSlot: 0,
    strokeWidth: 5,
    maskMode: "edit",
    maskOperation: "paint",
    maskBrushRadius: 0.035,
    annotationVisible: true,
    zoom: 1,
    prompt: "",
  };
}

export function normalizeEditorColorState(state) {
  const {
    color: inputColor,
    colorSlots: inputSlots,
    activeColorSlot: inputActiveColorSlot,
    customColor: legacyCustomColor,
    colorSource: _legacyColorSource,
    ...rest
  } = state || {};
  const colorSlots = normalizeColorSlots(inputSlots, legacyCustomColor);
  const requestedColor = normalizeHexColor(inputColor);
  let activeColorSlot = normalizeColorSlotIndex(inputActiveColorSlot);
  if (requestedColor && colorSlots[activeColorSlot] !== requestedColor) {
    const matchingSlot = colorSlots.indexOf(requestedColor);
    if (matchingSlot >= 0) activeColorSlot = matchingSlot;
    else {
      const targetSlot = activeColorSlot ?? 3;
      colorSlots[targetSlot] = requestedColor;
      activeColorSlot = targetSlot;
    }
  }
  if (activeColorSlot === null) activeColorSlot = 0;
  return {
    ...rest,
    color: colorSlots[activeColorSlot],
    colorSlots,
    activeColorSlot,
  };
}

function normalizeColorSlots(value, legacyCustomColor) {
  if (Array.isArray(value)) {
    return DEFAULT_ANNOTATION_COLOR_SLOTS.map((fallback, index) => normalizeHexColor(value[index]) || fallback);
  }
  const slots = [...DEFAULT_ANNOTATION_COLOR_SLOTS];
  const customColor = normalizeHexColor(legacyCustomColor);
  if (customColor) slots[3] = customColor;
  return slots;
}

function normalizeColorSlotIndex(value) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 && index < DEFAULT_ANNOTATION_COLOR_SLOTS.length ? index : null;
}

export function normalizeAnnotation(annotation, viewport) {
  const width = Math.max(1, Number(viewport?.viewportWidth) || 1);
  const height = Math.max(1, Number(viewport?.viewportHeight) || 1);
  const type = ANNOTATION_TYPES.has(annotation?.type) ? annotation.type : "pen";
  const normalized = {
    id: annotation?.id || `annotation_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type,
    x: roundCoordinate(clamp(Number(annotation?.x || 0) / width)),
    y: roundCoordinate(clamp(Number(annotation?.y || 0) / height)),
    width: roundCoordinate(clamp(Number(annotation?.width || 0) / width)),
    height: roundCoordinate(clamp(Number(annotation?.height || 0) / height)),
    points: Array.isArray(annotation?.points)
      ? annotation.points.map((point) => ({ x: roundCoordinate(clamp(Number(point.x || 0) / width)), y: roundCoordinate(clamp(Number(point.y || 0) / height)) }))
      : [],
    text: typeof annotation?.text === "string" ? annotation.text.trim() : "",
    color: normalizeColor(annotation?.color),
    strokeWidth: normalizeStrokeWidth(annotation?.strokeWidth),
  };
  if (type === "mask") {
    normalized.mode = normalizeMaskMode(annotation?.mode);
    normalized.operation = normalizeMaskOperation(annotation?.operation);
    normalized.brushRadius = normalizeMaskBrushRadius(annotation?.brushRadius);
    normalized.color = normalizeColor(annotation?.color, normalized.mode === "protect" ? "#2563eb" : "#ef4444");
  }
  if (type === "arrow") {
    normalized.from = normalizePoint(annotation?.from || { x: annotation?.x || 0, y: annotation?.y || 0 }, width, height);
    normalized.to = normalizePoint(annotation?.to || { x: (annotation?.x || 0) + (annotation?.width || 0), y: (annotation?.y || 0) + (annotation?.height || 0) }, width, height);
  }
  return type === "text" ? constrainTextAnnotation(normalized, { width, height }) : normalized;
}

export function addAnnotation(state, annotation) {
  const internalMaskStroke = annotation.type === "mask" && annotation.operation === "erase";
  return { ...state, annotations: [...state.annotations, annotation], selectedAnnotationId: internalMaskStroke ? null : annotation.id };
}

export function updateAnnotation(state, id, patch) {
  return {
    ...state,
    annotations: state.annotations.map((item) => {
      if (item.id !== id) return item;
      const updated = { ...item, ...patch };
      return updated.type === "text"
        ? constrainTextAnnotation(updated, { width: state.image?.width, height: state.image?.height })
        : updated;
    }),
    selectedAnnotationId: id,
  };
}

export function hasMaskPaintStroke(annotations, mode) {
  return annotations.some((item) => item.type === "mask"
    && item.mode === mode
    && (item.operation || "paint") === "paint");
}

export function resolveMaskOperation(annotations, mode, operation) {
  return operation === "erase" && !hasMaskPaintStroke(annotations, mode) ? "paint" : operation;
}

export function normalizeMaskOperationState(state) {
  const source = Array.isArray(state.annotations) ? state.annotations : [];
  const paintedModes = new Set();
  const annotations = source.filter((item) => {
    if (item.type !== "mask") return true;
    if ((item.operation || "paint") === "paint") {
      paintedModes.add(item.mode);
      return true;
    }
    return paintedModes.has(item.mode);
  });
  const annotationsChanged = annotations.length !== source.length;
  const operation = resolveMaskOperation(annotations, state.maskMode, state.maskOperation);
  if (!annotationsChanged && operation === state.maskOperation) return state;
  const retainedIds = annotationsChanged ? new Set(annotations.map((item) => item.id)) : null;
  return {
    ...state,
    annotations,
    maskOperation: operation,
    ...(retainedIds && state.selectedAnnotationId && !retainedIds.has(state.selectedAnnotationId) ? { selectedAnnotationId: null } : {}),
    ...(retainedIds && state.editingTextAnnotationId && !retainedIds.has(state.editingTextAnnotationId) ? { editingTextAnnotationId: null } : {}),
  };
}

export function removeAnnotation(state, id) {
  return normalizeMaskOperationState({
    ...state,
    annotations: state.annotations.filter((item) => item.id !== id),
    selectedAnnotationId: state.selectedAnnotationId === id ? null : state.selectedAnnotationId,
    editingTextAnnotationId: state.editingTextAnnotationId === id ? null : state.editingTextAnnotationId,
  });
}

export function translateAnnotation(annotation, deltaX, deltaY, viewport = {}) {
  const points = annotationBoundsPoints(annotation, viewport);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const dx = Math.max(-Math.min(...xs), Math.min(1 - Math.max(...xs), Number(deltaX) || 0));
  const dy = Math.max(-Math.min(...ys), Math.min(1 - Math.max(...ys), Number(deltaY) || 0));
  const shiftPoint = (point) => ({
    x: roundCoordinate(clamp(point.x + dx)),
    y: roundCoordinate(clamp(point.y + dy)),
  });
  return {
    ...annotation,
    x: roundCoordinate(clamp(annotation.x + dx)),
    y: roundCoordinate(clamp(annotation.y + dy)),
    points: annotation.points.map(shiftPoint),
    ...(annotation.from ? { from: shiftPoint(annotation.from) } : {}),
    ...(annotation.to ? { to: shiftPoint(annotation.to) } : {}),
  };
}

export function toMcpAnnotationItems(state) {
  return state.annotations.map((item) => {
    const style = {
      color: normalizeColor(item.color),
      strokeWidth: normalizeStrokeWidth(item.strokeWidth),
    };
    if (item.type === "arrow") {
      return {
        id: item.id,
        type: "arrow",
        from: item.from || { x: item.x, y: item.y },
        to: item.to || { x: roundCoordinate(clamp(item.x + item.width)), y: roundCoordinate(clamp(item.y + item.height)) },
        ...(item.text ? { text: item.text } : {}),
        ...style,
      };
    }
    if (item.type === "text") {
      return { id: item.id, type: "text", x: item.x, y: item.y, text: item.text || "标注文字", ...style };
    }
    if (item.type === "rectangle") {
      return {
        id: item.id,
        type: "rectangle",
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        ...(item.text ? { text: item.text } : {}),
        ...style,
      };
    }
    if (item.type === "mask") {
      return {
        id: item.id,
        type: "mask",
        mode: normalizeMaskMode(item.mode),
        operation: normalizeMaskOperation(item.operation),
        brushRadius: normalizeMaskBrushRadius(item.brushRadius),
        points: item.points.length > 1 ? item.points : rectanglePoints(item),
        ...(item.text ? { text: item.text } : {}),
        color: style.color,
      };
    }
    return {
      id: item.id,
      type: "pen",
      points: item.points,
      ...(item.text ? { text: item.text } : {}),
      ...style,
    };
  });
}

export function serializeSubmission(state, prompt = state.prompt) {
  const cleanPrompt = String(prompt || "").trim();
  return {
    imageId: state.image.id,
    parentImageId: state.image.parentIds?.[0] || null,
    annotationId: null,
    annotations: state.annotations.map((item) => ({ ...item })),
    items: toMcpAnnotationItems(state),
    prompt: cleanPrompt,
    preview: {
      mimeType: "image/svg+xml",
      data: buildAnnotationPreview(state),
    },
  };
}

function rectanglePoints(item) {
  return [
    { x: item.x, y: item.y },
    { x: clamp(item.x + item.width), y: item.y },
    { x: clamp(item.x + item.width), y: clamp(item.y + item.height) },
    { x: item.x, y: clamp(item.y + item.height) },
    { x: item.x, y: item.y },
  ];
}

function annotationBoundsPoints(item, viewport) {
  const points = [
    { x: item.x, y: item.y },
    { x: clamp(item.x + item.width), y: clamp(item.y + item.height) },
    ...(item.points || []),
  ];
  if (item.type === "text") {
    const bounds = textAnnotationBounds(item, { width: viewport.viewportWidth, height: viewport.viewportHeight });
    points.push({ x: bounds.left, y: bounds.top }, { x: bounds.right, y: bounds.bottom });
  }
  if (item.from) points.push(item.from);
  if (item.to) points.push(item.to);
  return points;
}

export function buildAnnotationPreview(state) {
  const imageHref = state.image.data ? `data:${state.image.mimeType || "image/png"};base64,${state.image.data}` : "";
  const imageNode = imageHref ? `<image href="${escapeXml(imageHref)}" width="100%" height="100%" preserveAspectRatio="none"/>` : "";
  const viewBox = annotationViewBox(state.image);
  const annotations = annotationLayerMarkup(state.annotations, null, state.image);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBox.width} ${viewBox.height}" preserveAspectRatio="none" role="img">${imageNode}${annotations}</svg>`;
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function roundCoordinate(value) {
  return Math.round(value * 1e6) / 1e6;
}

function normalizePoint(point, width, height) {
  return {
    x: roundCoordinate(clamp(Number(point?.x || 0) / width)),
    y: roundCoordinate(clamp(Number(point?.y || 0) / height)),
  };
}

function normalizeColor(value, fallback = "#ef4444") {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

function normalizeStrokeWidth(value) {
  const width = Number(value);
  return Math.max(1, Math.min(12, Number.isFinite(width) ? width : 5));
}

function normalizeMaskMode(value) {
  if (value !== "edit" && value !== "protect") throw new Error("mask mode must be edit or protect");
  return value;
}

function normalizeMaskOperation(value = "paint") {
  if (value !== "paint" && value !== "erase") throw new Error("mask operation must be paint or erase");
  return value;
}

function normalizeMaskBrushRadius(value) {
  const radius = Number(value);
  if (!Number.isFinite(radius) || radius <= 0 || radius > 0.5) {
    throw new Error("mask brushRadius must be greater than 0 and at most 0.5");
  }
  return radius;
}

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[character]));
}
