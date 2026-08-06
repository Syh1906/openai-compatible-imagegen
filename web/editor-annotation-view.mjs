export function annotationOverlay(item, index, selected = false) {
  const x = item.x * 1000;
  const y = item.y * 1000;
  const width = item.width * 1000;
  const height = item.height * 1000;
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
    shape = `<line x1="${from.x * 1000}" y1="${from.y * 1000}" x2="${to.x * 1000}" y2="${to.y * 1000}" stroke="${color}" stroke-width="${strokeWidth}" marker-end="url(#${markerId})"/><defs><marker id="${markerId}" markerWidth="12" markerHeight="12" refX="9" refY="4" orient="auto"><path d="M 0 0 L 10 4 L 0 8 z" fill="${color}"/></marker></defs>`;
  }
  if (item.type === "text") {
    shape = `<text x="${x}" y="${y}" fill="${color}" font-size="30" font-family="sans-serif" font-weight="700">${escapeHtml(item.text || "标注文字")}</text>`;
  }
  if (!shape && points.length > 1) {
    const effectiveStrokeWidth = item.type === "mask" ? Math.max(24, strokeWidth * 5) : strokeWidth;
    const opacity = item.type === "mask" ? "0.35" : "1";
    shape = `<polyline points="${points.map((point) => `${point.x * 1000},${point.y * 1000}`).join(" ")}" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${effectiveStrokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return shape ? `${shape}${annotationIndexOverlay(item, index, selected)}` : "";
}

export function hitTestAnnotation(annotations, point, rect, precise = false) {
  const x = Math.max(0, Math.min(1, point.x / Math.max(1, rect.width)));
  const y = Math.max(0, Math.min(1, point.y / Math.max(1, rect.height)));
  return [...annotations].reverse().find((item) => {
    if (precise && item.type === "arrow") {
      const from = item.from || { x: item.x, y: item.y };
      const to = item.to || { x: item.x + item.width, y: item.y + item.height };
      return distanceToSegment({ x, y }, from, to) < 0.035;
    }
    if (item.type === "pen" || item.type === "mask") {
      const nearStroke = (item.points || []).some((strokePoint, index) => {
        if (index === 0) return Math.hypot(strokePoint.x - x, strokePoint.y - y) < 0.04;
        return distanceToSegment({ x, y }, item.points[index - 1], strokePoint) < 0.04;
      });
      return nearStroke || (!precise && inBounds(item, x, y));
    }
    return inBounds(item, x, y);
  }) || null;
}

export function escapeHtml(value) {
  return String(value).replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[character]));
}

export function labelFor(type) {
  return { arrow: "箭头指引", rectangle: "区域调整", text: "文字要求", mask: "遮罩意图", pen: "画笔标注" }[type] || "修改区域";
}

export function summaryFor(type) {
  return { arrow: "请关注箭头指向的位置", rectangle: "请调整框选区域", text: "请按文字说明处理", mask: "请重新生成该区域", pen: "请参考笔触范围" }[type] || "已添加修改标注";
}

function annotationIndexOverlay(item, index, selected) {
  const points = item.points || [];
  const anchor = item.type === "arrow" && item.to
    ? item.from
    : (item.type === "pen" || item.type === "mask") && points.length
      ? points[0]
      : item.type === "text"
        ? { x: item.x - 0.02, y: item.y - 0.03 }
        : { x: item.x, y: item.y };
  const x = Math.max(18, Math.min(982, anchor.x * 1000));
  const y = Math.max(18, Math.min(982, anchor.y * 1000));
  return `<g class="annotation-index${selected ? " selected" : ""}"><circle cx="${x}" cy="${y}" r="${selected ? 17 : 14}" fill="${selected ? "#15966f" : "#ffffff"}" stroke="${selected ? "#ffffff" : "#17191d"}" stroke-width="${selected ? 4 : 2}"/><text x="${x}" y="${y + 6}" fill="${selected ? "#ffffff" : "#17191d"}" font-size="18" font-family="sans-serif" font-weight="700" text-anchor="middle">${index + 1}</text></g>`;
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
