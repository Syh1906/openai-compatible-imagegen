import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import {
  EDITOR_SESSION_ID,
  IMAGE_ID,
  installDomGlobals,
  installHost,
  pointerEvent,
  restoreDomGlobals,
  sendToApp,
  waitFor,
} from "./support/widget-runtime-host.mjs";

const NEXT_IMAGE_ID = "img_01J00000000000000000000001";
const NEXT_SESSION_ID = "eds_01J00000000000000000000001";

test("a destroyed editor stays terminal when returning to the conversation is refused", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    rejectDisplayMode: "inline",
  });

  try {
    await import(`../web/editor-runtime.mjs?destroy-inline-refused=${Date.now()}`);
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => host.toolCalls.some(({ name }) => name === "get_image_editor_session"));

    document.querySelector("[data-action=destroy]").click();
    document.querySelector("[data-action=confirm-destroy]").click();
    await waitFor(() => host.toolCalls.some(({ name }) => name === "destroy_image_editor"));
    await waitFor(() => host.toolCalls.some(({ name }) => name === "finalize_image_editor_session"));
    await waitFor(() => document.querySelector('[data-destroyed-terminal="true"]') !== null);
    await waitFor(() => document.querySelector("[data-action=back]")?.disabled === false);

    const submit = document.querySelector("[data-action=submit]");
    const rectangle = document.querySelector("[data-tool=rectangle]");
    const prompt = document.querySelector("[data-prompt]");
    assert.equal(submit.disabled, true);
    assert.equal(rectangle.disabled, true);
    assert.equal(prompt.disabled, true);
    assert.equal(document.querySelector("[data-action=back]").disabled, false);
    assert.match(document.querySelector('[data-destroyed-terminal="true"]').textContent, /画布已销毁/);

    rectangle.click();
    const canvas = document.querySelector("[data-canvas]");
    canvas.focus();
    canvas.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    canvas.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    canvas.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 120, clientY: 120, pointerId: 7 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 240, clientY: 220, pointerId: 7 }));

    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
    assert.equal(host.toolCalls.filter(({ name }) => name === "prepare_image_edit_submission").length, 0);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a server-destroyed editor unlocks return after an inline refusal", { timeout: 5000 }, async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    editorSessionStatus: "destroyed",
    rejectDisplayMode: "inline",
  });

  try {
    await import(`../web/editor-runtime.mjs?server-destroy-inline-refused=${Date.now()}`);
    await waitFor(() => document.querySelector('[data-destroyed-terminal="true"]') !== null, 3000);
    await waitFor(() => host.toolCalls.some(({ name }) => name === "finalize_image_editor_session"));

    const back = document.querySelector("[data-action=back]");
    assert.equal(back.disabled, false);
    assert.match(document.querySelector('[data-destroyed-terminal="true"]').textContent, /画布已销毁/);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a destroy acknowledgement stays terminal when session cleanup fails", { timeout: 5000 }, async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    rejectFinalizeImageEditor: true,
    rejectDisplayMode: "inline",
  });

  try {
    await import(`../web/editor-runtime.mjs?destroy-finalize-refused=${Date.now()}`);
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => host.toolCalls.some(({ name }) => name === "get_image_editor_session"));
    await waitFor(() => document.querySelector("[data-action=destroy]")?.disabled === false);
    document.querySelector("[data-action=destroy]").click();
    await waitFor(() => document.querySelector("[data-destroy-confirm]")?.hidden === false);
    document.querySelector("[data-action=confirm-destroy]").click();
    await waitFor(() => host.toolCalls.some(({ name }) => name === "finalize_image_editor_session"), 3000);
    await waitFor(() => document.querySelector('[data-destroyed-terminal="true"]') !== null, 3000);
    await waitFor(() => document.querySelector("[data-action=back]")?.disabled === false, 3000);

    assert.equal(document.querySelector("[data-tool=rectangle]").disabled, true);
    assert.equal(document.querySelector("[data-action=submit]").disabled, true);
    assert.equal(document.querySelector("[data-action=back]").disabled, false);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("manual destroy joins a concurrent destroyed status transition", { timeout: 5000 }, async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  let pendingStatusId = null;
  const deferStatus = (event) => {
    if (event.data?.method === "tools/call" && event.data.params?.name === "get_image_editor_session") {
      pendingStatusId = event.data.id;
      event.stopImmediatePropagation();
    }
  };
  dom.window.addEventListener("message", deferStatus);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    deferDestroyImageEditor: true,
  });

  try {
    await import(`../web/editor-runtime.mjs?destroy-status-race=${Date.now()}`);
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => pendingStatusId !== null);
    document.querySelector("[data-action=destroy]").click();
    document.querySelector("[data-action=confirm-destroy]").click();
    await waitFor(() => host.pendingDestroyImageEditorRequestCount === 1);

    sendToApp(dom.window, {
      jsonrpc: "2.0",
      id: pendingStatusId,
      result: {
        content: [],
        structuredContent: {
          editorSession: { id: "eds_01J00000000000000000000000", imageId: "img_01J00000000000000000000000", status: "destroyed" },
        },
      },
    });
    pendingStatusId = null;
    await waitFor(() => host.displayModeRequests.filter((mode) => mode === "inline").length === 1);
    host.resolveDestroyImageEditor();
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(host.displayModeRequests.filter((mode) => mode === "inline").length, 1);
  } finally {
    dom.window.removeEventListener("message", deferStatus);
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("an old destroyed callback cannot close or stop a newly adopted editor", { timeout: 5000 }, async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  let pendingFinalizeId = null;
  const deferFinalize = (event) => {
    if (event.data?.method === "tools/call" && event.data.params?.name === "finalize_image_editor_session") {
      pendingFinalizeId = event.data.id;
      event.stopImmediatePropagation();
    }
  };
  dom.window.addEventListener("message", deferFinalize);
  const host = installHost(dom.window, { toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?destroy-new-session-race=${Date.now()}`);
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false, 3000);
    sendToApp(dom.window, {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        content: [],
        structuredContent: {
          editorSession: { id: EDITOR_SESSION_ID, imageId: IMAGE_ID, status: "destroyed" },
          artifact: { id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] },
        },
      },
    });
    await waitFor(() => pendingFinalizeId !== null, 3000);

    sendToApp(dom.window, {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        content: [],
        structuredContent: {
          editorSession: { id: NEXT_SESSION_ID, imageId: NEXT_IMAGE_ID, status: "active" },
          artifact: { id: NEXT_IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "edit", parentIds: [IMAGE_ID], childIds: [] },
        },
      },
    });

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
    pendingFinalizeId = null;
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(host.displayModeRequests.filter((mode) => mode === "inline").length, 0);
    assert.notEqual(document.querySelector(".editor-app"), null);
    assert.equal(document.querySelector("[data-tool=rectangle]").disabled, false);
  } finally {
    dom.window.removeEventListener("message", deferFinalize);
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a new editor reclaims fullscreen when an old inline request settles late", { timeout: 5000 }, async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    deferDisplayModeRequests: true,
  });

  try {
    await import(`../web/editor-runtime.mjs?destroy-late-inline-race=${Date.now()}`);
    await waitFor(() => host.pendingDisplayModeRequestCount === 1);
    host.resolveDisplayModeRequest("fullscreen");
    await waitFor(() => document.querySelector(".editor-app") !== null);

    host.setEditorSessionStatus("destroyed");
    await waitFor(() => host.pendingDisplayModeRequestCount === 1, 3000);
    host.setEditorSession({ id: NEXT_SESSION_ID, imageId: NEXT_IMAGE_ID, status: "active" });
    sendToApp(dom.window, {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        content: [],
        structuredContent: {
          editorSession: { id: NEXT_SESSION_ID, imageId: NEXT_IMAGE_ID, status: "active" },
          artifact: { id: NEXT_IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "edit", parentIds: [IMAGE_ID], childIds: [] },
        },
      },
    });
    host.resolveDisplayModeRequest("inline");

    await waitFor(() => host.pendingDisplayModeRequestCount === 1);
    assert.equal(host.displayModeRequests.at(-1), "fullscreen");
    host.resolveDisplayModeRequest("fullscreen");
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.notEqual(document.querySelector(".editor-app"), null);
    assert.equal(document.querySelector("[data-tool=rectangle]").disabled, false);
  } finally {
    host.rejectPendingDisplayModeRequests();
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("the runtime host returns status, destroy, and finalize identities for the requested session", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const host = installHost(dom.window, { toolName: "open_image_editor" });
  const responses = new Map();
  const collectResponses = (event) => {
    if (event.data?.id !== undefined && event.data?.result) responses.set(event.data.id, event.data.result);
  };
  dom.window.addEventListener("message", collectResponses);

  try {
    host.setEditorSession({ id: NEXT_SESSION_ID, imageId: NEXT_IMAGE_ID, status: "active" });
    sendToApp(dom.window, {
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: { name: "get_image_editor_session", arguments: { editorSessionId: EDITOR_SESSION_ID } },
    });
    sendToApp(dom.window, {
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: { name: "destroy_image_editor", arguments: { editorSessionId: EDITOR_SESSION_ID } },
    });
    sendToApp(dom.window, {
      jsonrpc: "2.0",
      id: 102,
      method: "tools/call",
      params: { name: "finalize_image_editor_session", arguments: { editorSessionId: EDITOR_SESSION_ID } },
    });

    await waitFor(() => responses.has(100) && responses.has(101) && responses.has(102));
    assert.deepEqual(responses.get(100).structuredContent.editorSession, {
      id: EDITOR_SESSION_ID,
      imageId: IMAGE_ID,
      status: "active",
    });
    assert.deepEqual(responses.get(101).structuredContent.editorSession, {
      id: EDITOR_SESSION_ID,
      imageId: IMAGE_ID,
      status: "destroyed",
    });
    assert.deepEqual(responses.get(102).structuredContent.editorSession, {
      id: EDITOR_SESSION_ID,
      imageId: IMAGE_ID,
      status: "released",
    });
  } finally {
    dom.window.removeEventListener("message", collectResponses);
    host.dispose();
    dom.window.close();
  }
});

test("the runtime host snapshots identities for deferred open requests", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const host = installHost(dom.window, {
    toolName: "generate_image",
    deferOpenImageEditor: true,
    uniqueEditorSessionIds: true,
  });
  const responses = new Map();
  const collectResponses = (event) => {
    if (event.data?.id !== undefined && event.data?.result) responses.set(event.data.id, event.data.result);
  };
  dom.window.addEventListener("message", collectResponses);

  try {
    sendToApp(dom.window, {
      jsonrpc: "2.0",
      id: 201,
      method: "tools/call",
      params: { name: "open_image_editor", arguments: { imageId: IMAGE_ID } },
    });
    sendToApp(dom.window, {
      jsonrpc: "2.0",
      id: 202,
      method: "tools/call",
      params: { name: "open_image_editor", arguments: { imageId: NEXT_IMAGE_ID } },
    });
    assert.equal(host.pendingOpenImageEditorRequestCount, 2);

    host.resolveOpenImageEditor(NEXT_IMAGE_ID);
    host.resolveOpenImageEditor(IMAGE_ID);
    await waitFor(() => responses.has(201) && responses.has(202));

    assert.deepEqual(responses.get(201).structuredContent.editorSession, {
      id: "eds_01J00000000000000000000001",
      imageId: IMAGE_ID,
      status: "active",
    });
    assert.deepEqual(responses.get(202).structuredContent.editorSession, {
      id: "eds_01J00000000000000000000002",
      imageId: NEXT_IMAGE_ID,
      status: "active",
    });
  } finally {
    dom.window.removeEventListener("message", collectResponses);
    host.dispose();
    dom.window.close();
  }
});
