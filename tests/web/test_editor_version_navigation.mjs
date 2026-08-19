import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import {
  EDITOR_SESSION_ID,
  IMAGE_ID,
  PNG_BASE64,
  installDomGlobals,
  installHost,
  pointerEvent,
  restoreDomGlobals,
  sendToApp,
  waitFor,
} from "../support/widget-runtime-host.mjs";

test("an editor tool result without artifact metadata reaches an error terminal state", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    initialEditorResultIncludesArtifact: false,
  });

  try {
    await import(`../../web/editor-runtime.mjs?missing-editor-artifact=${Date.now()}`);
    await waitFor(() => (
      document.querySelector("[data-submit-status]")?.textContent === "图片读取失败 · IMG-SCHEMA"
    ));
    assert.equal(document.querySelector("[data-submit-status]")?.textContent, "图片读取失败 · IMG-SCHEMA");
    assert.equal(document.querySelector("[data-submit-status]")?.dataset.statusTone, "error");
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("editor hydrates every parent and child version thumbnail and keeps terminal states", async () => {
  const parentId = "img_01J00000000000000000000010";
  const childOneId = "img_01J00000000000000000000011";
  const childTwoId = "img_01J00000000000000000000012";
  const current = {
    id: IMAGE_ID,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: "edit",
    parentIds: [parentId],
    childIds: [childOneId, childTwoId],
  };
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor", initialArtifacts: [current] });

  try {
    await import(`../../web/editor-runtime.mjs?lineage-thumbnails=${Date.now()}`);
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => {
      const calls = host.toolCalls
        .filter(({ name }) => name === "read_image_artifact_data")
        .map(({ arguments: args }) => args.imageId);
      return [IMAGE_ID, parentId, childOneId, childTwoId].every((id) => calls.includes(id));
    });
    await waitFor(() => document.querySelectorAll("[data-version-id] .version-thumb img").length === 4);
    assert.equal(document.querySelectorAll(".version-loading").length, 0);
    assert.equal(document.querySelectorAll(".version-error").length, 0);
    assert.deepEqual(
      [...document.querySelectorAll("[data-version-id]")].map((item) => item.dataset.versionId),
      [parentId, IMAGE_ID, childOneId, childTwoId],
    );

    document.querySelector(`[data-version-id="${childOneId}"]`).click();
    await waitFor(() => document.querySelector("[data-image-id]")?.textContent === childOneId);
    assert.deepEqual(
      [...document.querySelectorAll("[data-version-id].current")].map((item) => item.dataset.versionId),
      [childOneId],
    );
    assert.equal(document.querySelectorAll(".version-loading").length, 0);
    assert.equal(document.querySelectorAll(".version-error").length, 0);
    assert.equal(document.querySelectorAll("[data-version-id] .version-thumb img").length, 4);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("opening a result card automatically hydrates its complete version strip", async () => {
  const childOneId = "img_01J00000000000000000000031";
  const childTwoId = "img_01J00000000000000000000032";
  const current = {
    id: IMAGE_ID,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: "generate",
    parentIds: [],
    childIds: [childOneId, childTwoId],
  };
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialArtifacts: [current],
    children: [
      { id: childOneId, mimeType: "image/png", width: 1, height: 1, operation: "edit", parentIds: [IMAGE_ID], childIds: [] },
      { id: childTwoId, mimeType: "image/png", width: 1, height: 1, operation: "edit", parentIds: [IMAGE_ID], childIds: [] },
    ],
  });

  try {
    await import(`../../web/editor-runtime.mjs?result-card-lineage=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-action=open-editor]")?.disabled === false);
    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => document.querySelectorAll("[data-version-id] .version-thumb img").length === 3);

    assert.deepEqual(
      [...document.querySelectorAll("[data-version-id]")].map((item) => item.dataset.versionId),
      [IMAGE_ID, childOneId, childTwoId],
    );
    assert.equal(document.querySelectorAll(".version-loading").length, 0);
    assert.deepEqual(
      host.toolCalls
        .filter(({ name }) => name === "read_image_artifact_data")
        .map(({ arguments: args }) => args.imageId)
        .filter((id) => [childOneId, childTwoId].includes(id))
        .sort(),
      [childOneId, childTwoId],
    );
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("switching among loaded versions changes only the current marker", async () => {
  const parentId = "img_01J00000000000000000000033";
  const childOneId = "img_01J00000000000000000000034";
  const childTwoId = "img_01J00000000000000000000035";
  const current = {
    id: IMAGE_ID,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: "edit",
    parentIds: [parentId],
    childIds: [childOneId, childTwoId],
  };
  const expectedOrder = [parentId, IMAGE_ID, childOneId, childTwoId];
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor", initialArtifacts: [current] });

  try {
    await import(`../../web/editor-runtime.mjs?stable-version-order=${Date.now()}`);
    await waitFor(() => document.querySelectorAll("[data-version-id] .version-thumb img").length === 4);
    assert.deepEqual(
      [...document.querySelectorAll("[data-version-id]")].map((item) => item.dataset.versionId),
      expectedOrder,
    );
    for (const imageId of [childOneId, childTwoId, IMAGE_ID, parentId]) {
      document.querySelector(`[data-version-id="${imageId}"]`).click();
      await waitFor(() => document.querySelector(".editor-app [data-image-id]")?.textContent === imageId);
      assert.deepEqual(
        [...document.querySelectorAll("[data-version-id]")].map((item) => item.dataset.versionId),
        expectedOrder,
        `switching to ${imageId} must not reorder the version strip`,
      );
      assert.deepEqual(
        [...document.querySelectorAll("[data-version-id].current")].map((item) => item.dataset.versionId),
        [imageId],
      );
      await waitFor(() => document.querySelector(".editor-app")?.getAttribute("aria-busy") === "false");
    }
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a failed parent or child thumbnail settles as a visible error", async () => {
  const parentId = "img_01J00000000000000000000013";
  const childId = "img_01J00000000000000000000014";
  const current = {
    id: IMAGE_ID,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: "edit",
    parentIds: [parentId],
    childIds: [childId],
  };
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    initialArtifacts: [current],
    failArtifactDataImageId: childId,
  });

  try {
    await import(`../../web/editor-runtime.mjs?lineage-thumbnail-error=${Date.now()}`);
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => document.querySelector(`[data-version-id="${childId}"] .version-error`) !== null);
    assert.equal(document.querySelector(`[data-version-id="${childId}"] .version-error`)?.textContent.trim(), "读取失败");
    assert.equal(document.querySelectorAll(".version-loading").length, 0);
    assert.equal(document.querySelector(`[data-version-id="${parentId}"] .version-thumb img`) !== null, true);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("selecting a version loads its artifact before replacing the visible image", async () => {
  const childId = "img_01J00000000000000000000001";
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    children: [{ id: childId, mimeType: "image/png", width: 1, height: 1, operation: "edit", parentIds: [IMAGE_ID] }],
  });

  try {
    await import(`../../web/editor-runtime.mjs?version-load=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    document.querySelector(`[data-version-id="${childId}"]`).click();
    await waitFor(() => host.toolCalls.some(({ name, arguments: args }) => name === "read_image_artifact_data" && args.imageId === childId));
    await waitFor(() => document.querySelector("[data-image-id]")?.textContent === childId);
    assert.equal(document.querySelector("[data-image]").hidden, false);
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a hanging lineage thumbnail does not block the current image and reaches a timeout error", async () => {
  const childId = "img_01J00000000000000000000015";
  const current = {
    id: IMAGE_ID,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: "edit",
    parentIds: [],
    childIds: [childId],
  };
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const nodeSetTimeout = globalThis.setTimeout;
  dom.window.setTimeout = (callback, delay, ...args) => nodeSetTimeout(callback, delay === 8000 ? 400 : delay, ...args);
  let hangingRequestId = null;
  const hangChildRead = (event) => {
    const message = event.data;
    if (
      message?.method === "tools/call"
      && message.params?.name === "read_image_artifact_data"
      && message.params.arguments?.imageId === childId
    ) {
      hangingRequestId = message.id;
      event.stopImmediatePropagation();
    }
  };
  dom.window.addEventListener("message", hangChildRead);
  const host = installHost(dom.window, { toolName: "open_image_editor", initialArtifacts: [current] });

  try {
    await import(`../../web/editor-runtime.mjs?lineage-thumbnail-timeout=${Date.now()}`);
    await waitFor(() => hangingRequestId !== null);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false, 100);
    assert.equal(document.querySelector(`[data-version-id="${childId}"] .version-loading`) !== null, true);
    assert.equal(document.querySelector('[data-tool="pen"]')?.disabled, false);
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "超时期间继续编辑";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 260, pointerId: 1 }));
    await waitFor(() => document.querySelector(`[data-version-id="${childId}"] .version-error`) !== null, 800);
    assert.equal(document.querySelector(`[data-version-id="${childId}"] .version-error`)?.textContent.trim(), "读取失败");
    assert.equal(document.querySelector("[data-image]").hidden, false);
    assert.equal(document.querySelector("[data-prompt]").value, "超时期间继续编辑");
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
  } finally {
    if (hangingRequestId !== null) {
      sendToApp(dom.window, {
        jsonrpc: "2.0",
        id: hangingRequestId,
        error: { code: -32603, message: "test cleanup" },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    dom.window.removeEventListener("message", hangChildRead);
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a successful retry replaces an earlier failed lineage record", { timeout: 5000 }, async () => {
  const childId = "img_01J00000000000000000000016";
  const current = {
    id: IMAGE_ID,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: "edit",
    parentIds: [],
    childIds: [childId],
  };
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  let childReadCount = 0;
  let pendingRetryReadId = null;
  const failFirstChildRead = (event) => {
    const message = event.data;
    if (
      message?.method !== "tools/call"
      || message.params?.name !== "read_image_artifact_data"
      || message.params.arguments?.imageId !== childId
    ) return;
    childReadCount += 1;
    if (childReadCount === 2) {
      pendingRetryReadId = message.id;
      event.stopImmediatePropagation();
      return;
    }
    if (childReadCount !== 1) return;
    event.stopImmediatePropagation();
    sendToApp(dom.window, {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        isError: true,
        content: [{ type: "text", text: "image_task_failed: artifact data unavailable" }],
      },
    });
  };
  dom.window.addEventListener("message", failFirstChildRead);
  const host = installHost(dom.window, { toolName: "open_image_editor", initialArtifacts: [current] });

  try {
    await import(`../../web/editor-runtime.mjs?lineage-thumbnail-retry=${Date.now()}`);
    await waitFor(() => document.querySelector(`[data-version-id="${childId}"] .version-error`) !== null);
    document.querySelector(`[data-version-id="${childId}"]`).click();
    await waitFor(() => pendingRetryReadId !== null);
    assert.equal(document.querySelector(`[data-version-id="${childId}"] .version-loading`) !== null, true);
    assert.equal(document.querySelector(`[data-version-id="${childId}"] .version-error`), null);
    sendArtifactError(dom.window, pendingRetryReadId);
    await waitFor(() => document.querySelector(`[data-version-id="${childId}"] .version-error`) !== null);
    assert.equal(document.querySelector(`[data-version-id="${childId}"] .version-loading`), null);
    assert.equal(document.querySelector("[data-image-id]")?.textContent, IMAGE_ID);
    document.querySelector(`[data-version-id="${childId}"]`).click();
    await waitFor(() => document.querySelector("[data-image-id]")?.textContent === childId);
    assert.equal(childReadCount, 3);
    assert.equal(document.querySelector(`[data-version-id="${childId}"] .version-thumb img`) !== null, true);
    assert.equal(document.querySelector(`[data-version-id="${childId}"] .version-error`), null);
  } finally {
    dom.window.removeEventListener("message", failFirstChildRead);
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a late lineage result preserves the active draft and its history", async () => {
  const childId = "img_01J00000000000000000000017";
  const current = {
    id: IMAGE_ID,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: "edit",
    parentIds: [],
    childIds: [childId],
  };
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  let pendingChildReadId = null;
  const deferChildRead = (event) => {
    const message = event.data;
    if (
      message?.method === "tools/call"
      && message.params?.name === "read_image_artifact_data"
      && message.params.arguments?.imageId === childId
    ) {
      pendingChildReadId = message.id;
      event.stopImmediatePropagation();
    }
  };
  dom.window.addEventListener("message", deferChildRead);
  const host = installHost(dom.window, { toolName: "open_image_editor", initialArtifacts: [current] });

  try {
    await import(`../../web/editor-runtime.mjs?late-lineage-draft=${Date.now()}`);
    await waitFor(() => pendingChildReadId !== null);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "保留这段未提交草稿";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 260, pointerId: 1 }));
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);

    sendArtifactData(dom.window, pendingChildReadId, childId);
    await waitFor(() => document.querySelector(`[data-version-id="${childId}"] .version-thumb img`) !== null);
    assert.equal(document.querySelector("[data-prompt]").value, "保留这段未提交草稿");
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
    document.querySelector("[data-action=undo]").click();
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
    assert.equal(document.querySelector("[data-prompt]").value, "保留这段未提交草稿");
    document.querySelector("[data-action=redo]").click();
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
  } finally {
    dom.window.removeEventListener("message", deferChildRead);
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a late lineage failure preserves the active draft", async () => {
  const childId = "img_01J00000000000000000000019";
  const current = {
    id: IMAGE_ID,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: "edit",
    parentIds: [],
    childIds: [childId],
  };
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  let pendingChildReadId = null;
  const deferChildRead = (event) => {
    const message = event.data;
    if (
      message?.method === "tools/call"
      && message.params?.name === "read_image_artifact_data"
      && message.params.arguments?.imageId === childId
    ) {
      pendingChildReadId = message.id;
      event.stopImmediatePropagation();
    }
  };
  dom.window.addEventListener("message", deferChildRead);
  const host = installHost(dom.window, { toolName: "open_image_editor", initialArtifacts: [current] });

  try {
    await import(`../../web/editor-runtime.mjs?late-lineage-failure=${Date.now()}`);
    await waitFor(() => pendingChildReadId !== null);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "失败期间继续编辑";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    sendArtifactError(dom.window, pendingChildReadId);
    await waitFor(() => document.querySelector(`[data-version-id="${childId}"] .version-error`) !== null);
    assert.equal(document.querySelector("[data-prompt]").value, "失败期间继续编辑");
  } finally {
    dom.window.removeEventListener("message", deferChildRead);
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a late lineage result cannot rewrite the surface after the editor is destroyed", { timeout: 5000 }, async () => {
  const childId = "img_01J00000000000000000000018";
  const current = {
    id: IMAGE_ID,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: "edit",
    parentIds: [],
    childIds: [childId],
  };
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  let pendingChildReadId = null;
  const deferChildRead = (event) => {
    const message = event.data;
    if (
      message?.method === "tools/call"
      && message.params?.name === "read_image_artifact_data"
      && message.params.arguments?.imageId === childId
    ) {
      pendingChildReadId = message.id;
      event.stopImmediatePropagation();
    }
  };
  dom.window.addEventListener("message", deferChildRead);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    children: [{ ...current, id: childId, parentIds: [IMAGE_ID], childIds: [] }],
  });

  try {
    await import(`../../web/editor-runtime.mjs?late-lineage-destroy=${Date.now()}`);
    await waitFor(() => pendingChildReadId !== null);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    document.querySelector("[data-action=destroy]").click();
    document.querySelector("[data-action=confirm-destroy]").click();
    await waitFor(() => document.querySelector(".inline-result") !== null);
    assert.deepEqual(resultImageIds(), [IMAGE_ID]);
    assert.equal(document.querySelector(`[data-result-image-id="${IMAGE_ID}"]`)?.dataset.canvasStatus, "destroyed");

    sendArtifactData(dom.window, pendingChildReadId, childId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(resultImageIds(), [IMAGE_ID]);
    assert.equal(document.querySelector(`[data-result-image-id="${IMAGE_ID}"]`)?.dataset.canvasStatus, "destroyed");
  } finally {
    dom.window.removeEventListener("message", deferChildRead);
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a server-destroyed session blocks late lineage projection while release is pending", { timeout: 5000 }, async () => {
  const childId = "img_01J00000000000000000000038";
  const current = {
    id: IMAGE_ID,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: "edit",
    parentIds: [],
    childIds: [childId],
  };
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  let pendingChildReadId = null;
  let pendingFinalizeId = null;
  let childReadSettled = false;
  const deferLateWork = (event) => {
    const message = event.data;
    if (
      message?.method === "tools/call"
      && message.params?.name === "read_image_artifact_data"
      && message.params.arguments?.imageId === childId
    ) {
      pendingChildReadId = message.id;
      event.stopImmediatePropagation();
    } else if (message?.method === "tools/call" && message.params?.name === "finalize_image_editor_session") {
      pendingFinalizeId = message.id;
      event.stopImmediatePropagation();
    }
  };
  dom.window.addEventListener("message", deferLateWork);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    children: [{ ...current, id: childId, parentIds: [IMAGE_ID], childIds: [] }],
  });

  try {
    await import(`../../web/editor-runtime.mjs?server-destroyed-late-lineage=${Date.now()}`);
    await waitFor(() => pendingChildReadId !== null);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    host.setEditorSessionStatus("destroyed");
    await waitFor(() => pendingFinalizeId !== null, 3000);
    const beforeLateResult = document.querySelector("main").innerHTML;

    sendArtifactData(dom.window, pendingChildReadId, childId);
    childReadSettled = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(document.querySelector("main").innerHTML, beforeLateResult);
  } finally {
    if (pendingChildReadId !== null && !childReadSettled) {
      sendArtifactData(dom.window, pendingChildReadId, childId);
    }
    if (pendingFinalizeId !== null) {
      sendToApp(dom.window, {
        jsonrpc: "2.0",
        id: pendingFinalizeId,
        result: {
          content: [],
          structuredContent: {
            editorSession: { id: "eds_01J00000000000000000000000", imageId: IMAGE_ID, status: "released" },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    dom.window.removeEventListener("message", deferLateWork);
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("manual destroy blocks lineage projection while release is pending", { timeout: 5000 }, async () => {
  const childId = "img_01J00000000000000000000039";
  const current = {
    id: IMAGE_ID,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: "edit",
    parentIds: [],
    childIds: [childId],
  };
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  let pendingChildReadId = null;
  let pendingFinalizeId = null;
  let childReadSettled = false;
  const deferLateWork = (event) => {
    const message = event.data;
    if (
      message?.method === "tools/call"
      && message.params?.name === "read_image_artifact_data"
      && message.params.arguments?.imageId === childId
    ) {
      pendingChildReadId = message.id;
      event.stopImmediatePropagation();
    } else if (message?.method === "tools/call" && message.params?.name === "finalize_image_editor_session") {
      pendingFinalizeId = message.id;
      event.stopImmediatePropagation();
    }
  };
  dom.window.addEventListener("message", deferLateWork);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    children: [{ ...current, id: childId, parentIds: [IMAGE_ID], childIds: [] }],
  });

  try {
    await import(`../../web/editor-runtime.mjs?manual-destroy-late-lineage=${Date.now()}`);
    await waitFor(() => pendingChildReadId !== null);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    document.querySelector("[data-action=destroy]").click();
    document.querySelector("[data-action=confirm-destroy]").click();
    await waitFor(() => pendingFinalizeId !== null);
    const beforeLateResult = document.querySelector("main").innerHTML;

    sendArtifactData(dom.window, pendingChildReadId, childId);
    childReadSettled = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(document.querySelector("main").innerHTML, beforeLateResult);
  } finally {
    if (pendingChildReadId !== null && !childReadSettled) {
      sendArtifactData(dom.window, pendingChildReadId, childId);
    }
    if (pendingFinalizeId !== null) {
      sendToApp(dom.window, {
        jsonrpc: "2.0",
        id: pendingFinalizeId,
        result: {
          content: [],
          structuredContent: {
            editorSession: { id: EDITOR_SESSION_ID, imageId: IMAGE_ID, status: "released" },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    dom.window.removeEventListener("message", deferLateWork);
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("returning after a failed version switch preserves the current result image", async () => {
  const childId = "img_01J00000000000000000000022";
  const current = {
    id: IMAGE_ID,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: "edit",
    parentIds: [],
    childIds: [childId],
  };
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    initialArtifacts: [current],
    failArtifactDataImageId: childId,
  });

  try {
    await import(`../../web/editor-runtime.mjs?failed-version-return=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    await waitFor(() => document.querySelector(`[data-version-id="${childId}"] .version-error`) !== null);
    const childVersion = document.querySelector(`[data-version-id="${childId}"]`);
    childVersion.click();
    await waitFor(() => host.toolCalls.filter(({ name, arguments: args }) => name === "read_image_artifact_data" && args.imageId === childId).length >= 2);
    await waitFor(() => document.querySelector(`[data-version-id="${childId}"] .version-error`) !== null);
    document.querySelector("[data-action=back]").click();
    await waitFor(() => document.querySelector(".inline-result") !== null);
    assert.deepEqual(resultImageIds(), [IMAGE_ID]);
    assert.ok(document.querySelector(`[data-result-image-id="${IMAGE_ID}"] [data-image]`));
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a resource teardown invalidates a pending lineage read", { timeout: 5000 }, async () => {
  const childId = "img_01J00000000000000000000020";
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  let pendingChildReadId = null;
  const deferChildRead = (event) => {
    const message = event.data;
    if (
      message?.method === "tools/call"
      && message.params?.name === "read_image_artifact_data"
      && message.params.arguments?.imageId === childId
    ) {
      pendingChildReadId = message.id;
      event.stopImmediatePropagation();
    }
  };
  dom.window.addEventListener("message", deferChildRead);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    children: [{ id: childId, mimeType: "image/png", width: 1, height: 1, operation: "edit", parentIds: [IMAGE_ID], childIds: [] }],
  });

  try {
    await import(`../../web/editor-runtime.mjs?resource-teardown-late-read=${Date.now()}`);
    await waitFor(() => pendingChildReadId !== null);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const before = document.querySelector("main").innerHTML;
    sendToApp(dom.window, {
      jsonrpc: "2.0",
      id: "teardown-1",
      method: "ui/resource-teardown",
      params: {},
    });
    await waitFor(() => host.toolCalls.some(({ name }) => name === "finalize_image_editor_session"));
    sendArtifactData(dom.window, pendingChildReadId, childId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(document.querySelector("main").innerHTML, before);
  } finally {
    dom.window.removeEventListener("message", deferChildRead);
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("rehydrating the same image merges newly published lineage metadata", async () => {
  const childId = "img_01J00000000000000000000021";
  const current = {
    id: IMAGE_ID,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: "edit",
    parentIds: [],
    childIds: [],
  };
  const updated = { ...current, childIds: [childId] };
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor", initialArtifacts: [current] });

  try {
    await import(`../../web/editor-runtime.mjs?lineage-metadata-refresh=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "保留当前草稿";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    host.notifyResultArtifacts([updated]);
    await waitFor(() => document.querySelector(`[data-version-id="${childId}"] .version-thumb img`) !== null);
    assert.equal(document.querySelector("[data-prompt]").value, "保留当前草稿");
    assert.ok(document.querySelector(`[data-version-id="${childId}"]`));
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a superseded lineage request still caches a late thumbnail result", async () => {
  const childId = "img_01J00000000000000000000036";
  const current = {
    id: IMAGE_ID,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: "edit",
    parentIds: [],
    childIds: [childId],
  };
  const refreshed = { ...current, childIds: [] };
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  let pendingChildReadId = null;
  const deferFirstChildRead = (event) => {
    const message = event.data;
    if (
      pendingChildReadId === null
      && message?.method === "tools/call"
      && message.params?.name === "read_image_artifact_data"
      && message.params.arguments?.imageId === childId
    ) {
      pendingChildReadId = message.id;
      event.stopImmediatePropagation();
    }
  };
  dom.window.addEventListener("message", deferFirstChildRead);
  const host = installHost(dom.window, { toolName: "open_image_editor", initialArtifacts: [current] });

  try {
    await import(`../../web/editor-runtime.mjs?superseded-lineage=${Date.now()}`);
    await waitFor(() => pendingChildReadId !== null);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    host.notifyResultArtifacts([refreshed]);
    await new Promise((resolve) => setImmediate(resolve));

    sendArtifactData(dom.window, pendingChildReadId, childId);
    await waitFor(() => document.querySelector(`[data-version-id="${childId}"] .version-thumb img`) !== null);
    assert.equal(document.querySelector(`[data-version-id="${childId}"] .version-loading`), null);
  } finally {
    dom.window.removeEventListener("message", deferFirstChildRead);
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a failed current retry uses a late successful immutable artifact", async () => {
  const childId = "img_01J00000000000000000000042";
  const current = {
    id: IMAGE_ID,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: "edit",
    parentIds: [],
    childIds: [childId],
  };
  const child = {
    ...current,
    id: childId,
    parentIds: [],
    childIds: [],
  };
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const pendingChildReadIds = [];
  const deferChildReads = (event) => {
    const message = event.data;
    if (
      message?.method === "tools/call"
      && message.params?.name === "read_image_artifact_data"
      && message.params.arguments?.imageId === childId
    ) {
      pendingChildReadIds.push(message.id);
      event.stopImmediatePropagation();
    }
  };
  dom.window.addEventListener("message", deferChildReads);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    initialArtifacts: [current, child],
  });

  try {
    await import(`../../web/editor-runtime.mjs?late-success-current-retry=${Date.now()}`);
    await waitFor(() => pendingChildReadIds.length === 1);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    document.querySelector(`[data-version-id="${childId}"]`).click();
    await waitFor(() => pendingChildReadIds.length === 2);

    sendArtifactData(dom.window, pendingChildReadIds[0], childId);
    sendArtifactError(dom.window, pendingChildReadIds[1]);
    await waitFor(() => document.querySelector(".editor-app [data-image-id]")?.textContent === childId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(document.querySelector("[data-submit-status]")?.textContent, "");
    assert.equal(document.querySelector(`[data-version-id="${childId}"] .version-error`), null);
    assert.ok(document.querySelector(`[data-version-id="${childId}"] .version-thumb img`));
  } finally {
    dom.window.removeEventListener("message", deferChildReads);
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a superseded lineage failure settles when no newer read exists for that version", async () => {
  const childId = "img_01J00000000000000000000037";
  const current = {
    id: IMAGE_ID,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: "edit",
    parentIds: [],
    childIds: [childId],
  };
  const refreshed = { ...current, childIds: [] };
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  let pendingChildReadId = null;
  const deferFirstChildRead = (event) => {
    const message = event.data;
    if (
      pendingChildReadId === null
      && message?.method === "tools/call"
      && message.params?.name === "read_image_artifact_data"
      && message.params.arguments?.imageId === childId
    ) {
      pendingChildReadId = message.id;
      event.stopImmediatePropagation();
    }
  };
  dom.window.addEventListener("message", deferFirstChildRead);
  const host = installHost(dom.window, { toolName: "open_image_editor", initialArtifacts: [current] });

  try {
    await import(`../../web/editor-runtime.mjs?superseded-lineage-failure=${Date.now()}`);
    await waitFor(() => pendingChildReadId !== null);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    host.notifyResultArtifacts([refreshed]);
    await new Promise((resolve) => setImmediate(resolve));

    sendArtifactError(dom.window, pendingChildReadId);
    await waitFor(() => document.querySelector(`[data-version-id="${childId}"] .version-error`) !== null);
    assert.equal(document.querySelector(`[data-version-id="${childId}"] .version-loading`), null);
  } finally {
    dom.window.removeEventListener("message", deferFirstChildRead);
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

function sendArtifactData(window, requestId, imageId) {
  sendToApp(window, {
    jsonrpc: "2.0",
    id: requestId,
    result: {
      content: [],
      structuredContent: {
        artifact: {
          id: imageId,
          mimeType: "image/png",
          width: 1,
          height: 1,
          operation: "edit",
          parentIds: [],
          childIds: [],
        },
        canvasStatus: "available",
      },
      _meta: { widgetData: { id: imageId, mimeType: "image/png", dataBase64: PNG_BASE64 } },
    },
  });
}

function sendArtifactError(window, requestId) {
  sendToApp(window, {
    jsonrpc: "2.0",
    id: requestId,
    result: {
      isError: true,
      content: [{ type: "text", text: "image_task_failed: artifact data unavailable" }],
    },
  });
}

function resultImageIds() {
  return [...document.querySelectorAll("[data-result-image-id]")].map((item) => item.dataset.resultImageId);
}
