import assert from "node:assert/strict";
import test from "node:test";

import { annotationLayerMarkup, annotationOverlay, hitTestAnnotation, labelFor, summaryFor } from "../web/editor-annotation-view.mjs";


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
  assert.match(overlay, /data-contrast-outline="true"/);
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

test("mask modes stay continuous while keeping distinct intent language", () => {
  const base = {
    id: "mask_1",
    type: "mask",
    x: 0.1,
    y: 0.1,
    width: 0.2,
    height: 0.2,
    points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }],
    brushRadius: 0.035,
  };
  const editOverlay = annotationOverlay({ ...base, mode: "edit", color: "#ef4444" }, 0);
  const protectOverlay = annotationOverlay({ ...base, mode: "protect", color: "#2563eb" }, 1);

  assert.doesNotMatch(editOverlay, /stroke-dasharray=/);
  assert.doesNotMatch(protectOverlay, /stroke-dasharray=/);
  assert.equal(labelFor({ type: "mask", mode: "edit" }), "改图区域");
  assert.equal(labelFor({ type: "mask", mode: "protect" }), "保护内容");
  assert.equal(summaryFor({ type: "mask", mode: "edit" }), "只允许模型修改该区域");
  assert.equal(summaryFor({ type: "mask", mode: "protect" }), "保留该内容的身份、形状、文字和纹理，允许光影自然适配");
});

test("text hit testing follows the visible glyph area instead of only its anchor", () => {
  const text = {
    id: "text_1",
    type: "text",
    x: 0.2,
    y: 0.3,
    width: 0,
    height: 0,
    text: "保留标题",
  };
  const rect = { width: 1000, height: 1000 };

  assert.equal(hitTestAnnotation([text], { x: 270, y: 292 }, rect)?.id, text.id);
  assert.equal(hitTestAnnotation([text], { x: 380, y: 292 }, rect), null);
});

test("mask hit testing follows each visible brush radius", () => {
  const rect = { width: 1000, height: 1000 };
  for (const brushRadius of [0.02, 0.035, 0.06]) {
    const mask = {
      id: `mask_${brushRadius}`,
      type: "mask",
      x: 0.2,
      y: 0.5,
      width: 0.6,
      height: 0,
      points: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }],
      brushRadius,
    };
    assert.equal(
      hitTestAnnotation([mask], { x: 500, y: (0.5 + brushRadius * 0.9) * 1000 }, rect, true)?.id,
      mask.id,
    );
    assert.equal(
      hitTestAnnotation([mask], { x: 500, y: (0.5 + brushRadius * 1.1) * 1000 }, rect, true),
      null,
    );
  }
});

test("non-square mask preview and hit testing use the image short edge", () => {
  const mask = {
    id: "mask_wide",
    type: "mask",
    mode: "edit",
    color: "#ef4444",
    x: 0.25,
    y: 0.5,
    width: 0.5,
    height: 0,
    points: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }],
    brushRadius: 0.05,
  };

  const overlay = annotationOverlay(mask, 0, false, { width: 2000, height: 1000 });
  assert.match(overlay, /points="500,500 1500,500"/);
  assert.match(overlay, /stroke-width="100"/);

  const wideRect = { width: 1000, height: 500 };
  assert.equal(hitTestAnnotation([mask], { x: 500, y: 272 }, wideRect, true)?.id, mask.id);
  assert.equal(hitTestAnnotation([mask], { x: 500, y: 278 }, wideRect, true), null);
});

test("mask hit testing follows the visible protect-over-edit layer order", () => {
  const rect = { width: 1000, height: 1000 };
  const edit = {
    id: "mask_edit",
    type: "mask",
    mode: "edit",
    operation: "paint",
    brushRadius: 0.035,
    points: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }],
  };
  const protect = { ...edit, id: "mask_protect", mode: "protect" };

  assert.equal(hitTestAnnotation([protect, edit], { x: 500, y: 500 }, rect, true)?.id, protect.id);
  assert.equal(hitTestAnnotation([edit, protect], { x: 500, y: 500 }, rect, true)?.id, protect.id);
});

test("mask erase strokes are never independent canvas hit targets", () => {
  const rect = { width: 1000, height: 1000 };
  const paint = {
    id: "mask_paint",
    type: "mask",
    mode: "edit",
    operation: "paint",
    brushRadius: 0.08,
    points: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }],
  };
  const erase = {
    ...paint,
    id: "mask_erase",
    operation: "erase",
    brushRadius: 0.03,
    points: [{ x: 0.48, y: 0.5 }, { x: 0.52, y: 0.5 }],
  };

  assert.equal(hitTestAnnotation([paint, erase], { x: 500, y: 500 }, rect, true)?.id, paint.id);
});

test("hidden mask erase strokes do not leave gaps or duplicates in visible numbering", () => {
  const markup = annotationLayerMarkup([
    { id: "arrow", type: "arrow", from: { x: 0.1, y: 0.1 }, to: { x: 0.2, y: 0.2 } },
    { id: "erase", type: "mask", mode: "edit", operation: "erase", brushRadius: 0.02, points: [{ x: 0.4, y: 0.5 }, { x: 0.5, y: 0.5 }] },
    { id: "paint", type: "mask", mode: "edit", operation: "paint", brushRadius: 0.04, points: [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }] },
  ], null, { width: 1000, height: 1000 });
  const visibleNumbers = [...markup.matchAll(/class="annotation-index[^"]*"[^>]*>.*?<text[^>]*>(\d+)<\/text>/g)]
    .map((match) => Number(match[1]));

  assert.deepEqual(visibleNumbers, [1, 2]);
});
