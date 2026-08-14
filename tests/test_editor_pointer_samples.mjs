import assert from "node:assert/strict";
import test from "node:test";

import {
  appendDrawingPointerSamples,
  createDrawingPointerInteraction,
  finishDrawingPointerInteraction,
  pointerSamplesFromEvent,
} from "../web/editor-pointer-samples.mjs";


test("coalesced pointer samples retain source order and the dispatched endpoint", () => {
  const target = {};
  const samples = pointerSamplesFromEvent({
    currentTarget: target,
    clientX: 40,
    clientY: 50,
    getCoalescedEvents: () => [
      { clientX: 10, clientY: 20 },
      { clientX: 30, clientY: 40 },
    ],
  });
  assert.deepEqual(samples, [
    { target, clientX: 10, clientY: 20 },
    { target, clientX: 30, clientY: 40 },
    { target, clientX: 40, clientY: 50 },
  ]);
});

test("drawing pointer collection retains a released endpoint not seen during move", () => {
  const interaction = createInteraction({ x: 10, y: 10 });
  const rect = viewportRect();
  appendDrawingPointerSamples(interaction, [{ clientX: 10.25, clientY: 10.25 }], rect);
  finishDrawingPointerInteraction(interaction, { clientX: 11, clientY: 11 }, rect);
  assert.deepEqual(interaction.points, [
    { x: 10, y: 10 },
    { x: 10.25, y: 10.25 },
    { x: 11, y: 11 },
  ]);
});

test("drawing pointer collection retains a duplicate endpoint for a mask dab", () => {
  const interaction = createInteraction({ x: 10, y: 10 });
  finishDrawingPointerInteraction(
    interaction,
    { clientX: 10, clientY: 10 },
    viewportRect(),
    { retainDab: true },
  );
  assert.deepEqual(interaction.points, [{ x: 10, y: 10 }, { x: 10, y: 10 }]);
});

test("drawing pointer collection preserves a sharp source-path corner", () => {
  const interaction = createInteraction({ x: 0, y: 0 });
  const rect = viewportRect();
  appendDrawingPointerSamples(interaction, [
    { clientX: 10, clientY: 0 },
    { clientX: 10, clientY: 10 },
  ], rect);
  finishDrawingPointerInteraction(interaction, { clientX: 10, clientY: 10 }, rect);
  assert.deepEqual(interaction.points, [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ]);
});

function createInteraction(start) {
  return createDrawingPointerInteraction({ start, pointerId: 1, target: {} });
}

function viewportRect() {
  return { left: 0, top: 0, width: 100, height: 100 };
}
