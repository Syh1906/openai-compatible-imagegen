import assert from "node:assert/strict";
import test from "node:test";

import { computeAnchoredPanelPosition, computeCanvasGeometry } from "../../web/editor-layout.mjs";


test("fit geometry contains landscape, portrait, and square images", () => {
  assert.deepEqual(
    computeCanvasGeometry({ availableWidth: 1000, availableHeight: 600, imageWidth: 1600, imageHeight: 900 }),
    { fitWidth: 1000, fitHeight: 562.5, width: 1000, height: 562.5 },
  );
  assert.deepEqual(
    computeCanvasGeometry({ availableWidth: 1000, availableHeight: 600, imageWidth: 800, imageHeight: 1200 }),
    { fitWidth: 400, fitHeight: 600, width: 400, height: 600 },
  );
  assert.deepEqual(
    computeCanvasGeometry({ availableWidth: 1000, availableHeight: 600, imageWidth: 800, imageHeight: 800 }),
    { fitWidth: 600, fitHeight: 600, width: 600, height: 600 },
  );
});

test("zoom scales both canvas axes from one stable fit coordinate space", () => {
  assert.deepEqual(
    computeCanvasGeometry({ availableWidth: 1000, availableHeight: 600, imageWidth: 1600, imageHeight: 900, zoom: 1.5 }),
    { fitWidth: 1000, fitHeight: 562.5, width: 1500, height: 843.75 },
  );
});

test("fit geometry rejects non-positive measurements instead of inventing a canvas", () => {
  assert.throws(
    () => computeCanvasGeometry({ availableWidth: 0, availableHeight: 600, imageWidth: 1600, imageHeight: 900 }),
    /positive/,
  );
});

test("anchored panels stay beside their trigger while clamping to the viewport", () => {
  assert.deepEqual(
    computeAnchoredPanelPosition({
      anchor: { left: 20, right: 60, top: 500, bottom: 540, width: 40, height: 40 },
      panel: { width: 260, height: 320 },
      viewportWidth: 800,
      viewportHeight: 700,
    }),
    { left: 68, top: 360, placement: "right", anchorY: 160 },
  );

  assert.deepEqual(
    computeAnchoredPanelPosition({
      anchor: { left: 750, right: 790, top: 650, bottom: 690, width: 40, height: 40 },
      panel: { width: 260, height: 320 },
      viewportWidth: 800,
      viewportHeight: 700,
    }),
    { left: 482, top: 372, placement: "left", anchorY: 298 },
  );
});
