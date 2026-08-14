import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import {
  IMAGE_ID,
  CODEX_COMPOSER_HOST_CAPABILITIES,
  installDomGlobals,
  installHost,
  pointerEvent,
  restoreDomGlobals,
  triggerResizeObservers,
  waitFor,
} from "./support/widget-runtime-host.mjs";

function nextAnimationFrame(window) {
  return new Promise((resolve) => window.requestAnimationFrame(resolve));
}


test("custom color and bidirectional mask controls reach the prepared edit payload", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?control-payload=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    await waitFor(() => document.querySelector("[data-tool=mask]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });

    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 260, pointerId: 1 }));
    applyCustomColor(dom.window, "#22c55e");
    document.querySelector('[data-action="apply-foreground-color"]').click();
    assert.equal(document.querySelector('[data-layer] rect[stroke="#22c55e"]') !== null, true);
    document.querySelector("[data-action=undo]").click();
    assert.equal(document.querySelector('[data-layer] rect[stroke="#ef4444"]') !== null, true);
    document.querySelector("[data-action=redo]").click();
    assert.equal(document.querySelector('[data-layer] rect[stroke="#22c55e"]') !== null, true);

    document.querySelector("[data-tool=select]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 900, clientY: 900, pointerId: 2 }));
    activeColorSlotElement().dispatchEvent(new dom.window.MouseEvent("contextmenu", {
      bubbles: false,
      cancelable: true,
      button: 2,
    }));
    applyCustomColor(dom.window, "#a855f7", { panelAlreadyOpen: true });
    document.querySelector("[data-tool=arrow]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 180, clientY: 600, pointerId: 3 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 360, clientY: 480, pointerId: 3 }));
    assert.equal(document.querySelector('[data-layer] line[stroke="#a855f7"]') !== null, true);

    document.querySelector("[data-tool=mask]").click();
    assert.equal(document.querySelector("[data-standard-style]").hidden, true);
    assert.equal(
      [...document.querySelectorAll("[data-stroke]")].every((button) => button.closest("[data-standard-style]")),
      true,
    );
    document.querySelector('[data-stroke="3"]').click();
    document.querySelector('[data-mask-mode="protect"]').click();
    document.querySelector('[data-mask-radius="0.06"]').click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 400, clientY: 320, pointerId: 4 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 620, clientY: 520, pointerId: 4 }));
    const protectStroke = document.querySelector('[data-layer] mask#annotation-mask-protect polyline[data-mask-operation="paint"]');
    assert.ok(document.querySelector('[data-layer] [data-mask-layer="protect"]'));
    assert.ok(protectStroke);
    assert.equal(protectStroke.hasAttribute("stroke-dasharray"), false);
    assert.match(document.querySelector("[data-intents]")?.textContent || "", /保护内容/);

    document.querySelector('[data-mask-mode="edit"]').click();
    document.querySelector('[data-mask-radius="0.02"]').click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 680, clientY: 260, pointerId: 5 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 840, clientY: 420, pointerId: 5 }));
    const editStroke = document.querySelector('[data-layer] mask#annotation-mask-edit polyline[data-mask-operation="paint"]');
    assert.ok(document.querySelector('[data-layer] [data-mask-layer="edit"]'));
    assert.ok(editStroke);
    assert.equal(editStroke.hasAttribute("stroke-dasharray"), false);
    assert.equal(editStroke.getAttribute("stroke-width"), "40");

    document.querySelector("[data-action=submit]").click();
    await waitFor(() => host.toolCalls.some(({ name }) => name === "prepare_image_edit_submission"));
    const prepared = host.toolCalls.find(({ name }) => name === "prepare_image_edit_submission");
    assert.deepEqual(prepared.arguments.items.map((item) => [item.type, item.color, item.strokeWidth, item.mode, item.brushRadius]), [
      ["rectangle", "#22c55e", 5, undefined, undefined],
      ["arrow", "#a855f7", 5, undefined, undefined],
      ["mask", "#2563eb", undefined, "protect", 0.06],
      ["mask", "#ef4444", undefined, "edit", 0.02],
    ]);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("mask controls configure the next stroke and same-value clicks preserve history", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?mask-history=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    await waitFor(() => document.querySelector("[data-tool=mask]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    const redo = document.querySelector("[data-action=redo]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });

    document.querySelector("[data-tool=mask]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 200, pointerId: 20 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 400, clientY: 400, pointerId: 20 }));

    document.querySelector('[data-mask-mode="protect"]').click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 600, clientY: 200, pointerId: 21 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 800, clientY: 400, pointerId: 21 }));
    document.querySelector("[data-action=undo]").click();
    assert.equal(document.querySelectorAll('[data-annotation-id]').length, 1);
    assert.equal(redo.disabled, false);
    document.querySelector('[data-mask-mode="edit"]').click();
    assert.equal(redo.disabled, false);
    redo.click();
    assert.equal(document.querySelectorAll('[data-annotation-id]').length, 2);
    assert.equal(document.querySelectorAll('[data-annotation-id]')[1].textContent.includes("保护内容"), true);
    document.querySelector('[data-mask-mode="edit"]').click();
    assert.equal(redo.disabled, true);

    document.querySelector('[data-mask-radius="0.06"]').click();
    document.querySelector("[data-action=undo]").click();
    assert.equal(document.querySelector('[data-mask-radius="0.035"]').getAttribute("aria-pressed"), "true");
    assert.equal(redo.disabled, false);
    document.querySelector('[data-mask-radius="0.035"]').click();
    assert.equal(redo.disabled, false);
    redo.click();
    assert.equal(document.querySelector('[data-mask-radius="0.06"]').getAttribute("aria-pressed"), "true");
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("switching from a selected mask to another drawing tool exits mask context", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?mask-tool-exit=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    await waitFor(() => document.querySelector("[data-tool=mask]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });

    document.querySelector('[data-stroke="3"]').click();
    document.querySelector("[data-tool=mask]").click();
    document.querySelector('[data-mask-mode="protect"]').click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 30 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 30 }));
    const originalMaskPoints = document.querySelector("[data-layer] polyline")?.getAttribute("points");
    assert.match(document.querySelector('[data-annotation-id][aria-current="true"]')?.textContent || "", /保护内容/);

    document.querySelector("[data-tool=arrow]").click();
    document.querySelector('[data-stroke="5"]').click();
    assert.deepEqual(
      {
        arrowActive: document.querySelector("[data-tool=arrow]").getAttribute("aria-pressed"),
        maskOptionsHidden: document.querySelector("[data-mask-options]").hidden,
        standardStyleHidden: document.querySelector("[data-standard-style]").hidden,
        selectedAnnotation: document.querySelector('[data-annotation-id][aria-current="true"]')?.dataset.annotationId ?? null,
      },
      {
        arrowActive: "true",
        maskOptionsHidden: true,
        standardStyleHidden: false,
        selectedAnnotation: null,
      },
    );

    const maskField = document.querySelector("[data-annotation-text]");
    maskField.focus();
    maskField.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }));
    assert.deepEqual(
      {
        selectActive: document.querySelector("[data-tool=select]").getAttribute("aria-pressed"),
        arrowActive: document.querySelector("[data-tool=arrow]").getAttribute("aria-pressed"),
        maskOptionsHidden: document.querySelector("[data-mask-options]").hidden,
        standardStyleHidden: document.querySelector("[data-standard-style]").hidden,
        selectedAnnotation: document.querySelector('[data-annotation-id][aria-current="true"]')?.dataset.annotationId ?? null,
      },
      {
        selectActive: "true",
        arrowActive: "false",
        maskOptionsHidden: true,
        standardStyleHidden: true,
        selectedAnnotation: maskField.dataset.annotationText,
      },
    );

    document.querySelector("[data-tool=arrow]").click();
    assert.equal(document.querySelector("[data-standard-style]").hidden, false);
    assert.equal(document.querySelector('[data-annotation-id][aria-current="true"]'), null);
    assert.equal(document.querySelector('[data-stroke="5"]').getAttribute("aria-pressed"), "true");

    document.querySelector('[data-color="#111827"]').click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 500, clientY: 500, pointerId: 31 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 700, clientY: 400, pointerId: 31 }));
    assert.equal(document.querySelector('[data-layer] line[stroke="#111827"]') !== null, true);
    assert.equal(document.querySelectorAll("[data-layer] polyline").length, 1);
    assert.equal(document.querySelector("[data-layer] polyline")?.getAttribute("points"), originalMaskPoints);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("a transient host resize while the color panel is open restores the fitted canvas and scroll origin", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?color-panel-resize-loop=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const frame = document.querySelector(".canvas-frame");
    const canvas = document.querySelector("[data-canvas]");
    const colorChoice = document.querySelector('[data-color-slot="0"]');
    const colorPanel = document.querySelector("[data-custom-color-panel]");
    const resizeSentinel = document.createElement("span");
    document.querySelector("[data-intents]").append(resizeSentinel);
    let frameSize = { width: 1000, height: 600 };
    frame.getBoundingClientRect = () => ({ left: 0, top: 0, right: frameSize.width, bottom: frameSize.height, ...frameSize });
    Object.defineProperties(frame, {
      clientWidth: { configurable: true, get: () => frameSize.width },
      clientHeight: { configurable: true, get: () => frameSize.height },
    });

    triggerResizeObservers(dom.window, frame);
    await nextAnimationFrame(dom.window);
    assert.equal(canvas.style.width, "600px");
    assert.equal(canvas.style.height, "600px");
    assert.equal(frame.scrollLeft, 0);
    assert.equal(frame.scrollTop, 0);

    colorChoice.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: false, cancelable: true, button: 2 }));
    assert.equal(colorPanel.hidden, false);

    frameSize = { width: 1000, height: 120 };
    triggerResizeObservers(dom.window, frame);
    await nextAnimationFrame(dom.window);
    assert.equal(canvas.style.width, "120px");
    assert.equal(canvas.style.height, "120px");

    frameSize = { width: 1000, height: 600 };
    triggerResizeObservers(dom.window, frame);
    await nextAnimationFrame(dom.window);
    assert.equal(canvas.style.width, "600px");
    assert.equal(canvas.style.height, "600px");
    assert.equal(frame.scrollLeft, 0);
    assert.equal(frame.scrollTop, 0);
    assert.equal(colorPanel.hidden, false);
    assert.equal(resizeSentinel.isConnected, true);

    frameSize = { width: 500, height: 400 };
    const zoom = document.querySelector("[data-zoom-select]");
    zoom.value = "1.5";
    zoom.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(canvas.style.width, "600px");
    assert.equal(canvas.style.height, "600px");
    const zoomedResizeSentinel = document.createElement("span");
    document.querySelector("[data-intents]").append(zoomedResizeSentinel);

    frame.scrollLeft = -100;
    frame.scrollTop = -50;
    triggerResizeObservers(dom.window, frame);
    await nextAnimationFrame(dom.window);
    assert.equal(frame.scrollLeft, 0);
    assert.equal(frame.scrollTop, 0);

    frame.scrollLeft = 9999;
    frame.scrollTop = 9999;
    triggerResizeObservers(dom.window, frame);
    await nextAnimationFrame(dom.window);
    assert.equal(frame.scrollLeft, 100);
    assert.equal(frame.scrollTop, 200);
    assert.equal(zoomedResizeSentinel.isConnected, true);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("canvas geometry writes are deferred beyond the ResizeObserver delivery cycle", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?deferred-resize-write=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const frame = document.querySelector(".canvas-frame");
    const canvas = document.querySelector("[data-canvas]");
    const frameSize = { width: 1000, height: 600 };
    frame.getBoundingClientRect = () => ({ left: 0, top: 0, right: frameSize.width, bottom: frameSize.height, ...frameSize });
    Object.defineProperties(frame, {
      clientWidth: { configurable: true, get: () => frameSize.width },
      clientHeight: { configurable: true, get: () => frameSize.height },
    });

    triggerResizeObservers(dom.window, frame);
    assert.notEqual(canvas.style.width, "600px");
    await new Promise((resolve) => dom.window.requestAnimationFrame(resolve));
    assert.equal(canvas.style.width, "600px");
    assert.equal(canvas.style.height, "600px");
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("a host resize during a canvas gesture defers geometry changes until the gesture ends", async () => {
  const { dom, host, previous } = createRuntimeHost({
    toolName: "open_image_editor",
    artifactOverride: { id: IMAGE_ID, mimeType: "image/png", width: 1000, height: 1000, operation: "generate", parentIds: [], childIds: [] },
  });

  try {
    await import(`../web/editor-runtime.mjs?gesture-resize=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const frame = document.querySelector(".canvas-frame");
    const canvas = document.querySelector("[data-canvas]");
    let frameSize = { width: 1000, height: 1000 };
    frame.getBoundingClientRect = () => ({ left: 0, top: 0, right: frameSize.width, bottom: frameSize.height, ...frameSize });
    Object.defineProperties(frame, {
      clientWidth: { configurable: true, get: () => frameSize.width },
      clientHeight: { configurable: true, get: () => frameSize.height },
    });
    canvas.getBoundingClientRect = () => {
      const width = Number.parseFloat(canvas.style.width) || 0;
      const height = Number.parseFloat(canvas.style.height) || 0;
      return { left: 0, top: 0, right: width, bottom: height, width, height };
    };

    triggerResizeObservers(dom.window, frame);
    await nextAnimationFrame(dom.window);
    assert.equal(canvas.style.width, "1000px");
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 91 }));

    frameSize = { width: 500, height: 500 };
    triggerResizeObservers(dom.window, frame);
    await nextAnimationFrame(dom.window);
    assert.equal(canvas.style.width, "1000px");

    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 91 }));
    const rectangle = document.querySelector("[data-layer] rect");
    assert.equal(rectangle?.getAttribute("x"), "100");
    assert.equal(rectangle?.getAttribute("width"), "200");
    assert.equal(canvas.style.width, "500px");
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("a canvas geometry change during drawing and move gestures keeps normalization anchored to pointerdown", async () => {
  const { dom, host, previous } = createRuntimeHost({
    toolName: "open_image_editor",
    artifactOverride: { id: IMAGE_ID, mimeType: "image/png", width: 1000, height: 1000, operation: "generate", parentIds: [], childIds: [] },
  });

  try {
    await import(`../web/editor-runtime.mjs?gesture-geometry-anchor=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    let geometry = { left: 0, top: 0, width: 1000, height: 1000 };
    canvas.getBoundingClientRect = () => ({ ...geometry, right: geometry.left + geometry.width, bottom: geometry.top + geometry.height });

    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 93 }));
    geometry = { left: 0, top: 0, width: 500, height: 500 };
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 93 }));

    const rectangle = document.querySelector("[data-layer] rect");
    assert.equal(rectangle?.getAttribute("x"), "100");
    assert.equal(rectangle?.getAttribute("y"), "100");
    assert.equal(rectangle?.getAttribute("width"), "200");
    assert.equal(rectangle?.getAttribute("height"), "200");

    geometry = { left: 0, top: 0, width: 1000, height: 1000 };
    document.querySelector("[data-tool=select]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 150, clientY: 150, pointerId: 94 }));
    geometry = { left: 0, top: 0, width: 500, height: 500 };
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 350, clientY: 350, pointerId: 94 }));

    const movedRectangle = document.querySelector("[data-layer] rect");
    assert.equal(movedRectangle?.getAttribute("x"), "300");
    assert.equal(movedRectangle?.getAttribute("y"), "300");
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("a delayed trailing click after color-area pointer capture release keeps the draft open", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?color-panel-drag-release=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const colorChoice = document.querySelector('[data-color-slot="0"]');
    const colorPanel = document.querySelector("[data-custom-color-panel]");
    const colorArea = document.querySelector("[data-custom-color-area]");
    colorArea.getBoundingClientRect = () => ({ left: 100, top: 100, right: 300, bottom: 200, width: 200, height: 100 });
    colorChoice.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: false, cancelable: true, button: 2 }));
    assert.equal(colorPanel.hidden, false);

    colorArea.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 300, clientY: 100, pointerId: 7 }));
    assert.equal(colorArea.isConnected, true);
    assert.equal(document.querySelector("[data-custom-color-area]"), colorArea);
    colorArea.dispatchEvent(pointerEvent(dom.window, "pointermove", { clientX: 300, clientY: 100, pointerId: 7 }));
    assert.equal(colorArea.isConnected, true);
    assert.equal(document.querySelector("[data-custom-color-area]"), colorArea);
    colorArea.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 100, pointerId: 7 }));
    colorArea.dispatchEvent(pointerEvent(dom.window, "lostpointercapture", { clientX: 300, clientY: 100, pointerId: 7 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    colorArea.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));

    assert.equal(colorPanel.hidden, false);
    assert.equal(document.querySelector('[data-tool="select"]').getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector("[data-custom-color-draft]").style.getPropertyValue("--preview-color"), "#ff0000");
    document.querySelector("[data-custom-color-apply]").click();
    assert.equal(colorPanel.hidden, true);
    assert.equal(colorChoice.style.getPropertyValue("--swatch"), "#ff0000");

    const rectangleGlyph = document.querySelector('[data-tool="rectangle"] svg rect');
    assert.ok(rectangleGlyph);
    rectangleGlyph.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    assert.equal(document.querySelector('[data-tool="rectangle"]').getAttribute("aria-pressed"), "true");
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("lost pointer capture ends color dragging without dismissing or accepting a new move", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?color-panel-lost-capture=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const colorChoice = document.querySelector('[data-color-slot="0"]');
    const colorPanel = document.querySelector("[data-custom-color-panel]");
    const colorArea = document.querySelector("[data-custom-color-area]");
    const releasedPointerIds = [];
    colorArea.releasePointerCapture = (pointerId) => releasedPointerIds.push(pointerId);
    colorArea.getBoundingClientRect = () => ({ left: 100, top: 100, right: 300, bottom: 200, width: 200, height: 100 });
    colorChoice.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: false, cancelable: true, button: 2 }));

    colorArea.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 260, clientY: 120, pointerId: 12 }));
    const beforeLostCapture = document.querySelector("[data-custom-color-draft]").style.getPropertyValue("--preview-color");
    colorArea.dispatchEvent(pointerEvent(dom.window, "lostpointercapture", { clientX: 260, clientY: 120, pointerId: 12 }));
    colorArea.dispatchEvent(pointerEvent(dom.window, "pointermove", { clientX: 110, clientY: 190, pointerId: 12 }));

    assert.equal(colorPanel.hidden, false);
    assert.equal(document.querySelector("[data-custom-color-draft]").style.getPropertyValue("--preview-color"), beforeLostCapture);
    assert.deepEqual(releasedPointerIds, []);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("all four color slots share selection, editing, keyboard, and pencil-button behavior", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?four-peer-color-slots=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const panel = document.querySelector("[data-custom-color-panel]");
    const contextMenu = () => new dom.window.MouseEvent("contextmenu", { bubbles: false, cancelable: true, button: 2 });
    for (let index = 0; index < 4; index += 1) {
      const slot = document.querySelector(`[data-color-slot="${index}"]`);
      slot.click();
      assert.equal(activeColorSlotElement(), slot);
      slot.dispatchEvent(contextMenu());
      assert.equal(panel.hidden, false);
      assert.equal(document.querySelector("[data-custom-color-panel-title]").textContent, `编辑颜色 ${index + 1}`);
      assert.equal(activeColorSlotElement(), slot);
      slot.dispatchEvent(contextMenu());
      assert.equal(panel.hidden, true);
    }

    const first = document.querySelector('[data-color-slot="0"]');
    first.focus();
    first.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    assert.equal(activeColorSlotElement().dataset.colorSlot, "1");
    assert.equal(document.activeElement.dataset.colorSlot, "1");
    document.querySelector("[data-action=edit-active-color]").click();
    assert.equal(panel.hidden, false);
    assert.equal(document.querySelector("[data-custom-color-panel-title]").textContent, "编辑颜色 2");
    assert.equal(document.activeElement, document.querySelector("[data-custom-color-area]"));
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("duplicate user colors preserve the selected slot identity", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?duplicate-color-slot-identity=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    const fourth = document.querySelector('[data-color-slot="3"]');

    applyCustomColor(dom.window, "#ef4444", { slot: 3 });
    assert.equal(activeColorSlotElement().dataset.colorSlot, "0");
    assert.equal(fourth.dataset.color, "#ef4444");

    fourth.click();
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 31 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 260, pointerId: 31 }));
    assert.equal(activeColorSlotElement().dataset.colorSlot, "3");

    document.querySelector(".intent-item[data-annotation-id]").click();
    assert.equal(activeColorSlotElement().dataset.colorSlot, "3");
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("foreground color changes stay on new annotations until an explicit object action applies them", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?foreground-object-color-separation=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });

    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 41 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 260, pointerId: 41 }));
    assert.equal(document.querySelectorAll(".intent-item").length, 1);

    document.querySelector('[data-color="#2563eb"]').click();
    assert.ok(document.querySelector('[data-layer] rect[stroke="#ef4444"]'));

    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 500, clientY: 120, pointerId: 42 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 760, clientY: 300, pointerId: 42 }));
    assert.equal(document.querySelectorAll(".intent-item").length, 2);
    assert.equal(document.querySelectorAll('[data-layer] rect[stroke="#2563eb"]').length, 1);

    const firstCard = document.querySelectorAll(".intent-item")[0];
    firstCard.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    assert.deepEqual(activeColorChoices(), ["#2563eb"]);

    document.querySelector('[data-color="#16a34a"]').click();
    assert.deepEqual(activeColorChoices(), ["#16a34a"]);
    assert.equal(document.querySelectorAll('[data-layer] rect[stroke="#ef4444"]').length, 1);
    assert.equal(document.querySelectorAll('[data-layer] rect[stroke="#2563eb"]').length, 1);

    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 120, clientY: 520, pointerId: 43 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 360, clientY: 760, pointerId: 43 }));
    assert.equal(document.querySelectorAll('[data-layer] rect[stroke="#16a34a"]').length, 1);

    const applyButton = document.querySelectorAll(".intent-item")[0].querySelector('[data-action="apply-foreground-color"]');
    assert.ok(applyButton);
    assert.equal(applyButton.disabled, false);
    applyButton.click();
    assert.equal(document.querySelectorAll('[data-layer] rect[stroke="#16a34a"]').length, 2);
    assert.equal(document.querySelectorAll('[data-layer] rect[stroke="#2563eb"]').length, 1);
    assert.equal(document.querySelectorAll(".intent-item")[0].querySelector('[data-action="apply-foreground-color"]').disabled, true);

    document.body.dispatchEvent(historyKey(dom.window, "z"));
    assert.equal(document.querySelectorAll('[data-layer] rect[stroke="#16a34a"]').length, 1);
    assert.equal(document.querySelectorAll('[data-layer] rect[stroke="#ef4444"]').length, 1);
    document.body.dispatchEvent(historyKey(dom.window, "y"));
    assert.equal(document.querySelectorAll('[data-layer] rect[stroke="#16a34a"]').length, 2);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("annotation history never rolls back a foreground palette chosen after undo", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?history-keeps-foreground=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 51 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 260, pointerId: 51 }));
    document.querySelector('[data-color="#2563eb"]').click();
    document.querySelector('[data-action="apply-foreground-color"]').click();
    assert.ok(document.querySelector('[data-layer] rect[stroke="#2563eb"]'));

    document.body.dispatchEvent(historyKey(dom.window, "z"));
    assert.ok(document.querySelector('[data-layer] rect[stroke="#ef4444"]'));
    document.querySelector('[data-color="#16a34a"]').click();
    document.body.dispatchEvent(historyKey(dom.window, "y"));

    assert.ok(document.querySelector('[data-layer] rect[stroke="#2563eb"]'));
    assert.deepEqual(activeColorChoices(), ["#16a34a"]);
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 500, clientY: 100, pointerId: 52 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 760, clientY: 260, pointerId: 52 }));
    assert.equal(document.querySelectorAll('[data-layer] rect[stroke="#16a34a"]').length, 1);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("tool rail scrolling repositions an open color editor relative to its slot", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?custom-color-tool-rail-scroll=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 700 });
    const customChoice = document.querySelector('[data-color-slot="3"]');
    const colorPanel = document.querySelector("[data-custom-color-panel]");
    const toolRail = document.querySelector(".tool-rail");
    let anchor = { left: 20, right: 60, top: 500, bottom: 540, width: 40, height: 40 };
    customChoice.getBoundingClientRect = () => anchor;
    colorPanel.getBoundingClientRect = () => ({ left: 0, right: 260, top: 0, bottom: 320, width: 260, height: 320 });
    customChoice.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
      bubbles: false,
      cancelable: true,
      button: 2,
    }));
    assert.equal(colorPanel.style.left, "68px");
    assert.equal(colorPanel.dataset.placement, "right");

    anchor = { left: 500, right: 540, top: 100, bottom: 140, width: 40, height: 40 };
    toolRail.dispatchEvent(new dom.window.Event("scroll"));
    assert.equal(colorPanel.style.left, "232px");
    assert.equal(colorPanel.style.top, "8px");
    assert.equal(colorPanel.dataset.placement, "left");
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("reopening the canvas keeps customized color slots intact", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    const runtimeRoot = document.querySelector("main");
    const addEventListener = runtimeRoot.addEventListener.bind(runtimeRoot);
    const removeEventListener = runtimeRoot.removeEventListener.bind(runtimeRoot);
    let activeFocusInListeners = 0;
    runtimeRoot.addEventListener = (type, listener, options) => {
      if (type === "focusin") activeFocusInListeners += 1;
      return addEventListener(type, listener, options);
    };
    runtimeRoot.removeEventListener = (type, listener, options) => {
      if (type === "focusin") activeFocusInListeners -= 1;
      return removeEventListener(type, listener, options);
    };
    await import(`../web/editor-runtime.mjs?custom-color-reopen=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    assert.equal(activeFocusInListeners, 1);

    applyCustomColor(dom.window, "#22c55e");
    assert.equal(activeColorSlotElement().style.getPropertyValue("--swatch"), "#22c55e");

    await returnToResults();
    assert.equal(activeFocusInListeners, 0);
    await openCandidate(IMAGE_ID);
    assert.equal(activeFocusInListeners, 1);

    const customChoice = activeColorSlotElement();
    customChoice.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
      bubbles: false,
      cancelable: true,
      button: 2,
    }));
    const hex = document.querySelector("[data-custom-color-hex]");
    hex.value = "#a855f7";
    hex.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    document.querySelector("[data-custom-color-apply]").click();

    assert.equal(customChoice.style.getPropertyValue("--swatch"), "#a855f7");
    assert.deepEqual(activeColorChoices(), ["#a855f7"]);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("preset colors handle host clicks that do not bubble to the editor root", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?direct-color-click=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const blue = document.querySelector('[data-color="#2563eb"]');

    blue.dispatchEvent(new dom.window.MouseEvent("click", {
      bubbles: false,
      cancelable: true,
    }));

    assert.deepEqual(activeColorChoices(), ["#2563eb"]);
    const black = document.querySelector('[data-color="#111827"]');
    black.dispatchEvent(new dom.window.MouseEvent("click", {
      bubbles: false,
      cancelable: true,
    }));
    assert.deepEqual(activeColorChoices(), ["#111827"]);
    const red = document.querySelector('[data-color="#ef4444"]');
    red.dispatchEvent(new dom.window.MouseEvent("click", {
      bubbles: false,
      cancelable: true,
    }));
    assert.deepEqual(activeColorChoices(), ["#ef4444"]);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("canvas-level Ctrl+Z and Ctrl+Y preserve native input editing", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?document-history-keys=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 260, pointerId: 1 }));
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);

    const undo = historyKey(dom.window, "z");
    document.body.dispatchEvent(undo);
    assert.equal(undo.defaultPrevented, true);
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);

    const redo = historyKey(dom.window, "y");
    document.body.dispatchEvent(redo);
    assert.equal(redo.defaultPrevented, true);
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);

    const textInput = document.createElement("input");
    textInput.type = "text";
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    document.querySelector(".editor-app").append(textInput, editable);
    const nativeTargets = [
      document.querySelector("[data-prompt]"),
      document.querySelector("[data-zoom-select]"),
      document.querySelector("[data-custom-color-hue]"),
      document.querySelector("[data-custom-color-hex]"),
      textInput,
      editable,
    ];
    for (const target of nativeTargets) {
      target.focus();
      const nativeUndo = historyKey(dom.window, "z");
      target.dispatchEvent(nativeUndo);
      assert.equal(nativeUndo.defaultPrevented, false, target.tagName);
      assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
    }
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("history shortcuts cancel an unfinished move before touching committed history", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?gesture-history-key=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 260, pointerId: 1 }));
    document.querySelector("[data-tool=select]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 180, pointerId: 2 }));

    document.body.dispatchEvent(historyKey(dom.window, "z"));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 420, clientY: 400, pointerId: 2 }));
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);

    document.body.dispatchEvent(historyKey(dom.window, "z"));
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
    document.body.dispatchEvent(historyKey(dom.window, "y"));
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("style changes cancel an unfinished move without preserving its preview in history", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?gesture-style-change=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 260, pointerId: 1 }));
    document.querySelector("[data-tool=select]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 180, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointermove", { clientX: 500, clientY: 480, pointerId: 2 }));
    await waitFor(() => document.querySelector('[data-layer] rect[stroke="#ef4444"]')?.getAttribute("x") === "400");

    document.querySelector('[data-color="#2563eb"]').click();
    document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(document.querySelector('[data-layer] rect[stroke="#ef4444"]')?.getAttribute("x"), "100");

    document.body.dispatchEvent(historyKey(dom.window, "z"));
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("applying foreground color cancels an unfinished move before committing object color", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?gesture-object-color-change=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 260, pointerId: 1 }));
    document.querySelector('[data-color="#2563eb"]').click();
    document.querySelector("[data-tool=select]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 180, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointermove", { clientX: 500, clientY: 480, pointerId: 2 }));
    await waitFor(() => document.querySelector('[data-layer] rect[stroke="#ef4444"]')?.getAttribute("x") === "400");

    document.querySelector('[data-action="apply-foreground-color"]').click();
    const recolored = document.querySelector('[data-layer] rect[stroke="#2563eb"]');
    assert.equal(recolored?.getAttribute("x"), "100");

    document.body.dispatchEvent(historyKey(dom.window, "z"));
    assert.equal(document.querySelector('[data-layer] rect[stroke="#ef4444"]')?.getAttribute("x"), "100");
    document.body.dispatchEvent(historyKey(dom.window, "z"));
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("stroke changes cancel an unfinished move without preserving its preview in history", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?gesture-stroke-change=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 260, pointerId: 1 }));
    document.querySelector("[data-tool=select]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 180, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointermove", { clientX: 500, clientY: 480, pointerId: 2 }));
    await waitFor(() => document.querySelector('[data-layer] rect[stroke="#ef4444"]')?.getAttribute("x") === "400");

    document.querySelector('[data-stroke="3"]').click();
    document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(document.querySelector('[data-layer] rect[stroke="#ef4444"][stroke-width="3"]')?.getAttribute("x"), "100");

    document.body.dispatchEvent(historyKey(dom.window, "z"));
    assert.equal(document.querySelector('[data-layer] rect[stroke="#ef4444"][stroke-width="5"]')?.getAttribute("x"), "100");
    document.body.dispatchEvent(historyKey(dom.window, "z"));
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("pointer gestures ignore unrelated pointer ids", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?pointer-ownership=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 11 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointercancel", { clientX: 500, clientY: 500, pointerId: 22 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 500, clientY: 500, pointerId: 22 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointermove", { clientX: 700, clientY: 700, pointerId: 22 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 11 }));

    const rectangle = document.querySelector('[data-layer] rect[stroke="#ef4444"]');
    assert.deepEqual(
      [rectangle?.getAttribute("x"), rectangle?.getAttribute("y"), rectangle?.getAttribute("width"), rectangle?.getAttribute("height")],
      ["100", "100", "200", "200"],
    );
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("reselecting the active preset color does not add an empty undo step", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?active-preset-noop=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 260, pointerId: 1 }));

    document.querySelector('[data-color="#ef4444"]').click();
    document.body.dispatchEvent(historyKey(dom.window, "z"));
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("reselecting an active customized slot does not add an empty undo step", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?active-custom-noop=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 260, pointerId: 1 }));
    applyCustomColor(dom.window, "#22c55e");

    activeColorSlotElement().click();
    document.body.dispatchEvent(historyKey(dom.window, "z"));
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("tool switches and Escape discard an unfinished pointer gesture", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?gesture-cancel=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });

    document.querySelector("[data-tool=pen]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 1 }));
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);

    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 200, pointerId: 2 }));
    document.querySelector(".editor-app").dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 500, clientY: 500, pointerId: 2 }));
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("working drafts restore independently while switching result candidates", async () => {
  const secondId = "img_01J00000000000000000000001";
  const initialArtifacts = [artifact(IMAGE_ID), artifact(secondId)];
  const { dom, host, previous } = createRuntimeHost({
    toolName: "render_image_results",
    initialArtifacts,
    uniqueEditorSessionIds: true,
  });

  try {
    await import(`../web/editor-runtime.mjs?candidate-drafts=${Date.now()}`);
    await waitFor(() => {
      const buttons = [...document.querySelectorAll("[data-action=open-editor]")];
      return buttons.length === 2 && buttons.every((button) => !button.disabled);
    });

    await openCandidate(IMAGE_ID);
    setPrompt(dom, "第一张候选的草稿");
    await returnToResults();

    await openCandidate(secondId);
    setPrompt(dom, "第二张候选的草稿");
    await returnToResults();
    assert.deepEqual(
      [...document.querySelectorAll("[data-draft-state]")].map((item) => item.textContent),
      ["未提交", "未提交"],
    );

    await openCandidate(IMAGE_ID);
    assert.equal(document.querySelector("[data-prompt]").value, "第一张候选的草稿");
    await returnToResults();
    await openCandidate(secondId);
    assert.equal(document.querySelector("[data-prompt]").value, "第二张候选的草稿");
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("destroy confirmation moves focus safely and Escape returns it to the trigger", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?destroy-focus=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const trigger = document.querySelector("[data-action=destroy]");
    trigger.focus();
    trigger.click();

    assert.equal(document.querySelector("[data-destroy-confirm]").hidden, false);
    assert.equal(document.activeElement, document.querySelector("[data-action=cancel-destroy]"));
    document.querySelector(".editor-app").dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
    assert.equal(document.querySelector("[data-destroy-confirm]").hidden, true);
    assert.equal(document.activeElement, trigger);
    trigger.click();
    document.querySelector(".editor-app").dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
    }));
    assert.equal(document.activeElement, document.querySelector("[data-action=confirm-destroy]"));
    document.querySelector(".editor-app").dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
    }));
    assert.equal(document.activeElement, document.querySelector("[data-action=cancel-destroy]"));
    document.querySelector("[data-action=cancel-destroy]").click();
    assert.equal(document.activeElement, trigger);
    assert.equal(host.toolCalls.some(({ name }) => name === "destroy_image_editor"), false);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("destroy confirmation accepts only one destructive request", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?destroy-once=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    document.querySelector("[data-action=destroy]").click();
    const confirm = document.querySelector("[data-action=confirm-destroy]");
    confirm.click();
    confirm.click();
    await waitFor(() => document.querySelector(".inline-results") !== null);
    assert.equal(host.toolCalls.filter(({ name }) => name === "destroy_image_editor").length, 1);
    assert.equal(host.toolCalls.filter(({ name }) => name === "finalize_image_editor_session").length, 1);
    assert.equal(host.displayModeRequests.filter((mode) => mode === "inline").length, 1);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("destroy confirmation unlocks the editor when its session is not established", async () => {
  const { dom, host, previous } = createRuntimeHost({
    toolName: "open_image_editor",
    initialArtifacts: [artifact(IMAGE_ID)],
  });

  try {
    await import(`../web/editor-runtime.mjs?destroy-without-session=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const trigger = document.querySelector("[data-action=destroy]");
    trigger.click();
    document.querySelector("[data-action=confirm-destroy]").click();
    await waitFor(() => document.querySelector("[data-toast]")?.textContent === "当前画布会话尚未准备好");
    const restoredTrigger = document.querySelector("[data-action=destroy]");
    assert.equal(restoredTrigger.disabled, false);
    assert.equal(document.querySelector(".editor-app")?.getAttribute("aria-busy"), "false");
    assert.equal(document.activeElement, restoredTrigger);
    restoredTrigger.click();
    assert.equal(document.querySelector("[data-destroy-confirm]").hidden, false);
    assert.equal(document.activeElement, document.querySelector("[data-action=cancel-destroy]"));
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("clearing a working draft asks for confirmation and keeps the previous task input state", async () => {
  const { dom, host, previous } = createRuntimeHost({
    toolName: "open_image_editor",
    hostCapabilities: CODEX_COMPOSER_HOST_CAPABILITIES,
  });

  try {
    await import(`../web/editor-runtime.mjs?clear-draft-confirm=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 81 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 81 }));

    const clear = document.querySelector("[data-action=clear]");
    clear.click();
    const confirm = document.querySelector("[data-clear-confirm]");
    assert.equal(confirm.hidden, false);
    assert.match(confirm.textContent, /当前工作草稿/);
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
    document.querySelector("[data-action=cancel-clear]").click();
    assert.equal(confirm.hidden, true);
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);

    clear.click();
    const confirmClear = document.querySelector("[data-action=confirm-clear]");
    confirmClear.click();
    confirmClear.click();
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
    assert.equal(document.querySelector("[data-prompt]").value, "");
    assert.equal(host.toolCalls.some(({ name }) => name === "clear_composer_input"), false);
    document.querySelector("[data-action=undo]").click();
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("editing a submitted draft replaces the stale success notice with the updated draft state", async () => {
  const { dom, host, previous } = createRuntimeHost({
    toolName: "open_image_editor",
    hostCapabilities: CODEX_COMPOSER_HOST_CAPABILITIES,
  });

  try {
    await import(`../web/editor-runtime.mjs?stale-submit-status=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 1 }));
    document.querySelector("[data-action=submit]").click();
    await waitFor(() => document.querySelector(".inline-results") !== null);
    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => document.querySelector(".editor-app") !== null);
    assert.match(document.querySelector("[data-submit-status]")?.textContent || "", /放入任务输入框/);

    document.querySelector('[data-color="#2563eb"]').click();
    assert.equal(document.querySelector("[data-submit-status]")?.textContent, "任务输入框中是当前版本");
    document.querySelector('[data-action="apply-foreground-color"]').click();
    assert.equal(document.querySelector("[data-submit-status]")?.textContent, "任务输入框仍是上一版；更新能力等待真实宿主验收");
    assert.equal(document.querySelector("[data-submit-status]")?.dataset.statusTone, "neutral");
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("focusing another intent synchronizes its visible style controls without losing focus", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?intent-controls=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    await waitFor(() => document.querySelector("[data-tool=mask]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });

    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 1 }));
    document.querySelector("[data-tool=mask]").click();
    document.querySelector('[data-mask-mode="protect"]').click();
    document.querySelector('[data-mask-radius="0.06"]').click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 450, clientY: 450, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 650, clientY: 650, pointerId: 2 }));
    let fields = [...document.querySelectorAll("[data-annotation-text]")];
    fields[1].focus();
    fields[1].value = "保持杯子不变";
    fields[1].dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    document.querySelector("[data-tool=select]").click();

    fields = [...document.querySelectorAll("[data-annotation-text]")];
    fields[0].focus();
    assert.equal(document.querySelector("[data-mask-options]").hidden, true);
    assert.equal(document.querySelector("[data-standard-style]").hidden, false);

    fields = [...document.querySelectorAll("[data-annotation-text]")];
    assert.match(fields[1].closest("[data-annotation-id]")?.textContent || "", /保护内容/);
    fields[1].setSelectionRange(2, 4);
    fields[1].focus();
    fields[1].dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }));
    const focused = document.activeElement;
    assert.equal(focused.dataset.annotationText, fields[1].dataset.annotationText);
    assert.deepEqual([focused.selectionStart, focused.selectionEnd], [2, 4]);
    assert.match(document.querySelector('[data-annotation-id][aria-current="true"]')?.textContent || "", /保护内容/);
    assert.equal(document.querySelector("[data-tool=mask]").hidden, false);
    assert.equal(document.querySelector("[data-mask-options]").hidden, true);
    assert.equal(document.querySelector("[data-standard-style]").hidden, true);
    assert.equal(document.querySelector('[data-tool="select"]').getAttribute("aria-pressed"), "true");
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("a matching child result consumes the completed parent draft instead of reviving it", async () => {
  const childId = "img_01J00000000000000000000001";
  const { dom, host, previous } = createRuntimeHost({
    toolName: "open_image_editor",
    hostCapabilities: CODEX_COMPOSER_HOST_CAPABILITIES,
  });

  try {
    await import(`../web/editor-runtime.mjs?completed-draft=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 1 }));
    document.querySelector("[data-action=submit]").click();
    await waitFor(() => document.querySelector("[data-draft-state]")?.textContent === "待发送");
    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => document.querySelector(".editor-app [data-image-id]")?.textContent === IMAGE_ID);

    host.notifyResultArtifacts([{
      id: childId,
      mimeType: "image/png",
      width: 1,
      height: 1,
      operation: "edit",
      parentIds: [IMAGE_ID],
      childIds: [],
      annotationId: "ann_01J00000000000000000000000",
      parameters: { submissionId: "sub_00000000000000000000000000000001" },
    }]);
    await waitFor(() => document.querySelector(".editor-app [data-image-id]")?.textContent === childId);
    assert.doesNotMatch(document.querySelector("[data-submit-status]")?.textContent || "", /任务输入框|待发送/);
    document.querySelector(`[data-version-id="${IMAGE_ID}"]`).click();
    await waitFor(() => document.querySelector(".editor-app [data-image-id]")?.textContent === IMAGE_ID);
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
    assert.equal(document.querySelector("[data-prompt]").value, "");
    assert.equal(document.querySelector("[data-action=submit]").disabled, true);
    assert.doesNotMatch(document.querySelector("[data-submit-status]")?.textContent || "", /任务输入框|待发送/);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("destroying after a version switch marks the session-bound image as destroyed", async () => {
  const childId = "img_01J00000000000000000000001";
  const { dom, host, previous } = createRuntimeHost({
    toolName: "open_image_editor",
    artifactOverride: {
      id: IMAGE_ID,
      mimeType: "image/png",
      width: 1,
      height: 1,
      operation: "generate",
      parentIds: [],
      childIds: [childId],
    },
  });

  try {
    await import(`../web/editor-runtime.mjs?destroy-after-version-switch=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    host.notifyResultArtifacts([{
      id: IMAGE_ID,
      mimeType: "image/png",
      width: 1,
      height: 1,
      operation: "generate",
      parentIds: [],
      childIds: [childId],
    }, {
      id: childId,
      mimeType: "image/png",
      width: 1,
      height: 1,
      operation: "edit",
      parentIds: [IMAGE_ID],
      childIds: [],
    }]);
    await waitFor(() => document.querySelectorAll("[data-version-id] .version-thumb img").length === 2);
    assert.ok(document.querySelector(`[data-version-id="${IMAGE_ID}"]`));
    assert.ok(document.querySelector(`[data-version-id="${childId}"]`));
    document.querySelector(`[data-version-id="${childId}"]`).click();
    await waitFor(() => document.querySelector(".editor-app [data-image-id]")?.textContent === childId);

    document.querySelector("[data-action=destroy]").click();
    document.querySelector("[data-action=confirm-destroy]").click();
    await waitFor(() => host.toolCalls.some(({ name }) => name === "destroy_image_editor"));
    await waitFor(() => document.querySelector(".inline-result") !== null);
    host.notifyResultArtifacts([{
      id: IMAGE_ID,
      mimeType: "image/png",
      width: 1,
      height: 1,
      operation: "generate",
      parentIds: [],
      childIds: [childId],
    }, {
      id: childId,
      mimeType: "image/png",
      width: 1,
      height: 1,
      operation: "edit",
      parentIds: [IMAGE_ID],
      childIds: [],
    }]);
    await waitFor(() => document.querySelectorAll("[data-result-image-id]").length === 2);

    assert.ok(document.querySelector(`[data-result-image-id="${IMAGE_ID}"]`));
    assert.ok(document.querySelector(`[data-result-image-id="${childId}"]`));
    assert.equal(document.querySelector(`[data-result-image-id="${IMAGE_ID}"]`)?.dataset.canvasStatus, "destroyed");
    assert.equal(document.querySelector(`[data-result-image-id="${childId}"]`)?.dataset.canvasStatus, "available");
  } finally {
    host.dispose();
    restoreRuntime(dom, previous);
  }
});

test("destroying an already released session keeps the image available to reopen", async () => {
  const { dom, host, previous } = createRuntimeHost({
    toolName: "open_image_editor",
    destroySessionStatus: "released",
  });

  try {
    await import(`../web/editor-runtime.mjs?destroy-released-session=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);

    document.querySelector("[data-action=destroy]").click();
    document.querySelector("[data-action=confirm-destroy]").click();
    await waitFor(() => host.toolCalls.some(({ name }) => name === "destroy_image_editor"));
    await waitFor(() => document.querySelector(".inline-result") !== null);

    assert.equal(document.querySelector(".inline-result")?.dataset.canvasStatus, "available");
    assert.ok(document.querySelector("[data-action=open-editor]"));
    assert.equal(host.toolCalls.some(({ name }) => name === "finalize_image_editor_session"), false);
  } finally {
    host.dispose();
    restoreRuntime(dom, previous);
  }
});

function createRuntimeHost(options) {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  dom.window.document.body.dataset.tool = options.toolName;
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, options);
  return { dom, host, previous };
}

function artifact(id) {
  return { id, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] };
}

async function openCandidate(imageId) {
  document.querySelector(`[data-result-image-id="${imageId}"] [data-action=open-editor]`).click();
  await waitFor(() => document.querySelector(".editor-app") !== null);
  await waitFor(() => document.querySelector(".editor-app [data-image-id]")?.textContent === imageId);
}

function setPrompt(dom, value) {
  const prompt = document.querySelector("[data-prompt]");
  prompt.value = value;
  prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

function activeColorChoices() {
  return [...document.querySelectorAll('[data-color-slot][aria-checked="true"]')].map((item) => item.dataset.color);
}

function activeColorSlotElement() {
  return document.querySelector('[data-color-slot][aria-checked="true"]');
}

function applyCustomColor(window, color, { panelAlreadyOpen = false, slot = null } = {}) {
  if (!panelAlreadyOpen) {
    const choice = slot === null ? activeColorSlotElement() : document.querySelector(`[data-color-slot="${slot}"]`);
    choice.dispatchEvent(new window.MouseEvent("contextmenu", {
      bubbles: false,
      cancelable: true,
      button: 2,
    }));
  }
  const hex = document.querySelector("[data-custom-color-hex]");
  hex.value = color;
  hex.dispatchEvent(new window.Event("input", { bubbles: true }));
  document.querySelector("[data-custom-color-apply]").click();
}

function historyKey(window, key, options = {}) {
  return new window.KeyboardEvent("keydown", {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  });
}

async function returnToResults() {
  document.querySelector("[data-action=back]")?.click();
  await waitFor(() => document.querySelector(".inline-results") !== null);
}

async function closeRuntime(host) {
  if (document.querySelector(".editor-app")) await returnToResults().catch(() => {});
  host.dispose();
}

function restoreRuntime(dom, previous) {
  restoreDomGlobals(previous);
  dom.window.close();
}
