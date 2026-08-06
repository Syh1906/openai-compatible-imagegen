const ANNOTATION_TYPES = new Set(["select", "pen", "arrow", "rectangle", "text", "eraser", "mask"]);

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
    color: "#ef4444",
    strokeWidth: 5,
    annotationVisible: true,
    zoom: 1,
    prompt: "",
  };
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
  if (type === "arrow") {
    normalized.from = normalizePoint(annotation?.from || { x: annotation?.x || 0, y: annotation?.y || 0 }, width, height);
    normalized.to = normalizePoint(annotation?.to || { x: (annotation?.x || 0) + (annotation?.width || 0), y: (annotation?.y || 0) + (annotation?.height || 0) }, width, height);
  }
  return normalized;
}

export function addAnnotation(state, annotation) {
  return { ...state, annotations: [...state.annotations, annotation], selectedAnnotationId: annotation.id };
}

export function updateAnnotation(state, id, patch) {
  return {
    ...state,
    annotations: state.annotations.map((item) => item.id === id ? { ...item, ...patch } : item),
    selectedAnnotationId: id,
  };
}

export function removeAnnotation(state, id) {
  return {
    ...state,
    annotations: state.annotations.filter((item) => item.id !== id),
    selectedAnnotationId: state.selectedAnnotationId === id ? null : state.selectedAnnotationId,
  };
}

export function translateAnnotation(annotation, deltaX, deltaY) {
  const points = annotationBoundsPoints(annotation);
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
        points: item.points.length > 1 ? item.points : rectanglePoints(item),
        ...(item.text ? { text: item.text } : {}),
        ...style,
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

function annotationBoundsPoints(item) {
  const points = [
    { x: item.x, y: item.y },
    { x: clamp(item.x + item.width), y: clamp(item.y + item.height) },
    ...(item.points || []),
  ];
  if (item.from) points.push(item.from);
  if (item.to) points.push(item.to);
  return points;
}

export function buildAnnotationPreview(state) {
  const imageHref = state.image.data ? `data:${state.image.mimeType || "image/png"};base64,${state.image.data}` : "";
  const imageNode = imageHref ? `<image href="${escapeXml(imageHref)}" width="100%" height="100%" preserveAspectRatio="none"/>` : "";
  const annotations = state.annotations.map((item, index) => annotationSvg(item, index)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" preserveAspectRatio="none" role="img">${imageNode}${annotations}</svg>`;
}

function annotationSvg(item, index) {
  const x = item.x * 1000;
  const y = item.y * 1000;
  const width = item.width * 1000;
  const height = item.height * 1000;
  const color = escapeXml(item.color || "#ef4444");
  const strokeWidth = item.strokeWidth || 5;
  let shape = "";
  if (item.type === "rectangle") shape = `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"/>`;
  if (item.type === "arrow") {
    const from = item.from || { x: item.x, y: item.y };
    const to = item.to || { x: item.x + item.width, y: item.y + item.height };
    const markerId = `arrowhead-${String(item.id || "annotation").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    shape = `<path d="M ${from.x * 1000} ${from.y * 1000} L ${to.x * 1000} ${to.y * 1000}" stroke="${color}" stroke-width="${strokeWidth}" fill="none" marker-end="url(#${markerId})"/><defs><marker id="${markerId}" markerWidth="12" markerHeight="12" refX="9" refY="4" orient="auto"><path d="M 0 0 L 10 4 L 0 8 z" fill="${color}"/></marker></defs>`;
  }
  if (item.type === "text") shape = `<text x="${x}" y="${y}" fill="${color}" font-size="28" font-family="sans-serif" font-weight="700">${escapeXml(item.text || "标注")}</text>`;
  if (!shape && item.points.length > 1) {
    const effectiveStrokeWidth = item.type === "mask" ? Math.max(24, strokeWidth * 5) : strokeWidth;
    const opacity = item.type === "mask" ? "0.35" : "1";
    shape = `<polyline points="${item.points.map((point) => `${point.x * 1000},${point.y * 1000}`).join(" ")}" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${effectiveStrokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return shape ? `${shape}${annotationIndex(item, index)}` : "";
}

function annotationIndex(item, index) {
  const anchor = annotationAnchor(item);
  const x = Math.max(18, Math.min(982, anchor.x * 1000));
  const y = Math.max(18, Math.min(982, anchor.y * 1000));
  return `<g class="annotation-index"><circle cx="${x}" cy="${y}" r="14" fill="#ffffff" stroke="#17191d" stroke-width="2"/><text x="${x}" y="${y + 6}" fill="#17191d" font-size="18" font-family="sans-serif" font-weight="700" text-anchor="middle">${index + 1}</text></g>`;
}

function annotationAnchor(item) {
  if (item.type === "arrow" && item.from) return item.from;
  if ((item.type === "pen" || item.type === "mask") && item.points.length) return item.points[0];
  if (item.type === "text") return { x: item.x - 0.02, y: item.y - 0.03 };
  return { x: item.x, y: item.y };
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

function normalizeColor(value) {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#ef4444";
}

function normalizeStrokeWidth(value) {
  const width = Number(value);
  return Math.max(1, Math.min(12, Number.isFinite(width) ? width : 5));
}

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[character]));
}
