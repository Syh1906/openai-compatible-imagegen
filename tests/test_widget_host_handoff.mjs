import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import {
  IMAGE_ID,
  installDomGlobals,
  installHost,
  restoreDomGlobals,
  sendToApp,
  waitFor,
} from "./support/widget-runtime-host.mjs";


test("a reopened canvas restores the draft transferred by the previous host resource", async () => {
  const draft = {
    annotations: [{
      id: "arrow-1",
      type: "arrow",
      from: { x: 0.1, y: 0.2 },
      to: { x: 0.7, y: 0.8 },
      text: "调整箭头区域",
      color: "#2563eb",
      strokeWidth: 3,
    }],
    prompt: "保留未发送的修改草稿",
  };
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialEditorDraft: draft,
    initialArtifacts: [{ id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] }],
  });

  try {
    await import(`../web/editor-runtime.mjs?host-handoff-draft=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-action=open-editor]")?.disabled === false);
    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => document.querySelector(".editor-app") !== null);

    assert.equal(document.querySelector("[data-prompt]")?.value, draft.prompt);
    assert.equal(document.querySelector('[data-annotation-id="arrow-1"] [data-annotation-text]')?.value, "调整箭头区域");
  } finally {
    sendToApp(dom.window, { jsonrpc: "2.0", id: "host-handoff-draft-teardown", method: "ui/resource-teardown", params: {} });
    await waitFor(() => host.toolCalls.some(({ name }) => name === "finalize_image_editor_session")).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a restored fullscreen result opens the editor without a redundant host transition", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialDisplayMode: "fullscreen",
    initialArtifacts: [{ id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] }],
  });

  try {
    await import(`../web/editor-runtime.mjs?restored-fullscreen-result=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-action=open-editor]")?.disabled === false);
    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => document.querySelector(".editor-app") !== null);
    assert.deepEqual(host.displayModeRequests, []);
  } finally {
    sendToApp(dom.window, { jsonrpc: "2.0", id: "restored-fullscreen-result-teardown", method: "ui/resource-teardown", params: {} });
    await waitFor(() => host.toolCalls.some(({ name }) => name === "finalize_image_editor_session")).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});
