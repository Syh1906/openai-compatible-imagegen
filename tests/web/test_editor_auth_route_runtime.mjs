import assert from "node:assert/strict";
import test from "node:test";

import {
  installDomGlobals,
  installHost,
  restoreDomGlobals,
  waitFor,
} from "../support/widget-runtime-host.mjs";
import { JSDOM } from "jsdom";


test("canvas keeps both routes visible and blocks ChatGPT edits before side effects", async () => {
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
    assert.equal(document.querySelector("[data-auth-route-status]").textContent, "当前图片生成路线暂不支持画布编辑");

    apiKey.click();
    assert.equal(apiKey.getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector("[data-auth-route-status]").textContent, "需要配置");
    chatgpt.click();
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "保持主体，调整光线";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    document.querySelector("[data-action=submit]").click();
    await waitFor(() => document.querySelector("[data-submit-status]").textContent.includes("暂不支持画布编辑"));

    assert.equal(host.toolCalls.some(({ name }) => name === "prepare_image_edit_submission"), false);
    assert.equal(host.messages.length, 0);
    assert.equal(host.modelContexts.length, 0);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});
