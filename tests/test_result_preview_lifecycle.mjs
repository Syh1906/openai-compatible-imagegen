import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import {
  IMAGE_ID,
  installDomGlobals,
  installHost,
  pointerEvent,
  restoreDomGlobals,
  sendToApp,
  waitFor,
} from "./support/widget-runtime-host.mjs";
import {
  createResultFileRevealController,
  createResultPreviewSession,
} from "../web/result-preview.mjs";

const artifact = {
  id: IMAGE_ID,
  mimeType: "image/png",
  width: 1024,
  height: 768,
  operation: "generate",
  parentIds: [],
  childIds: [],
};

test("an external return during preview opening wins over the stale fullscreen response", async () => {
  const fixture = await openDeferredPreview("opening-external-return");
  const { dom, host } = fixture;

  try {
    const preview = document.querySelector("[data-result-preview]");
    const zoomIn = preview.querySelector("[data-preview-action=zoom-in]");
    zoomIn.click();
    zoomIn.focus();

    host.notifyHostContext("fullscreen");
    await waitFor(() => document.querySelector("[data-result-preview]") !== null);
    assert.equal(document.querySelector("[data-result-preview]"), preview);
    assert.equal(preview.dataset.previewScale, "1.25");
    assert.equal(document.activeElement, zoomIn);

    host.notifyHostContext("inline");
    await waitFor(() => document.querySelector("[data-result-preview]") === null);
    host.resolveDisplayModeRequest("fullscreen", { notifyAfter: false });
    await nextTask();

    assert.equal(document.querySelector("[data-result-preview]"), null);
    assert.equal(host.toolCalls.some(({ name }) => name === "open_image_editor"), false);
    await waitFor(() => document.activeElement === document.querySelector("[data-action=preview-image]"));
  } finally {
    await fixture.dispose();
  }
});

test("an inline host return cancels an opening preview before the stale fullscreen response", async () => {
  const fixture = await openDeferredPreview("opening-inline-cancel");
  const { host } = fixture;

  try {
    host.notifyHostContext("inline");
    await nextTask();
    assert.equal(document.querySelector("[data-result-preview]"), null);

    host.resolveDisplayModeRequest("fullscreen", { notifyAfter: false });
    await nextTask();
    assert.equal(document.querySelector("[data-result-preview]"), null);
  } finally {
    await fixture.dispose();
  }
});

test("a delayed inline echo from the closed session does not close a reopened preview", async () => {
  const fixture = await openDeferredPreview("reopen-after-delayed-inline");
  const { host } = fixture;

  try {
    host.resolveDisplayModeRequest("fullscreen");
    await nextTask();
    document.querySelector("[data-preview-action=close]").click();
    await waitFor(() => host.pendingDisplayModeRequestCount === 1);
    host.resolveDisplayModeRequest("inline", { notifyAfter: false });
    await waitFor(() => document.querySelector("[data-result-preview]") === null);

    document.querySelector("[data-action=preview-image]").click();
    await waitFor(() => host.pendingDisplayModeRequestCount === 1);
    const reopenedPreview = document.querySelector("[data-result-preview]");
    host.notifyHostContext("inline");
    await nextTask();
    assert.equal(document.querySelector("[data-result-preview]"), reopenedPreview);
    host.notifyHostContext("inline");
    await nextTask();
    assert.equal(document.querySelector("[data-result-preview]"), reopenedPreview);

    host.resolveDisplayModeRequest("fullscreen", { notifyAfter: false });
    await nextTask();
    assert.equal(document.querySelector("[data-result-preview]"), reopenedPreview);
  } finally {
    await fixture.dispose();
  }
});

test("a delayed fullscreen and inline echo pair from the closed session does not close a reopening preview", async () => {
  const fixture = await openDeferredPreview("reopen-after-reordered-host-echo-pair");
  const { host } = fixture;

  try {
    host.resolveDisplayModeRequest("fullscreen");
    await nextTask();
    document.querySelector("[data-preview-action=close]").click();
    await waitFor(() => host.pendingDisplayModeRequestCount === 1);
    host.resolveDisplayModeRequest("inline", { notifyAfter: false });
    await waitFor(() => document.querySelector("[data-result-preview]") === null);

    document.querySelector("[data-action=preview-image]").click();
    await waitFor(() => host.pendingDisplayModeRequestCount === 1);
    const reopenedPreview = document.querySelector("[data-result-preview]");

    host.notifyHostContext("fullscreen");
    host.notifyHostContext("inline");
    await nextTask();

    assert.equal(document.querySelector("[data-result-preview]"), reopenedPreview);
    host.resolveDisplayModeRequest("fullscreen", { notifyAfter: false });
    await nextTask();
    assert.equal(document.querySelector("[data-result-preview]"), reopenedPreview);
  } finally {
    await fixture.dispose();
  }
});

test("a delayed inline echo arriving after the reopened fullscreen response does not close the new preview", async () => {
  const fixture = await openDeferredPreview("reopen-after-late-settled-inline");
  const { host } = fixture;

  try {
    host.resolveDisplayModeRequest("fullscreen");
    await nextTask();
    document.querySelector("[data-preview-action=close]").click();
    await waitFor(() => host.pendingDisplayModeRequestCount === 1);
    host.resolveDisplayModeRequest("inline", { notifyAfter: false });
    await waitFor(() => document.querySelector("[data-result-preview]") === null);

    document.querySelector("[data-action=preview-image]").click();
    await waitFor(() => host.pendingDisplayModeRequestCount === 1);
    const reopenedPreview = document.querySelector("[data-result-preview]");
    host.resolveDisplayModeRequest("fullscreen", { notifyAfter: false });
    await nextTask();

    host.notifyHostContext("inline");
    await nextTask();
    assert.equal(document.querySelector("[data-result-preview]"), reopenedPreview);
  } finally {
    await fixture.dispose();
  }
});

test("a fresh fullscreen notification makes the next inline notification close the reopened preview", async () => {
  const fixture = await openDeferredPreview("reopen-after-fullscreen-barrier");
  const { host } = fixture;

  try {
    host.resolveDisplayModeRequest("fullscreen");
    await nextTask();
    document.querySelector("[data-preview-action=close]").click();
    await waitFor(() => host.pendingDisplayModeRequestCount === 1);
    host.resolveDisplayModeRequest("inline", { notifyAfter: false });
    await waitFor(() => document.querySelector("[data-result-preview]") === null);

    document.querySelector("[data-action=preview-image]").click();
    await waitFor(() => host.pendingDisplayModeRequestCount === 1);
    host.resolveDisplayModeRequest("fullscreen");
    await nextTask();
    assert.notEqual(document.querySelector("[data-result-preview]"), null);

    host.notifyHostContext("inline");
    await waitFor(() => document.querySelector("[data-result-preview]") === null);
  } finally {
    await fixture.dispose();
  }
});

test("a fullscreen notification before the reopened request resolves makes the next inline close the preview", async () => {
  const fixture = await openDeferredPreview("reopen-after-early-fullscreen-barrier");
  const { host } = fixture;

  try {
    host.resolveDisplayModeRequest("fullscreen");
    await nextTask();
    document.querySelector("[data-preview-action=close]").click();
    await waitFor(() => host.pendingDisplayModeRequestCount === 1);
    host.resolveDisplayModeRequest("inline", { notifyAfter: false });
    await waitFor(() => document.querySelector("[data-result-preview]") === null);

    document.querySelector("[data-action=preview-image]").click();
    await waitFor(() => host.pendingDisplayModeRequestCount === 1);
    host.notifyHostContext("fullscreen");
    await nextTask();
    assert.notEqual(document.querySelector("[data-result-preview]"), null);

    host.resolveDisplayModeRequest("fullscreen", { notifyAfter: false });
    await nextTask();
    host.notifyHostContext("inline");
    await waitFor(() => document.querySelector("[data-result-preview]") === null);
  } finally {
    await fixture.dispose();
  }
});

test("a delayed host notification preserves preview state and restored result focus", async () => {
  const fixture = await openDeferredPreview("delayed-host-context");
  const { host } = fixture;

  try {
    host.resolveDisplayModeRequest("fullscreen", { notifyAfter: false });
    await nextTask();
    const preview = document.querySelector("[data-result-preview]");
    const zoomIn = preview.querySelector("[data-preview-action=zoom-in]");
    zoomIn.click();
    zoomIn.click();
    const viewport = preview.querySelector("[data-preview-viewport]");
    viewport.scrollLeft = 19;
    viewport.scrollTop = 23;
    zoomIn.focus();

    host.notifyHostContextChanged({ availableDisplayModes: ["fullscreen", "inline"] });
    await nextTask();
    assert.equal(document.querySelector("[data-result-preview]"), preview);
    assert.equal(preview.dataset.previewScale, "1.5");

    host.notifyHostContext("fullscreen");
    await nextTask();
    assert.equal(document.querySelector("[data-result-preview]"), preview);
    assert.equal(preview.dataset.previewScale, "1.5");
    assert.deepEqual([viewport.scrollLeft, viewport.scrollTop], [19, 23]);
    assert.equal(document.activeElement, zoomIn);

    preview.querySelector("[data-preview-action=close]").click();
    await waitFor(() => host.pendingDisplayModeRequestCount === 1);
    host.resolveDisplayModeRequest("inline", { notifyAfter: false });
    await waitFor(() => document.querySelector("[data-result-preview]") === null);
    await waitFor(() => document.activeElement === document.querySelector("[data-action=preview-image]"));
    const returnedTrigger = document.activeElement;

    host.notifyHostContext("inline");
    await nextTask();
    assert.equal(document.activeElement, returnedTrigger);
    assert.equal(document.querySelector("[data-action=preview-image]"), returnedTrigger);
  } finally {
    await fixture.dispose();
  }
});

test("Escape closes the preview after the key event reaches the widget document", async () => {
  const fixture = await openDeferredPreview("fullscreen-focus-restore");
  const { dom, host } = fixture;

  try {
    const trigger = document.querySelector("[data-action=preview-image]");
    const closeButton = document.querySelector("[data-preview-action=close]");
    assert.equal(closeButton.getAttribute("aria-keyshortcuts"), null);
    assert.equal(closeButton.getAttribute("title"), "关闭图片预览");
    trigger.focus();
    assert.equal(document.activeElement, trigger, "测试必须先模拟宿主过渡把焦点移出预览");

    host.notifyHostContext("fullscreen");
    await waitFor(() => document.activeElement === closeButton);

    document.body.tabIndex = -1;
    document.body.focus();
    assert.equal(document.activeElement, document.body, "测试必须覆盖通知后宿主再次夺走焦点");

    host.resolveDisplayModeRequest("fullscreen", { notifyAfter: false });
    await waitFor(() => document.activeElement === closeButton);

    closeButton.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await waitFor(() => host.pendingDisplayModeRequestCount === 1);
    host.resolveDisplayModeRequest("inline");
    await waitFor(() => document.querySelector("[data-result-preview]") === null);
  } finally {
    await fixture.dispose();
  }
});

test("an inline host notification completes closing even if the request rejects later", async () => {
  const fixture = await openDeferredPreview("closing-host-context");
  const { host } = fixture;

  try {
    host.resolveDisplayModeRequest("fullscreen");
    await nextTask();
    document.querySelector("[data-preview-action=close]").click();
    await waitFor(() => host.pendingDisplayModeRequestCount === 1);

    host.notifyHostContext("inline");
    await waitFor(() => document.querySelector("[data-result-preview]") === null);
    host.rejectDisplayModeRequest("inline");
    await nextTask();

    assert.equal(document.querySelector("[data-result-preview]"), null);
    assert.equal(document.querySelector("[data-inline-status]")?.textContent, "");
    assert.equal(host.toolCalls.some(({ name }) => name === "open_image_editor"), false);
  } finally {
    await fixture.dispose();
  }
});

test("an explicit inline notification closes an acknowledged preview without a prior fullscreen notification", async () => {
  const fixture = await openDeferredPreview("inline-without-fullscreen-notification");
  const { host } = fixture;

  try {
    host.resolveDisplayModeRequest("fullscreen", { notifyAfter: false });
    await nextTask();
    assert.notEqual(document.querySelector("[data-result-preview]"), null);

    host.notifyHostContext("inline");
    await waitFor(() => document.querySelector("[data-result-preview]") === null);
    await waitFor(() => document.activeElement === document.querySelector("[data-action=preview-image]"));
    assert.equal(host.toolCalls.some(({ name }) => name === "open_image_editor"), false);
  } finally {
    await fixture.dispose();
  }
});

test("panning a zoomed preview moves the viewport without turning pointer release into a backdrop close", async () => {
  const fixture = await openDeferredPreview("zoomed-pan");
  const { dom, host } = fixture;

  try {
    host.resolveDisplayModeRequest("fullscreen");
    await nextTask();
    const preview = document.querySelector("[data-result-preview]");
    const viewport = preview.querySelector("[data-preview-viewport]");
    const image = preview.querySelector("[data-preview-image]");
    for (let index = 0; index < 4; index += 1) preview.querySelector("[data-preview-action=zoom-in]").click();
    viewport.scrollLeft = 100;
    viewport.scrollTop = 100;
    const capturedPointers = [];
    const releasedPointers = [];
    viewport.setPointerCapture = (pointerId) => capturedPointers.push(pointerId);
    viewport.releasePointerCapture = (pointerId) => releasedPointers.push(pointerId);

    image.dispatchEvent(pointerEvent(dom.window, "pointerdown", { pointerId: 7, clientX: 100, clientY: 100 }));
    assert.deepEqual(capturedPointers, []);
    image.dispatchEvent(pointerEvent(dom.window, "pointermove", { pointerId: 7, clientX: 70, clientY: 60 }));
    assert.deepEqual(capturedPointers, [7]);
    viewport.dispatchEvent(pointerEvent(dom.window, "pointerup", { pointerId: 7, clientX: 70, clientY: 60 }));

    assert.deepEqual([viewport.scrollLeft, viewport.scrollTop], [130, 140]);
    assert.deepEqual(releasedPointers, [7]);
    assert.equal(preview.dataset.panning, "false");
    viewport.click();
    assert.equal(document.querySelector("[data-result-preview]"), preview);

    preview.querySelector("[data-preview-stage]").click();
    await waitFor(() => host.pendingDisplayModeRequestCount === 1);
    host.resolveDisplayModeRequest("inline");
    await waitFor(() => document.querySelector("[data-result-preview]") === null);
  } finally {
    await fixture.dispose();
  }
});

test("a zoomed image click stays on the image instead of becoming a backdrop close", async () => {
  const fixture = await openDeferredPreview("zoomed-image-click");
  const { dom, host } = fixture;

  try {
    host.resolveDisplayModeRequest("fullscreen");
    await nextTask();
    const preview = document.querySelector("[data-result-preview]");
    const viewport = preview.querySelector("[data-preview-viewport]");
    const image = preview.querySelector("[data-preview-image]");
    image.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    assert.equal(preview.dataset.previewScale, "2");

    let captureTarget = null;
    viewport.setPointerCapture = () => { captureTarget = viewport; };
    viewport.releasePointerCapture = () => {};
    for (const pointerId of [9, 10]) {
      captureTarget = null;
      image.dispatchEvent(pointerEvent(dom.window, "pointerdown", { pointerId, clientX: 100, clientY: 100 }));
      const releaseTarget = captureTarget ?? image;
      releaseTarget.dispatchEvent(pointerEvent(dom.window, "pointerup", { pointerId, clientX: 100, clientY: 100 }));
      releaseTarget.click();
    }
    image.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await nextTask();

    assert.equal(host.pendingDisplayModeRequestCount, 0);
    assert.equal(document.querySelector("[data-result-preview]"), preview);
    assert.equal(preview.dataset.previewScale, "1");
  } finally {
    await fixture.dispose();
  }
});

test("backdrop jitter while zoomed closes the preview instead of starting a pan", async () => {
  const fixture = await openDeferredPreview("zoomed-backdrop-jitter");
  const { dom, host } = fixture;

  try {
    host.resolveDisplayModeRequest("fullscreen");
    await nextTask();
    const preview = document.querySelector("[data-result-preview]");
    const image = preview.querySelector("[data-preview-image]");
    const stage = preview.querySelector("[data-preview-stage]");
    image.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    assert.equal(preview.dataset.previewScale, "2");

    stage.dispatchEvent(pointerEvent(dom.window, "pointerdown", { pointerId: 8, clientX: 100, clientY: 100 }));
    stage.dispatchEvent(pointerEvent(dom.window, "pointermove", { pointerId: 8, clientX: 104, clientY: 104 }));
    stage.dispatchEvent(pointerEvent(dom.window, "pointerup", { pointerId: 8, clientX: 104, clientY: 104 }));
    stage.click();

    await waitFor(() => host.pendingDisplayModeRequestCount === 1);
    host.resolveDisplayModeRequest("inline");
    await waitFor(() => document.querySelector("[data-result-preview]") === null);
  } finally {
    await fixture.dispose();
  }
});

test("resource teardown freezes a pending result preview display transaction", async () => {
  const fixture = await openDeferredPreview("teardown-pending-preview");
  const { dom, host } = fixture;

  try {
    const focusTarget = document.querySelector("[data-preview-action=zoom-in]");
    focusTarget.focus();
    sendToApp(dom.window, {
      jsonrpc: "2.0",
      id: "teardown-pending-preview",
      method: "ui/resource-teardown",
      params: {},
    });
    await nextTask();

    const markupAfterTeardown = document.querySelector("main").innerHTML;
    const previewStateAfterTeardown = document.body.dataset.previewOpen;
    const focusAfterTeardown = document.activeElement;
    host.resolveDisplayModeRequest("fullscreen", { notifyAfter: false });
    host.notifyHostContext("inline");
    await nextTask();

    assert.equal(document.querySelector("main").innerHTML, markupAfterTeardown);
    assert.equal(document.body.dataset.previewOpen, previewStateAfterTeardown);
    assert.equal(document.activeElement, focusAfterTeardown);
  } finally {
    await fixture.dispose();
  }
});

test("disposing file reveal freezes a late failure and removes global interactions", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><article data-result-image-id="img_01J00000000000000000000000"><button data-action="preview-image" data-preview-image-id="img_01J00000000000000000000000">预览</button><p data-inline-status></p></article></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  let rejectReveal;
  let revealCalls = 0;
  const controller = createResultFileRevealController({
    root: document.querySelector("main"),
    app: {
      callServerTool() {
        revealCalls += 1;
        return new Promise((resolve, reject) => { rejectReveal = reject; });
      },
    },
  });

  try {
    const reveal = controller.reveal(IMAGE_ID);
    await Promise.resolve();
    controller.dispose();
    const markupAfterDispose = document.querySelector("main").innerHTML;
    const focusAfterDispose = document.activeElement;
    rejectReveal(new Error("late reveal failure"));
    await reveal;
    document.querySelector("article").dispatchEvent(new dom.window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
    }));

    assert.equal(document.querySelector("main").innerHTML, markupAfterDispose);
    assert.equal(document.activeElement, focusAfterDispose);
    assert.equal(document.querySelector("[data-result-context-menu]"), null);
    assert.equal(revealCalls, 1);
  } finally {
    controller.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("disposing preview before its initial focus microtask preserves focus", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><button id="outside">外部</button><main><section class="inline-results"><article data-result-image-id="img_01J00000000000000000000000"><button data-action="preview-image" data-preview-image-id="img_01J00000000000000000000000">预览</button></article></section></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const outside = document.querySelector("#outside");
  outside.focus();
  const controller = createResultPreviewSession({
    root: document.querySelector("main"),
    app: { requestDisplayMode: () => new Promise(() => {}) },
    getState: () => ({
      hostReady: true,
      availableDisplayModes: ["inline", "fullscreen"],
      candidates: [artifact],
    }),
    onReveal: () => {},
  });

  try {
    void controller.open(IMAGE_ID);
    controller.dispose();
    await Promise.resolve();
    assert.equal(document.activeElement, outside);
  } finally {
    controller.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

async function openDeferredPreview(label) {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    deferDisplayModeRequests: true,
    initialArtifacts: [artifact],
  });

  await import(`../web/editor-runtime.mjs?result-preview-lifecycle=${label}-${Date.now()}`);
  await waitFor(() => document.querySelector("[data-action=preview-image]") !== null);
  document.querySelector("[data-action=preview-image]").click();
  await waitFor(() => host.pendingDisplayModeRequestCount === 1);
  await waitFor(() => document.querySelector("[data-result-preview]") !== null);

  return {
    dom,
    host,
    async dispose() {
      host.rejectPendingDisplayModeRequests();
      await nextTask();
      host.dispose();
      restoreDomGlobals(previous);
      dom.window.close();
    },
  };
}

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}
