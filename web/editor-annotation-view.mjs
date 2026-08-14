import { textAnnotationBounds, textAnnotationLayout } from "./editor-text-geometry.mjs";

export function annotationLayerMarkup(items, selectedAnnotationId, dimensions, editingTextAnnotationId = null) {
  const viewBox = annotationViewBox(dimensions);
  const entries = items.map((item) => ({ item }));
  const maskEntries = entries.filter(({ item }) => item.type === "mask");
  const visibleEntries = entries.filter(({ item }) => isUserFacingAnnotation(item)).map(({ item }, index) => ({ item, index }));
  const masks = ["edit", "protect"]
    .map((mode) => maskCompositeOverlay(maskEntries, mode, viewBox))
    .join("");
  const ordinary = visibleEntries.map(({ item, index }) => item.type === "mask"
    ? ""
    : annotationOverlay(
      item,
      index,
      item.id === selectedAnnotationId,
      dimensions,
      { editing: item.id === editingTextAnnotationId },
    )).join("");
  const maskAdornments = visibleEntries.filter(({ item }) => item.type === "mask").map(({ item, index }) => maskAnnotationAdornment(
    item,
    index,
    item.id === selectedAnnotationId,
    viewBox,
  )).join("");
  return `${masks}${ordinary}${maskAdornments}`;
}

export function annotationOverlay(item, index, selected = false, dimensions, { editing = false } = {}) {
  const viewBox = annotationViewBox(dimensions);
  const x = item.x * viewBox.width;
  const y = item.y * viewBox.height;
  const width = item.width * viewBox.width;
  const height = item.height * viewBox.height;
  const color = item.color || "#ef4444";
  const strokeWidth = item.strokeWidth || 5;
  const points = item.points || [];
  let shape = "";
  if (item.type === "rectangle") {
    shape = `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"/>`;
  }
  if (item.type === "arrow") {
    const from = item.from || { x: item.x, y: item.y };
    const to = item.to || { x: item.x + item.width, y: item.y + item.height };
    const markerId = `arrowhead-${String(item.id || "preview").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    shape = `<line x1="${from.x * viewBox.width}" y1="${from.y * viewBox.height}" x2="${to.x * viewBox.width}" y2="${to.y * viewBox.height}" stroke="${color}" stroke-width="${strokeWidth}" marker-end="url(#${markerId})"/><defs><marker id="${markerId}" markerWidth="12" markerHeight="12" refX="9" refY="4" orient="auto"><path d="M 0 0 L 10 4 L 0 8 z" fill="${color}"/></marker></defs>`;
  }
  if (item.type === "text") {
    const layout = textAnnotationLayout(item, viewBox);
    if (editing) {
      const editorY = Math.max(0, y - layout.ascentPx - 4);
      const editorWidth = Math.max(120, Math.min(viewBox.width - x, layout.widthPx + 36));
      shape = `<foreignObject x="${x}" y="${editorY}" width="${editorWidth}" height="48"><input xmlns="http://www.w3.org/1999/xhtml" class="canvas-text-editor" data-canvas-text-editor="${escapeHtml(item.id)}" value="${escapeHtml(item.text || "标注文字")}" maxlength="600" aria-label="编辑画布文字" style="--canvas-text-color:${escapeHtml(color)}"/></foreignObject>`;
    } else {
      const lines = layout.lines.map((line, lineIndex) => `<tspan x="${x}" dy="${lineIndex ? layout.lineHeightPx : 0}">${escapeHtml(line)}</tspan>`).join("");
      shape = `<text x="${x}" y="${y}" fill="${color}" font-size="30" font-family="sans-serif" font-weight="700">${lines}</text>`;
    }
  }
  if (!shape && points.length > 1) {
    const effectiveStrokeWidth = item.type === "mask"
      ? (Number.isFinite(item.brushRadius) ? item.brushRadius * 2000 : Math.max(24, strokeWidth * 5))
      : strokeWidth;
    const opacity = item.type === "mask" ? "0.35" : "1";
    shape = `<polyline points="${pointsMarkup(points, viewBox)}" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${effectiveStrokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (!shape) return "";
  const visibleShape = item.type === "mask" || editing
    ? shape
    : `<g class="annotation-mark" data-contrast-outline="true" style="filter:drop-shadow(0 0 1px #ffffff) drop-shadow(0 0 1px #17191d)">${shape}</g>`;
  return `${visibleShape}${annotationIndexOverlay(item, index, selected, viewBox)}`;
}

export function hitTestAnnotation(annotations, point, rect, precise = false) {
  const x = Math.max(0, Math.min(1, point.x / Math.max(1, rect.width)));
  const y = Math.max(0, Math.min(1, point.y / Math.max(1, rect.height)));
  const selectable = annotations.filter(isUserFacingAnnotation);
  const hitOrder = [
    ...selectable.filter((item) => item.type !== "mask").reverse(),
    ...selectable.filter((item) => item.type === "mask" && item.mode === "protect").reverse(),
    ...selectable.filter((item) => item.type === "mask" && item.mode === "edit").reverse(),
    ...selectable.filter((item) => item.type === "mask" && !["edit", "protect"].includes(item.mode)).reverse(),
  ];
  return hitOrder.find((item) => {
    if (precise && item.type === "arrow") {
      const from = item.from || { x: item.x, y: item.y };
      const to = item.to || { x: item.x + item.width, y: item.y + item.height };
      return distanceToSegment({ x, y }, from, to) < 0.035;
    }
    if (item.type === "mask") {
      const shortEdge = Math.min(Math.max(1, rect.width), Math.max(1, rect.height));
      const hitRadius = (Number.isFinite(item.brushRadius) ? item.brushRadius : 0.04) * shortEdge;
      const canvasPoint = { x: x * rect.width, y: y * rect.height };
      return (item.points || []).some((strokePoint, index) => {
        const current = { x: strokePoint.x * rect.width, y: strokePoint.y * rect.height };
        if (index === 0) return Math.hypot(current.x - canvasPoint.x, current.y - canvasPoint.y) < hitRadius;
        const previous = item.points[index - 1];
        return distanceToSegment(
          canvasPoint,
          { x: previous.x * rect.width, y: previous.y * rect.height },
          current,
        ) < hitRadius;
      });
    }
    if (item.type === "pen") {
      const hitRadius = 0.04;
      const nearStroke = (item.points || []).some((strokePoint, index) => {
        if (index === 0) return Math.hypot(strokePoint.x - x, strokePoint.y - y) < hitRadius;
        return distanceToSegment({ x, y }, item.points[index - 1], strokePoint) < hitRadius;
      });
      return nearStroke || (item.type === "pen" && !precise && inBounds(item, x, y));
    }
    if (item.type === "text") return inTextBounds(item, x, y, rect);
    return inBounds(item, x, y);
  }) || null;
}

export function annotationViewBox(dimensions) {
  const sourceWidth = Number.isFinite(dimensions?.width) && dimensions.width > 0 ? dimensions.width : 1;
  const sourceHeight = Number.isFinite(dimensions?.height) && dimensions.height > 0 ? dimensions.height : 1;
  const scale = 1000 / Math.min(sourceWidth, sourceHeight);
  return { width: sourceWidth * scale, height: sourceHeight * scale };
}

export function maskColor(mode) {
  return mode === "protect" ? "#2563eb" : "#ef4444";
}

export function isUserFacingAnnotation(item) {
  return item?.type !== "mask" || item.operation !== "erase";
}

export function escapeHtml(value) {
  return String(value).replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[character]));
}

export function labelFor(typeOrItem, mode) {
  const type = typeof typeOrItem === "string" ? typeOrItem : typeOrItem?.type;
  const resolvedMode = typeof typeOrItem === "string" ? mode : typeOrItem?.mode;
  const operation = typeof typeOrItem === "string" ? "paint" : typeOrItem?.operation;
  if (type === "mask" && operation === "erase") return resolvedMode === "protect" ? "擦除保护内容蒙版" : "擦除改图蒙版";
  if (type === "mask") return resolvedMode === "protect" ? "保护内容" : "改图区域";
  return { arrow: "箭头指引", rectangle: "区域调整", text: "文字要求", pen: "画笔标注" }[type] || "修改区域";
}

export function summaryFor(typeOrItem, mode) {
  const type = typeof typeOrItem === "string" ? typeOrItem : typeOrItem?.type;
  const resolvedMode = typeof typeOrItem === "string" ? mode : typeOrItem?.mode;
  const operation = typeof typeOrItem === "string" ? "paint" : typeOrItem?.operation;
  if (type === "mask" && operation === "erase") return resolvedMode === "protect" ? "局部移除保护内容蒙版" : "局部移除改图区域蒙版";
  if (type === "mask") return resolvedMode === "protect"
    ? "保留该内容的身份、形状、文字和纹理，允许光影自然适配"
    : "只允许模型修改该区域";
  return { arrow: "请关注箭头指向的位置", rectangle: "请调整框选区域", text: "请按文字说明处理", pen: "请参考笔触范围" }[type] || "已添加修改标注";
}

function annotationIndexOverlay(item, index, selected, viewBox) {
  const points = item.points || [];
  const anchor = item.type === "arrow" && item.to
    ? item.from
    : (item.type === "pen" || item.type === "mask") && points.length
      ? points[0]
      : item.type === "text"
        ? { x: item.x - 0.02, y: item.y - 0.03 }
        : { x: item.x, y: item.y };
  const x = Math.max(18, Math.min(viewBox.width - 18, anchor.x * viewBox.width));
  const y = Math.max(18, Math.min(viewBox.height - 18, anchor.y * viewBox.height));
  return `<g class="annotation-index${selected ? " selected" : ""}"><circle cx="${x}" cy="${y}" r="${selected ? 17 : 14}" fill="${selected ? "#15966f" : "#ffffff"}" stroke="${selected ? "#ffffff" : "#17191d"}" stroke-width="${selected ? 4 : 2}"/><text x="${x}" y="${y + 6}" fill="${selected ? "#ffffff" : "#17191d"}" font-size="18" font-family="sans-serif" font-weight="700" text-anchor="middle">${index + 1}</text></g>`;
}

function maskCompositeOverlay(entries, mode, viewBox) {
  const strokes = entries.filter(({ item }) => item.mode === mode);
  if (!strokes.length) return "";
  const maskId = `annotation-mask-${mode}`;
  const strokeMarkup = strokes.map(({ item }) => {
    const width = maskStrokeWidth(item);
    const color = item.operation === "erase" ? "#000000" : "#ffffff";
    return `<polyline data-mask-operation="${item.operation || "paint"}" points="${pointsMarkup(item.points || [], viewBox)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join("");
  const fill = mode === "protect" ? "#2563eb" : "#ef4444";
  return `<defs><mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${viewBox.width}" height="${viewBox.height}"><rect width="${viewBox.width}" height="${viewBox.height}" fill="#000000"/>${strokeMarkup}</mask></defs><rect data-mask-layer="${mode}" x="0" y="0" width="${viewBox.width}" height="${viewBox.height}" fill="${fill}" fill-opacity="0.35" mask="url(#${maskId})"/>`;
}

function maskAnnotationAdornment(item, index, selected, viewBox) {
  return annotationIndexOverlay(item, index, selected, viewBox);
}

function maskStrokeWidth(item) {
  return Number.isFinite(item.brushRadius) ? item.brushRadius * 2000 : Math.max(24, (item.strokeWidth || 5) * 5);
}

function pointsMarkup(points, viewBox) {
  return points.map((point) => `${point.x * viewBox.width},${point.y * viewBox.height}`).join(" ");
}

function distanceToSegment(point, start, end) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = (deltaX * deltaX) + (deltaY * deltaY);
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const position = Math.max(0, Math.min(1, (((point.x - start.x) * deltaX) + ((point.y - start.y) * deltaY)) / lengthSquared));
  return Math.hypot(point.x - (start.x + (position * deltaX)), point.y - (start.y + (position * deltaY)));
}

function inBounds(item, x, y) {
  return x >= item.x - 0.03 && x <= item.x + item.width + 0.03 && y >= item.y - 0.03 && y <= item.y + item.height + 0.03;
}

function inTextBounds(item, x, y, rect) {
  const bounds = textAnnotationBounds(item, rect);
  return x >= bounds.left - 0.01 && x <= bounds.right + 0.01 && y >= bounds.top - 0.01 && y <= bounds.bottom + 0.01;
}
