import assert from "node:assert/strict";
import test from "node:test";

import { annotationOverlay, hitTestAnnotation } from "../web/editor-annotation-view.mjs";


test("annotation overlay escapes text and keeps a selected index marker", () => {
  const overlay = annotationOverlay({
    id: "annotation_<unsafe>",
    type: "text",
    x: 0.2,
    y: 0.3,
    width: 0,
    height: 0,
    points: [],
    text: "<script>alert(1)</script>",
    color: "#ef4444",
    strokeWidth: 5,
  }, 1, true);

  assert.doesNotMatch(overlay, /<script>/);
  assert.match(overlay, /&lt;script&gt;/);
  assert.match(overlay, /annotation-index selected/);
  assert.match(overlay, />2<\/text>/);
});

test("precise hit testing follows a freeform stroke instead of its bounding box", () => {
  const annotation = {
    id: "annotation_1",
    type: "pen",
    x: 0.1,
    y: 0.1,
    width: 0.8,
    height: 0.8,
    points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
  };
  const rect = { width: 1000, height: 1000 };

  assert.equal(hitTestAnnotation([annotation], { x: 150, y: 150 }, rect, true)?.id, annotation.id);
  assert.equal(hitTestAnnotation([annotation], { x: 700, y: 700 }, rect, true), null);
  assert.equal(hitTestAnnotation([annotation], { x: 700, y: 700 }, rect, false)?.id, annotation.id);
});
