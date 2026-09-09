import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { IMAGE_ID, installDomGlobals, installHost, restoreDomGlobals, sendToApp, waitFor } from "../support/widget-runtime-host.mjs";

for (const ending of ["success", "server-error", "teardown"]) {
  test(`slow result reads handle ${ending} without another image request`, async () => {
    const dom = new JSDOM("<!doctype html><html><body><main></main></body></html>", { pretendToBeVisual: true, url: "https://widget.local/" });
    const previous = installDomGlobals(dom.window);
    const timers = new Map();
    const originalSetTimeout = dom.window.setTimeout.bind(dom.window);
    const originalClearTimeout = dom.window.clearTimeout.bind(dom.window);
    let timerId = -1;
    dom.window.setTimeout = (callback, delay, ...args) => {
      if (delay !== 8000) return originalSetTimeout(callback, delay, ...args);
      const id = timerId--;
      timers.set(id, callback);
      return id;
    };
    dom.window.clearTimeout = (id) => { if (!timers.delete(id)) originalClearTimeout(id); };
    const secondId = "img_01J00000000000000000000001";
    const host = installHost(dom.window, { toolName: "render_image_results", initialArtifacts: [IMAGE_ID, secondId].map((id) => ({ id, mimeType: "image/png", width: 1, height: 1 })), deferArtifactDataImageIds: [IMAGE_ID] });
    const slowImage = () => document.querySelector(`[data-result-image-id="${IMAGE_ID}"] [data-image]:not([hidden])`);
    try {
      await import(`../../web/editor-runtime.mjs?slow-artifacts=${ending}-${Date.now()}`);
      await waitFor(() => host.pendingArtifactDataRequestCount === 1 && timers.size > 0);
      for (const callback of timers.values()) callback();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.doesNotMatch(document.body.textContent, /IMG-SERVER/);
      assert.match(document.body.textContent, /读取较慢/);
      assert.ok(document.querySelector(`[data-result-image-id="${secondId}"] [data-image]`));
      if (ending === "server-error") {
        sendToApp(dom.window, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { isError: true, content: [{ type: "text", text: "artifact_read_failed: 读取图片产物失败。" }] } });
        await waitFor(() => document.body.textContent.includes("IMG-SERVER"));
      } else if (ending === "teardown") {
        sendToApp(dom.window, { jsonrpc: "2.0", id: "slow-teardown", method: "ui/resource-teardown", params: {} });
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      const before = document.body.innerHTML;
      host.resolveArtifactData(IMAGE_ID);
      if (ending === "success") {
        await waitFor(() => slowImage() !== null);
        assert.doesNotMatch(document.body.textContent, /读取较慢|IMG-SERVER/);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert.equal(slowImage(), null);
        if (ending === "teardown") assert.equal(document.body.innerHTML, before);
      }
      assert.equal(host.toolCalls.filter(({ name, arguments: args }) => name === "read_image_artifact_data" && args.imageId === IMAGE_ID).length, 1);
    } finally {
      if (host.pendingArtifactDataRequestCount) host.resolveArtifactData(IMAGE_ID);
      sendToApp(dom.window, { jsonrpc: "2.0", id: "slow-cleanup", method: "ui/resource-teardown", params: {} });
      await new Promise((resolve) => setTimeout(resolve, 40));
      host.dispose();
      restoreDomGlobals(previous);
      dom.window.close();
    }
  });
}
