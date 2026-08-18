import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import {
  IMAGE_ID,
  installDomGlobals,
  installHost,
  restoreDomGlobals,
  waitFor,
} from "./support/widget-runtime-host.mjs";

test("result widget starts fullscreen handoff while the editor session is still opening", async () => {
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
    await import(`../web/editor-runtime.mjs?opening-handoff=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-action=open-editor]")?.disabled === false);
    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => host.pendingOpenImageEditorRequestCount === 1);
    await waitFor(() => host.displayModeRequests.length === 1);
    assert.deepEqual(host.displayModeRequests, ["fullscreen"]);
    host.resolveOpenImageEditor();
    await waitFor(() => document.querySelector(".editor-app") !== null);
  } finally {
    if (host.pendingOpenImageEditorRequestCount > 0) {
      host.resolveOpenImageEditor();
      await waitFor(() => document.querySelector(".editor-app") !== null).catch(() => {});
    }
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});
