export function pointerSamplesFromEvent(event) {
  const coalesced = typeof event.getCoalescedEvents === "function"
    ? event.getCoalescedEvents()
    : [];
  const events = Array.isArray(coalesced) ? [...coalesced] : [];
  const latest = events.at(-1);
  if (!latest || latest.clientX !== event.clientX || latest.clientY !== event.clientY) events.push(event);
  return events.map((sample) => ({
    target: event.currentTarget,
    clientX: sample.clientX,
    clientY: sample.clientY,
  }));
}

export function pointerPositionFromSample(sample, rect) {
  return {
    x: (sample.clientX - rect.left) / Math.max(1, rect.width),
    y: (sample.clientY - rect.top) / Math.max(1, rect.height),
  };
}

export function createDrawingPointerInteraction({ start, pointerId, target }) {
  requirePoint(start, "drawing pointer start");
  return {
    start,
    current: start,
    points: [start],
    pointerId,
    target,
  };
}

export function appendDrawingPointerSamples(interaction, samples, rect) {
  requirePositive(rect?.width, "pointer viewport width");
  requirePositive(rect?.height, "pointer viewport height");
  for (const sample of samples) {
    const point = { x: sample.clientX - rect.left, y: sample.clientY - rect.top };
    interaction.current = point;
    interaction.points.push(point);
  }
  return interaction.points;
}

export function finishDrawingPointerInteraction(interaction, event, rect, { retainDab = false } = {}) {
  const end = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  const lastPoint = interaction.points.at(-1);
  if (!lastPoint || lastPoint.x !== end.x || lastPoint.y !== end.y || (retainDab && interaction.points.length === 1)) {
    interaction.points.push(end);
  }
  interaction.current = end;
  return { start: interaction.start, end, points: interaction.points };
}

export function advanceMovePointerInteraction(interaction, current, rect) {
  if (!interaction.dragging && !hasPointerMovedBeyondThreshold(interaction.start, current, rect)) return null;
  interaction.dragging = true;
  interaction.current = current;
  return { x: current.x - interaction.start.x, y: current.y - interaction.start.y };
}

export function hasPointerMovedBeyondThreshold(start, current, rect, thresholdPx = 4) {
  return Math.hypot(
    (current.x - start.x) * rect.width,
    (current.y - start.y) * rect.height,
  ) >= thresholdPx;
}

export function hasPointerPathMoved(points, thresholdPx = 3) {
  const start = points?.[0];
  if (!start) return false;
  return points.slice(1).some((point) => Math.hypot(point.x - start.x, point.y - start.y) >= thresholdPx);
}

function requirePoint(value, label) {
  if (!Number.isFinite(value?.x) || !Number.isFinite(value?.y)) throw new Error(`${label} must be finite`);
}

function requirePositive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be positive`);
  return number;
}
