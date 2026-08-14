export function computeCanvasGeometry({
  availableWidth,
  availableHeight,
  imageWidth,
  imageHeight,
  zoom = 1,
}) {
  const values = [availableWidth, availableHeight, imageWidth, imageHeight, zoom].map(Number);
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("canvas measurements must be positive finite numbers");
  }
  const [viewportWidth, viewportHeight, sourceWidth, sourceHeight, scale] = values;
  const aspectRatio = sourceWidth / sourceHeight;
  const fitWidth = Math.min(viewportWidth, viewportHeight * aspectRatio);
  const fitHeight = fitWidth / aspectRatio;
  return {
    fitWidth,
    fitHeight,
    width: fitWidth * scale,
    height: fitHeight * scale,
  };
}

export function computeAnchoredPanelPosition({
  anchor,
  panel,
  viewportWidth,
  viewportHeight,
  gap = 8,
  margin = 8,
}) {
  const values = [anchor?.left, anchor?.right, anchor?.top, anchor?.bottom, panel?.width, panel?.height, viewportWidth, viewportHeight, gap, margin].map(Number);
  if (values.some((value) => !Number.isFinite(value)) || panel.width <= 0 || panel.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    throw new Error("panel measurements must be finite and panel dimensions must be positive");
  }
  const rightCandidate = anchor.right + gap;
  const leftCandidate = anchor.left - gap - panel.width;
  const rightFits = rightCandidate + panel.width <= viewportWidth - margin;
  const leftFits = leftCandidate >= margin;
  const placement = rightFits || !leftFits ? "right" : "left";
  const preferredLeft = placement === "right" ? rightCandidate : leftCandidate;
  const maximumLeft = Math.max(margin, viewportWidth - panel.width - margin);
  const left = clamp(preferredLeft, margin, maximumLeft);
  const anchorCenterY = (anchor.top + anchor.bottom) / 2;
  const maximumTop = Math.max(margin, viewportHeight - panel.height - margin);
  const top = clamp(anchorCenterY - panel.height / 2, margin, maximumTop);
  const anchorInset = Math.min(12, panel.height / 2);
  const anchorY = clamp(anchorCenterY - top, anchorInset, panel.height - anchorInset);
  return { left, top, placement, anchorY };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
