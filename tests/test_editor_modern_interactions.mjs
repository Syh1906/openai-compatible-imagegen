import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import {
  installDomGlobals,
  installHost,
  pointerEvent,
  restoreDomGlobals,
  waitFor,
} from "./support/widget-runtime-host.mjs";


test("a non-bubbling Move click still opens existing canvas text for inline editing", async () => {
  await withEditor("inline-text", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=text]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 300, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 200, clientY: 300, pointerId: 1 }));

    const createdEditor = document.querySelector("[data-canvas-text-editor]");
    assert.ok(createdEditor, "new text should immediately enter inline editing");
    createdEditor.value = "保留标题";
    createdEditor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    createdEditor.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    document.querySelector("[data-tool=select]").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: false }));
    assert.equal(document.querySelector("[data-tool=select]").getAttribute("aria-pressed"), "true");
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 270, clientY: 292, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 270, clientY: 292, pointerId: 2 }));

    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
    const reopenedEditor = document.querySelector("[data-canvas-text-editor]");
    assert.equal(reopenedEditor?.value, "保留标题");
    assert.equal(document.activeElement, reopenedEditor);
  });
});

test("canvas text click tolerates pointer jitter while deliberate drag still moves it", async () => {
  await withEditor("text-click-threshold", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=text]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 300, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 200, clientY: 300, pointerId: 1 }));
    const createdEditor = document.querySelector("[data-canvas-text-editor]");
    createdEditor.value = "保留标题";
    createdEditor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    createdEditor.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    document.querySelector("[data-tool=select]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 270, clientY: 292, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointermove", { clientX: 272, clientY: 293, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 272, clientY: 293, pointerId: 2 }));

    const jitterEditor = document.querySelector("[data-canvas-text-editor]");
    assert.equal(jitterEditor?.value, "保留标题");
    jitterEditor.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 270, clientY: 292, pointerId: 3 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointermove", { clientX: 330, clientY: 342, pointerId: 3 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 330, clientY: 342, pointerId: 3 }));

    assert.equal(document.querySelector("[data-canvas-text-editor]"), null);
    assert.equal(document.querySelector("[data-layer] .annotation-mark text")?.getAttribute("x"), "260");
    assert.equal(document.querySelector("[data-layer] .annotation-mark text")?.getAttribute("y"), "350");
  });
});

test("a dragged annotation finishes at the pointer release sample", async () => {
  await withEditor("drag-release-sample", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=text]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 300, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 200, clientY: 300, pointerId: 1 }));
    document.querySelector("[data-canvas-text-editor]")
      .dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    document.querySelector("[data-tool=select]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 230, clientY: 292, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointermove", { clientX: 330, clientY: 342, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 530, clientY: 442, pointerId: 2 }));

    assert.equal(document.querySelector("[data-canvas-text-editor]"), null);
    assert.equal(document.querySelector("[data-layer] .annotation-mark text")?.getAttribute("x"), "500");
    assert.equal(document.querySelector("[data-layer] .annotation-mark text")?.getAttribute("y"), "450");
  });
});

test("a release beyond the click threshold moves text even without a pointermove event", async () => {
  await withEditor("drag-release-without-move", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=text]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 300, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 200, clientY: 300, pointerId: 1 }));
    document.querySelector("[data-canvas-text-editor]")
      .dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    document.querySelector("[data-tool=select]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 230, clientY: 292, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 530, clientY: 442, pointerId: 2 }));

    assert.equal(document.querySelector("[data-canvas-text-editor]"), null);
    assert.equal(document.querySelector("[data-layer] .annotation-mark text")?.getAttribute("x"), "500");
    assert.equal(document.querySelector("[data-layer] .annotation-mark text")?.getAttribute("y"), "450");
  });
});

test("pointer gestures inside the inline text editor preserve its node and caret", async () => {
  await withEditor("inline-text-pointer", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=text]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 300, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 200, clientY: 300, pointerId: 1 }));
    const inlineEditor = document.querySelector("[data-canvas-text-editor]");
    inlineEditor.value = "保留标题";
    inlineEditor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    inlineEditor.setSelectionRange(2, 2);

    inlineEditor.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 230, clientY: 292, pointerId: 2 }));
    inlineEditor.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 230, clientY: 292, pointerId: 2 }));

    assert.equal(document.querySelector("[data-canvas-text-editor]"), inlineEditor);
    assert.equal(inlineEditor.selectionStart, 2);
    assert.equal(inlineEditor.selectionEnd, 2);
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
  });
});

test("leaving the inline text editor removes only the editor layer and keeps side-panel focus", async () => {
  await withEditor("inline-text-focusout", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=text]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 300, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 200, clientY: 300, pointerId: 1 }));
    const inlineEditor = document.querySelector("[data-canvas-text-editor]");
    inlineEditor.value = "保留标题";
    inlineEditor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const sideField = document.querySelector("[data-annotation-text]");
    sideField.focus();
    await Promise.resolve();

    assert.equal(document.querySelector("[data-canvas-text-editor]"), null);
    assert.equal(document.activeElement, sideField);
    assert.equal(sideField.value, "保留标题");
  });
});

test("mask drawing retains coalesced pointer samples in their path order", async () => {
  await withEditor("coalesced-mask", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=mask]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    const move = pointerEvent(dom.window, "pointermove", { clientX: 400, clientY: 100, pointerId: 1 });
    Object.defineProperty(move, "getCoalescedEvents", {
      value: () => [
        pointerEvent(dom.window, "pointermove", { clientX: 180, clientY: 100, pointerId: 1 }),
        pointerEvent(dom.window, "pointermove", { clientX: 260, clientY: 100, pointerId: 1 }),
        pointerEvent(dom.window, "pointermove", { clientX: 340, clientY: 100, pointerId: 1 }),
      ],
    });
    canvas.dispatchEvent(move);
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 400, clientY: 100, pointerId: 1 }));

    const overlay = document.querySelector("[data-layer]")?.innerHTML || "";
    const points = maskOverlayPoints();
    assert.match(overlay, /data-mask-layer="edit"/);
    assert.deepEqual(points, ["100,100", "180,100", "260,100", "340,100", "400,100"]);
  }, { artifactOverride: imageArtifact(1000, 1000) });
});

test("dense mask device events retain the source path and sharp corner", async () => {
  await withEditor("source-spaced-mask", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=mask]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 300, clientY: 400, pointerId: 1 }));
    const move = pointerEvent(dom.window, "pointermove", { clientX: 600, clientY: 600, pointerId: 1 });
    Object.defineProperty(move, "getCoalescedEvents", {
      value: () => Array.from({ length: 1601 }, (_, index) => index <= 800
        ? pointerEvent(dom.window, "pointermove", { clientX: 300 + ((300 * index) / 800), clientY: 400, pointerId: 1 })
        : pointerEvent(dom.window, "pointermove", { clientX: 600, clientY: 400 + ((200 * (index - 800)) / 800), pointerId: 1 })),
    });
    canvas.dispatchEvent(move);
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 600, clientY: 600, pointerId: 1 }));

    const points = maskOverlayPoints();
    assert.equal(points.length, 1602);
    assert.equal(points[0], "450,400");
    assert.equal(points[801], "900,400");
    assert.equal(points.at(-1), "900,600");
  }, { artifactOverride: imageArtifact(1536, 1024) });
});

test("mask drawing prevents native image drag and remains active for consecutive strokes", async () => {
  await withEditor("mask-native-drag", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=mask]").click();
    const image = document.querySelector("[data-image]");
    assert.equal(image.draggable, false);

    const down = new dom.window.MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: 200,
      clientY: 400,
    });
    Object.defineProperty(down, "pointerId", { value: 1 });
    image.dispatchEvent(down);
    assert.equal(down.defaultPrevented, true);
    image.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 400, pointerId: 1 }));

    drawStroke(dom.window, canvas, 2, [{ x: 500, y: 500 }, { x: 800, y: 500 }]);
    assert.equal(document.querySelector("[data-tool=mask]").getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelectorAll('[data-layer] [data-mask-operation="paint"]').length, 2);
  }, { artifactOverride: imageArtifact(1000, 1000) });
});

test("closed mask strokes and single-click brush dabs are retained", async () => {
  await withEditor("closed-mask-strokes", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=mask]").click();
    drawStroke(dom.window, canvas, 1, [
      { x: 200, y: 500 },
      { x: 500, y: 500 },
      { x: 500, y: 700 },
      { x: 200, y: 500 },
    ]);
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 700, clientY: 500, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 700, clientY: 500, pointerId: 2 }));

    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 2);
    const paths = [...document.querySelectorAll('[data-layer] [data-mask-operation="paint"]')]
      .map((path) => path.getAttribute("points").trim().split(/\s+/));
    assert.deepEqual(paths[0], ["200,500", "500,500", "500,700", "200,500"]);
    assert.deepEqual(paths[1], ["700,500", "700,500"]);
  }, { artifactOverride: imageArtifact(1000, 1000) });
});

test("committed inline text edits form one undoable history transaction", async () => {
  await withEditor("inline-text-history", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=text]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 300, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 200, clientY: 300, pointerId: 1 }));
    const createdEditor = document.querySelector("[data-canvas-text-editor]");
    createdEditor.value = "初始文字";
    createdEditor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    createdEditor.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    document.querySelector("[data-tool=select]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 245, clientY: 292, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 245, clientY: 292, pointerId: 2 }));
    const reopenedEditor = document.querySelector("[data-canvas-text-editor]");
    reopenedEditor.value = "修改后的文字";
    reopenedEditor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    reopenedEditor.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    document.querySelector("[data-action=undo]").click();
    assert.equal(document.querySelector("[data-annotation-text]").value, "初始文字");
    document.querySelector("[data-action=redo]").click();
    assert.equal(document.querySelector("[data-annotation-text]").value, "修改后的文字");
  });
});

test("clicking another annotation commits the active inline text edit before selection changes", async () => {
  await withEditor("inline-text-cross-annotation-history", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=text]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 300, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 200, clientY: 300, pointerId: 1 }));
    let inlineEditor = document.querySelector("[data-canvas-text-editor]");
    inlineEditor.value = "第一处文字";
    inlineEditor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    inlineEditor.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 600, clientY: 600, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 600, clientY: 600, pointerId: 2 }));
    inlineEditor = document.querySelector("[data-canvas-text-editor]");
    inlineEditor.value = "第二处文字";
    inlineEditor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    inlineEditor.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    document.querySelector("[data-tool=select]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 245, clientY: 292, pointerId: 3 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 245, clientY: 292, pointerId: 3 }));
    inlineEditor = document.querySelector("[data-canvas-text-editor]");
    inlineEditor.value = "已修改第一处";
    inlineEditor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 645, clientY: 592, pointerId: 4 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 645, clientY: 592, pointerId: 4 }));
    document.querySelector("[data-canvas-text-editor]")
      ?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    document.querySelector("[data-action=undo]").click();
    assert.deepEqual(
      [...document.querySelectorAll("[data-annotation-text]")].map((field) => field.value),
      ["第一处文字", "第二处文字"],
    );
    document.querySelector("[data-action=redo]").click();
    assert.deepEqual(
      [...document.querySelectorAll("[data-annotation-text]")].map((field) => field.value),
      ["已修改第一处", "第二处文字"],
    );
  });
});

test("visible text remains the click target when a newer mask overlaps it", async () => {
  await withEditor("text-over-mask-hit-order", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=text]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 300, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 200, clientY: 300, pointerId: 1 }));
    const createdEditor = document.querySelector("[data-canvas-text-editor]");
    createdEditor.value = "前景文字";
    createdEditor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    createdEditor.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    document.querySelector("[data-tool=mask]").click();
    drawStroke(dom.window, canvas, 2, [{ x: 100, y: 292 }, { x: 500, y: 292 }]);
    document.querySelector("[data-tool=select]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 245, clientY: 292, pointerId: 3 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 245, clientY: 292, pointerId: 3 }));

    assert.equal(document.querySelector("[data-canvas-text-editor]")?.value, "前景文字");
  });
});

test("mask-local erase cannot be selected for an empty target layer", async () => {
  await withEditor("empty-mask-layer-erase", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=mask]").click();
    const erase = document.querySelector('[data-mask-operation="erase"]');
    assert.equal(erase.disabled, false);
    assert.equal(erase.getAttribute("aria-disabled"), "true");
    erase.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: false }));
    assert.equal(erase.getAttribute("aria-pressed"), "false");

    drawStroke(dom.window, canvas, 1, [{ x: 200, y: 500 }, { x: 800, y: 500 }]);
    assert.equal(erase.disabled, false);
    assert.equal(erase.getAttribute("aria-disabled"), "false");
    erase.click();
    assert.equal(erase.getAttribute("aria-pressed"), "true");

    document.querySelector('[data-mask-mode="protect"]').click();
    assert.equal(erase.disabled, false);
    assert.equal(erase.getAttribute("aria-disabled"), "true");
    assert.equal(document.querySelector('[data-mask-operation="paint"]').getAttribute("aria-pressed"), "true");
  });
});

test("removing the last painted mask stroke resets local erase before the next stroke", async () => {
  await withEditor("mask-erase-reset-after-delete", async ({ dom, canvas, host }) => {
    document.querySelector("[data-tool=mask]").click();
    drawStroke(dom.window, canvas, 1, [{ x: 200, y: 500 }, { x: 800, y: 500 }]);
    document.querySelector('[data-mask-operation="erase"]').click();

    document.querySelector("[data-tool=eraser]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 500, clientY: 500, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 500, clientY: 500, pointerId: 2 }));
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);

    document.querySelector("[data-tool=mask]").click();
    assert.equal(document.querySelector('[data-mask-operation="paint"]').getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector('[data-mask-operation="erase"]').getAttribute("aria-pressed"), "false");
    drawStroke(dom.window, canvas, 3, [{ x: 300, y: 600 }, { x: 700, y: 600 }]);

    document.querySelector("[data-action=submit]").click();
    await waitFor(() => host.toolCalls.some(({ name }) => name === "prepare_image_edit_submission"));
    const prepare = host.toolCalls.find(({ name }) => name === "prepare_image_edit_submission");
    assert.deepEqual(prepare.arguments.items.map(({ mode, operation }) => [mode, operation]), [["edit", "paint"]]);
  });
});

test("clearing an empty mask layer resets local erase before the next stroke", async () => {
  await withEditor("mask-erase-reset-after-clear", async ({ dom, canvas, host }) => {
    document.querySelector("[data-tool=mask]").click();
    drawStroke(dom.window, canvas, 1, [{ x: 200, y: 500 }, { x: 800, y: 500 }]);
    document.querySelector('[data-mask-operation="erase"]').click();
    document.querySelector("[data-action=clear]").click();
    document.querySelector("[data-action=confirm-clear]").click();

    assert.equal(document.querySelector('[data-mask-operation="paint"]').getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector('[data-mask-operation="erase"]').getAttribute("aria-pressed"), "false");
    drawStroke(dom.window, canvas, 2, [{ x: 300, y: 600 }, { x: 700, y: 600 }]);

    document.querySelector("[data-action=submit]").click();
    await waitFor(() => host.toolCalls.some(({ name }) => name === "prepare_image_edit_submission"));
    const prepare = host.toolCalls.find(({ name }) => name === "prepare_image_edit_submission");
    assert.deepEqual(prepare.arguments.items.map(({ mode, operation }) => [mode, operation]), [["edit", "paint"]]);
  });
});

test("a completed automatic submission resets local erase even when returning inline fails", async () => {
  await withEditor("mask-erase-reset-after-message", async ({ dom, canvas, host }) => {
    document.querySelector("[data-tool=mask]").click();
    drawStroke(dom.window, canvas, 1, [{ x: 200, y: 500 }, { x: 800, y: 500 }]);
    document.querySelector('[data-mask-operation="erase"]').click();

    document.querySelector("[data-action=submit]").click();
    await waitFor(() => host.messages.length === 1);
    await waitFor(() => host.displayModeRequests.filter((mode) => mode === "inline").length === 1);

    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
    assert.equal(document.querySelector('[data-mask-operation="paint"]').getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector('[data-mask-operation="erase"]').getAttribute("aria-pressed"), "false");
    assert.equal(document.querySelector('[data-mask-operation="erase"]').getAttribute("aria-disabled"), "true");
  }, { rejectDisplayMode: "inline" });
});

test("deleting the last paint stroke also removes orphaned local erase strokes", async () => {
  await withEditor("mask-orphan-erase-after-delete", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=mask]").click();
    drawStroke(dom.window, canvas, 1, [{ x: 200, y: 500 }, { x: 800, y: 500 }]);
    document.querySelector('[data-mask-operation="erase"]').click();
    drawStroke(dom.window, canvas, 2, [{ x: 450, y: 500 }, { x: 550, y: 500 }]);

    document.querySelector("[data-tool=eraser]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 300, clientY: 500, pointerId: 3 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 500, pointerId: 3 }));

    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
    document.querySelector("[data-tool=mask]").click();
    assert.equal(document.querySelector('[data-mask-operation="paint"]').getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector('[data-mask-operation="erase"]').getAttribute("aria-disabled"), "true");
  });
});

test("secondary-pointer gestures never draw, move, or erase annotations", async () => {
  await withEditor("secondary-pointer-guard", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=mask]").click();
    drawStroke(dom.window, canvas, 1, [{ x: 200, y: 500 }, { x: 800, y: 500 }], { button: 2 });
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);

    drawStroke(dom.window, canvas, 2, [{ x: 200, y: 500 }, { x: 800, y: 500 }]);
    const beforeMove = document.querySelector("[data-layer]").innerHTML;
    document.querySelector("[data-tool=select]").click();
    drawStroke(dom.window, canvas, 3, [{ x: 500, y: 500 }, { x: 700, y: 700 }], { button: 2 });
    assert.equal(document.querySelector("[data-layer]").innerHTML, beforeMove);

    document.querySelector("[data-tool=eraser]").click();
    drawStroke(dom.window, canvas, 4, [{ x: 500, y: 500 }, { x: 500, y: 500 }], { button: 2 });
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
  });
});

test("hidden annotations do not receive canvas selection or whole-object erase hits", async () => {
  await withEditor("hidden-annotation-hit-testing", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=text]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 300, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 200, clientY: 300, pointerId: 1 }));
    const inlineEditor = document.querySelector("[data-canvas-text-editor]");
    inlineEditor.value = "隐藏后不可命中";
    inlineEditor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    inlineEditor.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

    document.querySelector("[data-action=toggle-annotations]").click();
    assert.equal(document.querySelector("[data-layer]").hidden, true);

    document.querySelector("[data-tool=select]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 250, clientY: 292, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 250, clientY: 292, pointerId: 2 }));
    assert.equal(document.querySelector("[data-canvas-text-editor]"), null);

    document.querySelector("[data-tool=eraser]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 250, clientY: 292, pointerId: 3 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 250, clientY: 292, pointerId: 3 }));
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
  });
});

test("hidden annotations become visible when a new drawing gesture starts", async () => {
  await withEditor("hidden-annotation-new-drawing", async ({ dom, canvas }) => {
    document.querySelector("[data-action=toggle-annotations]").click();
    assert.equal(document.querySelector("[data-layer]").hidden, true);

    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 180, clientY: 180, pointerId: 1 }));
    assert.equal(document.querySelector("[data-layer]").hidden, false);
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 420, clientY: 360, pointerId: 1 }));

    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
    assert.equal(document.querySelector("[data-action=toggle-annotations]").getAttribute("aria-pressed"), "true");
  });
});

test("dynamic intent actions and version navigation accept direct host clicks", async () => {
  const childId = "img_01J00000000000000000000001";
  await withEditor("dynamic-direct-actions", async ({ dom, canvas, host }) => {
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 120, clientY: 120, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 360, clientY: 300, pointerId: 1 }));

    document.querySelector('[data-color-slot="1"]').click();
    const apply = document.querySelector("[data-action=apply-foreground-color]");
    apply.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: false, cancelable: true }));
    assert.ok(document.querySelector('[data-layer] rect[stroke="#2563eb"]'));

    const remove = document.querySelector("[data-action=remove-annotation]");
    remove.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: false, cancelable: true }));
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);

    const version = document.querySelector(`[data-version-id="${childId}"]`);
    assert.ok(version);
    version.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: false, cancelable: true }));
    await waitFor(() => document.querySelector("[data-image-id]")?.textContent === childId);
    assert.ok(host.toolCalls.some(({ name, arguments: args }) => name === "read_image_artifact_data" && args.imageId === childId));
  }, { children: [{ id: childId }] });
});

test("closing the intent drawer returns focus to its topbar trigger", async () => {
  await withEditor("intent-drawer-focus", async () => {
    const toggle = document.querySelector("[data-action=toggle-intents]");
    const close = document.querySelector("[data-intent-panel] [data-action=toggle-intents]");
    toggle.click();
    assert.equal(document.querySelector("[data-intent-panel]").classList.contains("open"), true);
    close.click();
    assert.equal(document.querySelector("[data-intent-panel]").classList.contains("open"), false);
    assert.equal(document.activeElement, toggle);
  });
});

test("mask local erase exposes its unavailable reason through an accessible description", async () => {
  await withEditor("mask-erase-description", async () => {
    document.querySelector("[data-tool=mask]").click();
    const erase = document.querySelector('[data-mask-operation="erase"]');
    assert.equal(erase.disabled, false);
    assert.equal(erase.getAttribute("aria-disabled"), "true");
    const describedBy = erase.getAttribute("aria-describedby");
    assert.ok(describedBy);
    const hint = document.getElementById(describedBy);
    assert.ok(hint);
    assert.match(hint.textContent, /先在当前区域层绘制蒙版/);
  });
});

test("the mask-local eraser is separate from whole-annotation erase and survives submission", async () => {
  await withEditor("mask-eraser", async ({ dom, canvas, host }) => {
    document.querySelector("[data-tool=mask]").click();
    drawStroke(dom.window, canvas, 1, [{ x: 200, y: 500 }, { x: 800, y: 500 }]);
    document.querySelector('[data-mask-operation="erase"]').click();
    drawStroke(dom.window, canvas, 2, [{ x: 450, y: 500 }, { x: 550, y: 500 }]);

    assert.equal(document.querySelector("[data-tool=eraser]").getAttribute("aria-label"), "擦除");
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
    assert.equal(document.querySelector("[data-summary]").textContent, "已标注 1 处");
    assert.equal(document.querySelectorAll("[data-layer] .annotation-index").length, 1);
    assert.equal(document.querySelector("[data-layer] .mask-erase-outline"), null);
    assert.equal(document.querySelectorAll('[data-layer] [data-mask-operation="erase"]').length, 1);
    document.querySelector("[data-action=undo]").click();
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
    assert.equal(document.querySelectorAll('[data-layer] [data-mask-operation="erase"]').length, 0);
    document.querySelector("[data-action=redo]").click();
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
    assert.equal(document.querySelectorAll('[data-layer] [data-mask-operation="erase"]').length, 1);

    document.querySelector("[data-action=submit]").click();
    await waitFor(() => host.toolCalls.some(({ name }) => name === "prepare_image_edit_submission"));
    const prepare = host.toolCalls.find(({ name }) => name === "prepare_image_edit_submission");
    assert.deepEqual(prepare.arguments.items.map(({ mode, operation }) => [mode, operation]), [
      ["edit", "paint"],
      ["edit", "erase"],
    ]);
  });
});

test("non-bubbling mask controls still configure the submitted paint and erase strokes", async () => {
  await withEditor("non-bubbling-mask-controls", async ({ dom, canvas, host }) => {
    document.querySelector("[data-tool=mask]").click();
    document.querySelector('[data-mask-mode="protect"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: false }));
    document.querySelector('[data-mask-radius="0.06"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: false }));
    drawStroke(dom.window, canvas, 1, [{ x: 200, y: 500 }, { x: 800, y: 500 }]);
    document.querySelector('[data-mask-operation="erase"]').dispatchEvent(new dom.window.MouseEvent("click", { bubbles: false }));
    drawStroke(dom.window, canvas, 2, [{ x: 450, y: 500 }, { x: 550, y: 500 }]);

    document.querySelector("[data-action=submit]").click();
    await waitFor(() => host.toolCalls.some(({ name }) => name === "prepare_image_edit_submission"));
    const prepare = host.toolCalls.find(({ name }) => name === "prepare_image_edit_submission");
    assert.deepEqual(prepare.arguments.items.map(({ mode, operation, brushRadius }) => [mode, operation, brushRadius]), [
      ["protect", "paint", 0.06],
      ["protect", "erase", 0.06],
    ]);
  });
});

test("keyboard nudges the selected annotation with accelerated shift steps and one-step undo", async () => {
  await withEditor("keyboard-nudge", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 200, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 400, clientY: 400, pointerId: 1 }));

    const rectangle = () => document.querySelector("[data-layer] rect");
    assert.equal(rectangle().getAttribute("x"), "200");
    canvas.focus();
    assert.equal(document.activeElement, canvas);
    canvas.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    assert.equal(rectangle().getAttribute("x"), "201");
    canvas.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown", shiftKey: true }));
    assert.equal(rectangle().getAttribute("y"), "210");

    document.querySelector("[data-action=undo]").click();
    assert.equal(rectangle().getAttribute("y"), "200");
    assert.equal(rectangle().getAttribute("x"), "201");
  }, { artifactOverride: imageArtifact(1000, 1000) });
});

test("keyboard creates rectangle, arrow, pen, and mask annotations as one-step history entries", async () => {
  await withEditor("keyboard-create-drawing-tools", async ({ dom, canvas }) => {
    for (const [tool, selector] of [
      ["rectangle", "[data-layer] rect"],
      ["arrow", "[data-layer] line"],
      ["pen", "[data-layer] polyline"],
      ["mask", '[data-layer] [data-mask-layer="edit"]'],
    ]) {
      document.querySelector(`[data-tool=${tool}]`).click();
      canvas.focus();
      keyDown(dom.window, canvas, " ");
      assert.ok(document.querySelector("[data-keyboard-cursor]"));
      keyDown(dom.window, canvas, "ArrowRight", { shiftKey: true });
      keyDown(dom.window, canvas, "ArrowDown", { shiftKey: true });
      keyDown(dom.window, canvas, "Enter");

      assert.ok(document.querySelector(selector), `${tool} should render after keyboard commit`);
      const count = document.querySelectorAll("[data-annotation-id]").length;
      document.querySelector("[data-action=undo]").click();
      assert.equal(document.querySelectorAll("[data-annotation-id]").length, count - 1);
    }
  }, { artifactOverride: imageArtifact(1000, 1000) });
});

test("keyboard text enters inline editing while native fields retain Enter and arrow keys", async () => {
  await withEditor("keyboard-create-text", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=text]").click();
    canvas.focus();
    keyDown(dom.window, canvas, "ArrowLeft", { shiftKey: true });
    keyDown(dom.window, canvas, "Enter");

    const textEditor = document.querySelector("[data-canvas-text-editor]");
    assert.ok(textEditor);
    assert.equal(document.activeElement, textEditor);
    keyDown(dom.window, textEditor, "Escape");

    const prompt = document.querySelector("[data-prompt]");
    prompt.focus();
    const before = document.querySelectorAll("[data-annotation-id]").length;
    const enter = keyDown(dom.window, prompt, "Enter");
    const arrow = keyDown(dom.window, prompt, "ArrowRight");
    assert.equal(enter.defaultPrevented, false);
    assert.equal(arrow.defaultPrevented, false);
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, before);
  }, { artifactOverride: imageArtifact(1000, 1000) });
});

test("keyboard can create consecutive annotations without reselecting the tool", async () => {
  await withEditor("keyboard-consecutive-create", async ({ dom, canvas }) => {
    document.querySelector("[data-tool=rectangle]").click();
    canvas.focus();
    for (let index = 0; index < 2; index += 1) {
      keyDown(dom.window, canvas, " ");
      keyDown(dom.window, canvas, "ArrowRight", { shiftKey: true });
      keyDown(dom.window, canvas, "ArrowDown", { shiftKey: true });
      keyDown(dom.window, canvas, "Enter");
    }

    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 2);
    assert.equal(document.querySelectorAll("[data-layer] rect").length, 2);
  }, { artifactOverride: imageArtifact(1000, 1000) });
});

test("toolbar undo and redo discard an unfinished keyboard drawing", async () => {
  await withEditor("keyboard-history-discard", async ({ dom, canvas }) => {
    commitKeyboardRectangle(dom.window, canvas);
    document.querySelector("[data-action=undo]").click();
    startKeyboardRectangle(dom.window, canvas);

    document.querySelector("[data-action=redo]").click();
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
    assert.equal(document.querySelector("[data-keyboard-cursor]"), null);
    keyDown(dom.window, canvas, "Enter");
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);

    startKeyboardRectangle(dom.window, canvas);
    document.querySelector("[data-action=undo]").click();
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
    assert.equal(document.querySelector("[data-keyboard-cursor]"), null);
    keyDown(dom.window, canvas, "Enter");
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
  }, { artifactOverride: imageArtifact(1000, 1000) });
});

test("clearing a draft discards its unfinished keyboard drawing", async () => {
  await withEditor("keyboard-clear-discard", async ({ dom, canvas }) => {
    commitKeyboardRectangle(dom.window, canvas);
    startKeyboardRectangle(dom.window, canvas);

    document.querySelector("[data-action=clear]").click();
    document.querySelector("[data-action=confirm-clear]").click();
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
    assert.equal(document.querySelector("[data-keyboard-cursor]"), null);
    keyDown(dom.window, canvas, "Enter");
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
  }, { artifactOverride: imageArtifact(1000, 1000) });
});

test("returning and reopening the canvas does not revive an unfinished keyboard drawing", async () => {
  await withEditor("keyboard-return-discard", async ({ dom, canvas }) => {
    commitKeyboardRectangle(dom.window, canvas);
    startKeyboardRectangle(dom.window, canvas);

    document.querySelector("[data-action=back]").click();
    await waitFor(() => document.querySelector(".inline-result") !== null);
    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => document.querySelector(".editor-app") !== null);
    const reopenedCanvas = document.querySelector("[data-canvas]");
    assert.equal(document.querySelector("[data-keyboard-cursor]"), null);
    keyDown(dom.window, reopenedCanvas, "Enter");
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
  }, { artifactOverride: imageArtifact(1000, 1000) });
});

test("switching away and back does not revive an unfinished keyboard drawing", async () => {
  const childId = "img_01J00000000000000000000001";
  await withEditor("keyboard-version-discard", async ({ dom, canvas, host }) => {
    startKeyboardRectangle(dom.window, canvas);
    document.querySelector(`[data-version-id="${childId}"]`).click();
    await waitFor(() => host.pendingArtifactDataRequestCount >= 2);
    keyDown(dom.window, canvas, " ");
    keyDown(dom.window, canvas, "ArrowRight", { shiftKey: true });
    keyDown(dom.window, canvas, "ArrowDown", { shiftKey: true });
    keyDown(dom.window, canvas, "Enter");
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
    while (host.pendingArtifactDataRequestCount) host.resolveArtifactData(childId);
    await waitFor(() => document.querySelector("[data-image-id]")?.textContent === childId);
    document.querySelector(`[data-version-id="${imageArtifact(1, 1).id}"]`).click();
    await waitFor(() => document.querySelector("[data-image-id]")?.textContent === imageArtifact(1, 1).id);

    assert.equal(document.querySelector("[data-keyboard-cursor]"), null);
    keyDown(dom.window, document.querySelector("[data-canvas]"), "Enter");
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
  }, { children: [{ id: childId }], deferArtifactDataImageIds: [childId] });
});

test("submitting a committed annotation does not preserve a second unfinished keyboard drawing", async () => {
  await withEditor("keyboard-submit-discard", async ({ dom, canvas, host }) => {
    commitKeyboardRectangle(dom.window, canvas);
    startKeyboardRectangle(dom.window, canvas);
    document.querySelector("[data-action=submit]").click();
    await waitFor(() => document.querySelector(".inline-result") !== null);
    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => document.querySelector(".editor-app") !== null);

    const reopenedCanvas = document.querySelector("[data-canvas]");
    assert.equal(document.querySelector("[data-keyboard-cursor]"), null);
    keyDown(dom.window, reopenedCanvas, "Enter");
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
    assert.equal(host.toolCalls.find(({ name }) => name === "prepare_image_edit_submission")?.arguments.items.length, 1);
  }, { artifactOverride: imageArtifact(1000, 1000) });
});

test("destroy-in-flight locks keyboard annotation creation", async () => {
  await withEditor("keyboard-destroy-lock", async ({ dom, canvas, host }) => {
    document.querySelector("[data-tool=rectangle]").click();
    document.querySelector("[data-action=destroy]").click();
    document.querySelector("[data-action=confirm-destroy]").click();
    await waitFor(() => host.pendingDestroyImageEditorRequestCount === 1);

    canvas.focus();
    keyDown(dom.window, canvas, " ");
    keyDown(dom.window, canvas, "ArrowRight", { shiftKey: true });
    keyDown(dom.window, canvas, "ArrowDown", { shiftKey: true });
    keyDown(dom.window, canvas, "Enter");
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
    assert.equal(document.querySelector("[data-keyboard-cursor]"), null);
    host.resolveDestroyImageEditor();
    await waitFor(() => document.querySelector(".inline-result") !== null);
  }, { artifactOverride: imageArtifact(1000, 1000), deferDestroyImageEditor: true });
});

test("hidden annotations become visible when keyboard drawing starts", async () => {
  await withEditor("keyboard-hidden-annotation", async ({ dom, canvas }) => {
    document.querySelector("[data-action=toggle-annotations]").click();
    document.querySelector("[data-tool=rectangle]").click();
    canvas.focus();
    keyDown(dom.window, canvas, " ");

    assert.equal(document.querySelector("[data-layer]").hidden, false);
    assert.equal(document.querySelector("[data-action=toggle-annotations]").getAttribute("aria-pressed"), "true");
  }, { artifactOverride: imageArtifact(1000, 1000) });
});

test("close guidance toggles on activation, closes on Escape, and closes when focus leaves", async () => {
  await withEditor("close-guidance-disclosure", async ({ dom }) => {
    const guidance = document.querySelector("[data-close-guidance]");
    const wrap = document.querySelector("[data-close-guidance-wrap]");
    guidance.focus();
    assert.equal(guidance.getAttribute("aria-expanded"), "true");
    assert.equal(wrap.dataset.open, "true");

    keyDown(dom.window, guidance, "Escape");
    assert.equal(guidance.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, guidance);

    wrap.dispatchEvent(new dom.window.MouseEvent("mouseenter"));
    guidance.click();
    wrap.dispatchEvent(new dom.window.MouseEvent("mouseleave"));
    assert.equal(guidance.getAttribute("aria-expanded"), "true");

    guidance.click();
    assert.equal(guidance.getAttribute("aria-expanded"), "false");
    guidance.click();

    document.querySelector("[data-action=toggle-annotations]").focus();
    assert.equal(guidance.getAttribute("aria-expanded"), "false");
  });
});

test("close guidance resets transient focus state after the editor remounts", async () => {
  await withEditor("close-guidance-remount", async ({ dom }) => {
    document.querySelector("[data-close-guidance]").focus();
    document.querySelector("[data-action=back]").click();
    await waitFor(() => document.querySelector(".inline-result") !== null);
    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => document.querySelector("[data-close-guidance]") !== null);

    const guidance = document.querySelector("[data-close-guidance]");
    const wrap = document.querySelector("[data-close-guidance-wrap]");
    wrap.dispatchEvent(new dom.window.MouseEvent("mouseenter"));
    wrap.dispatchEvent(new dom.window.MouseEvent("mouseleave"));
    assert.equal(guidance.getAttribute("aria-expanded"), "false");
  });
});

function keyDown(window, target, key, options = {}) {
  const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...options });
  target.dispatchEvent(event);
  return event;
}

function startKeyboardRectangle(window, canvas) {
  document.querySelector("[data-tool=rectangle]").click();
  canvas.focus();
  keyDown(window, canvas, " ");
  keyDown(window, canvas, "ArrowRight", { shiftKey: true });
  keyDown(window, canvas, "ArrowDown", { shiftKey: true });
}

function commitKeyboardRectangle(window, canvas) {
  startKeyboardRectangle(window, canvas);
  keyDown(window, canvas, "Enter");
}

async function withEditor(name, callback, hostOptions = {}) {
  const dom = new JSDOM(
    "<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>",
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor", ...hostOptions });
  try {
    await import(`../web/editor-runtime.mjs?modern-${name}=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    await waitFor(() => document.querySelector("[data-tool=mask]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    await callback({ dom, canvas, host });
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
}

function drawStroke(window, canvas, pointerId, points, { button = 0 } = {}) {
  const [start, ...rest] = points;
  const pressedButtons = button === 0 ? 1 : 2;
  canvas.dispatchEvent(pointerEvent(window, "pointerdown", { clientX: start.x, clientY: start.y, pointerId, button, buttons: pressedButtons }));
  for (const point of rest) {
    canvas.dispatchEvent(pointerEvent(window, "pointermove", { clientX: point.x, clientY: point.y, pointerId, button, buttons: pressedButtons }));
  }
  const end = points.at(-1);
  canvas.dispatchEvent(pointerEvent(window, "pointerup", { clientX: end.x, clientY: end.y, pointerId, button, buttons: 0 }));
}

function imageArtifact(width, height) {
  return {
    id: "img_01J00000000000000000000000",
    mimeType: "image/png",
    width,
    height,
    operation: "generate",
    parentIds: [],
    childIds: [],
  };
}

function maskOverlayPoints() {
  return document.querySelector('[data-layer] [data-mask-operation="paint"]')
    ?.getAttribute("points")
    ?.trim()
    .split(/\s+/) || [];
}
