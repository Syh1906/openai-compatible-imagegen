import assert from "node:assert/strict";
import test from "node:test";

import {
  installDomGlobals,
  installHost,
  restoreDomGlobals,
  sendToApp,
  waitFor,
} from "../support/widget-runtime-host.mjs";
import { JSDOM } from "jsdom";


test("canvas keeps both routes visible and submits ChatGPT edits", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body><main></main></body></html>", {
    url: "https://widget.local/",
    pretendToBeVisual: true,
  });
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    authConfig: {
      defaultAuthMode: "chatgpt",
      apiKeyConfigured: false,
      chatgptRequirement: "codex_app_imagegen_handoff",
    },
  });

  try {
    await import(`../../web/editor-runtime.mjs?auth-route=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const apiKey = document.querySelector('[data-auth-mode="apikey"]');
    const chatgpt = document.querySelector('[data-auth-mode="chatgpt"]');
    assert.ok(apiKey);
    assert.ok(chatgpt);
    assert.equal(chatgpt.getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector("[data-auth-route-status]").textContent, "ChatGPT 已选择");
    assert.equal(document.querySelector("[data-tool=mask]").hidden, false);

    apiKey.click();
    assert.equal(apiKey.getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector("[data-auth-route-status]").textContent, "需要配置");
    chatgpt.click();
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "保持主体，调整光线";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    document.querySelector("[data-action=submit]").click();
    await waitFor(() => host.toolCalls.some(({ name }) => name === "prepare_image_edit_submission"));
    await waitFor(() => host.messages.length + host.modelContexts.length > 0);

    assert.equal(host.messages.length + host.modelContexts.length > 0, true);
  } finally {
    sendToApp(dom.window, {
      jsonrpc: "2.0",
      id: "chatgpt-auth-route-teardown",
      method: "ui/resource-teardown",
      params: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});
