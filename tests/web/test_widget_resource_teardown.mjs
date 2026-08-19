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
} from "../support/widget-runtime-host.mjs";

test("resource teardown saves the latest editor draft before finalizing the session", { timeout: 5000 }, async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor" });

  try {
    await import(`../../web/editor-runtime.mjs?teardown-draft-save=${Date.now()}`);
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);

    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 200, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 400, clientY: 600, pointerId: 1 }));

    const annotation = document.querySelector("[data-annotation-id]");
    assert.ok(annotation);
    annotation.click();
    document.querySelector("[data-stroke='3']").click();
    const description = document.querySelector("[data-annotation-id] textarea");
    description.value = "保留这个矩形区域";
    description.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "背景改为浅灰色";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    sendToApp(dom.window, {
      jsonrpc: "2.0",
      id: "teardown-draft-save",
      method: "ui/resource-teardown",
      params: {},
    });
    await waitFor(() => host.toolCalls.some(({ name }) => name === "finalize_image_editor_session"));

    const saveIndex = host.toolCalls.findIndex(({ name }) => name === "save_image_editor_draft");
    const finalizeIndex = host.toolCalls.findIndex(({ name }) => name === "finalize_image_editor_session");
    assert.ok(saveIndex >= 0, "teardown must save the current draft");
    assert.ok(saveIndex < finalizeIndex, "draft save must finish before session finalization starts");
    const draft = host.toolCalls[saveIndex].arguments.draft;
    assert.equal(draft.prompt, "背景改为浅灰色");
    assert.equal(draft.annotations.length, 1);
    assert.equal(draft.annotations[0].type, "rectangle");
    assert.equal(draft.annotations[0].strokeWidth, 3);
    assert.equal(draft.annotations[0].text, "保留这个矩形区域");
    assert.deepEqual(
      [draft.annotations[0].x, draft.annotations[0].y, draft.annotations[0].width, draft.annotations[0].height],
      [0.1, 0.2, 0.3, 0.4],
    );
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("resource teardown detaches editor input handlers", { timeout: 5000 }, async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor" });

  try {
    await import(`../../web/editor-runtime.mjs?teardown-input-handlers=${Date.now()}`);
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);

    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 1 }));
    const annotationId = document.querySelector("[data-annotation-id]")?.dataset.annotationId;
    assert.ok(annotationId);
    document.querySelector(`[data-annotation-id="${annotationId}"]`).click();
    const countBefore = document.querySelectorAll("[data-annotation-id]").length;
    const activeColorBefore = document.querySelector('[data-color-slot][aria-checked="true"]')?.dataset.color;
    const colorPanel = document.querySelector("[data-custom-color-panel]");
    const colorPreview = document.querySelector("[data-custom-color-draft]");
    const colorArea = document.querySelector("[data-custom-color-area]");
    colorArea.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
    const layerBefore = document.querySelector("[data-layer]").innerHTML;
    const previewBefore = colorPreview.style.getPropertyValue("--preview-color");

    sendToApp(dom.window, {
      jsonrpc: "2.0",
      id: "teardown-input-handlers",
      method: "ui/resource-teardown",
      params: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    const promptCount = document.querySelector("[data-prompt-count]");
    const promptCountBefore = promptCount.textContent;
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "teardown 后不应写入";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    document.querySelector("[data-tool=pen]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 400, clientY: 400, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 600, clientY: 600, pointerId: 2 }));
    document.querySelector('[data-color-slot="1"]').click();
    document.querySelector('[data-color-slot="2"]').dispatchEvent(new dom.window.MouseEvent("contextmenu", {
      bubbles: false,
      cancelable: true,
      button: 2,
    }));
    colorArea.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 0, pointerId: 3 }));
    colorArea.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 100, clientY: 0, pointerId: 3 }));
    const hex = document.querySelector("[data-custom-color-hex]");
    hex.value = "#22C55E";
    hex.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    document.querySelector("[data-custom-color-apply]").click();
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, countBefore);
    assert.ok(document.querySelector(`[data-annotation-id="${annotationId}"]`));
    assert.equal(promptCount.textContent, promptCountBefore);
    assert.equal(document.querySelector('[data-color-slot][aria-checked="true"]')?.dataset.color, activeColorBefore);
    assert.equal(colorPanel.hidden, true);
    assert.equal(colorPreview.style.getPropertyValue("--preview-color"), previewBefore);
    assert.equal(document.querySelector("[data-layer]").innerHTML, layerBefore);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("resource teardown detaches stale result card actions", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialArtifacts: [{ id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] }],
  });

  try {
    await import(`../../web/editor-runtime.mjs?teardown-result-actions=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-action=open-editor]")?.disabled === false);
    const openButton = document.querySelector("[data-action=open-editor]");
    const previewButton = document.querySelector("[data-action=preview-image]");

    sendToApp(dom.window, { jsonrpc: "2.0", id: "teardown-result-actions", method: "ui/resource-teardown", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 40));
    openButton.click();
    previewButton.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(host.toolCalls.some(({ name }) => name === "open_image_editor"), false);
    assert.deepEqual(host.displayModeRequests, []);
    assert.equal(document.querySelector("[data-result-preview]"), null);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

for (const outcome of ["resolve", "reject"]) {
  test(`resource teardown freezes a pending artifact read when it ${outcome}s`, async () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
      { pretendToBeVisual: true, url: "https://widget.local/" },
    );
    const previous = installDomGlobals(dom.window);
    const host = installHost(dom.window, {
      toolName: "render_image_results",
      initialArtifacts: [{ id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1 }],
      deferArtifactDataImageIds: [IMAGE_ID],
    });

    try {
      await import(`../../web/editor-runtime.mjs?teardown-pending-artifact-${outcome}=${Date.now()}`);
      await waitFor(() => host.pendingArtifactDataRequestCount === 1);
      const cardBeforeCompletion = document.querySelector(".inline-result");

      sendToApp(dom.window, {
        jsonrpc: "2.0",
        id: `teardown-pending-artifact-${outcome}`,
        method: "ui/resource-teardown",
        params: {},
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      host[outcome === "resolve" ? "resolveArtifactData" : "rejectArtifactData"](IMAGE_ID);
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.equal(document.querySelector(".inline-result"), cardBeforeCompletion);
      assert.equal(document.querySelector("[data-image]:not([hidden])"), null);
      assert.equal(host.toolCalls.filter(({ name }) => name === "read_image_artifact_data").length, 1);
    } finally {
      host.dispose();
      restoreDomGlobals(previous);
      dom.window.close();
    }
  });
}

for (const outcome of ["resolve", "reject"]) {
  test(`resource teardown freezes a pending canvas open when ensure ${outcome}s`, async () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
      { pretendToBeVisual: true, url: "https://widget.local/" },
    );
    const previous = installDomGlobals(dom.window);
    const host = installHost(dom.window, {
      toolName: "render_image_results",
      deferOpenImageEditor: true,
      initialArtifacts: [{ id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] }],
    });

    try {
      await import(`../../web/editor-runtime.mjs?teardown-pending-open-${outcome}=${Date.now()}`);
      await waitFor(() => document.querySelector("[data-action=open-editor]")?.disabled === false);
      document.querySelector("[data-action=open-editor]").click();
      await waitFor(() => host.pendingOpenImageEditorRequestCount === 1);

      sendToApp(dom.window, { jsonrpc: "2.0", id: `teardown-pending-open-${outcome}`, method: "ui/resource-teardown", params: {} });
      await new Promise((resolve) => setTimeout(resolve, 40));
      const resultBeforeCompletion = document.querySelector(".inline-results");
      host[outcome === "resolve" ? "resolveOpenImageEditor" : "rejectOpenImageEditor"]();
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.equal(document.querySelector(".inline-results"), resultBeforeCompletion, "pending 完成后不能重新渲染结果卡");
      assert.deepEqual(host.displayModeRequests, [], "teardown 后不能继续请求 fullscreen");
      assert.equal(document.querySelector(".editor-app"), null);
    } finally {
      host.dispose();
      restoreDomGlobals(previous);
      dom.window.close();
    }
  });
}

for (const outcome of ["resolve", "reject"]) {
  test(`resource teardown freezes a pending canvas destroy when destroy ${outcome}s`, async () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
      { pretendToBeVisual: true, url: "https://widget.local/" },
    );
    const previous = installDomGlobals(dom.window);
    const host = installHost(dom.window, { toolName: "open_image_editor", deferDestroyImageEditor: true });

    try {
      await import(`../../web/editor-runtime.mjs?teardown-pending-destroy-${outcome}=${Date.now()}`);
      await waitFor(() => document.querySelector("[data-action=destroy]") !== null);
      await waitFor(() => host.toolCalls.some(({ name }) => name === "get_image_editor_session"));
      document.querySelector("[data-action=destroy]").click();
      document.querySelector("[data-action=confirm-destroy]").click();
      await waitFor(() => host.pendingDestroyImageEditorRequestCount === 1);

      sendToApp(dom.window, { jsonrpc: "2.0", id: `teardown-pending-destroy-${outcome}`, method: "ui/resource-teardown", params: {} });
      await new Promise((resolve) => setTimeout(resolve, 40));
      const editorBeforeCompletion = document.querySelector(".editor-app");
      const toastBeforeCompletion = document.querySelector("[data-toast]")?.textContent;
      const focusBeforeCompletion = document.activeElement;
      host[outcome === "resolve" ? "resolveDestroyImageEditor" : "rejectDestroyImageEditor"]();
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.equal(document.querySelector(".editor-app"), editorBeforeCompletion, "pending 完成后不能重新渲染画布");
      assert.equal(document.querySelector("[data-toast]")?.textContent, toastBeforeCompletion, "pending 完成后不能显示 toast");
      assert.equal(document.activeElement, focusBeforeCompletion, "pending 完成后不能转移焦点");
      assert.deepEqual(host.displayModeRequests, ["fullscreen"], "teardown 后不能请求返回 inline");
      assert.equal(document.querySelector(".inline-result"), null);
    } finally {
      host.dispose();
      restoreDomGlobals(previous);
      dom.window.close();
    }
  });
}

test("resource teardown cancels pending toast dismissal", { timeout: 5000 }, async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor", rejectModelCatalog: true });
  const nativeSetTimeout = dom.window.setTimeout.bind(dom.window);
  let toastDismissal = null;
  dom.window.setTimeout = (callback, delay, ...args) => {
    if (delay === 2800) {
      toastDismissal = () => callback(...args);
      return 9876;
    }
    return nativeSetTimeout(callback, delay, ...args);
  };

  try {
    await import(`../../web/editor-runtime.mjs?teardown-toast=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-toast]")?.classList.contains("visible"));
    assert.equal(typeof toastDismissal, "function");
    const toast = document.querySelector("[data-toast]");

    sendToApp(dom.window, {
      jsonrpc: "2.0",
      id: "teardown-toast",
      method: "ui/resource-teardown",
      params: {},
    });
    await new Promise((resolve) => nativeSetTimeout(resolve, 40));
    toast.classList.add("visible");
    toastDismissal();

    assert.equal(toast.classList.contains("visible"), true);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});
