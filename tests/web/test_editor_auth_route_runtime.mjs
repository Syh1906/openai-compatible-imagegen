import assert from "node:assert/strict";
import test from "node:test";

import {
  installDomGlobals,
  installHost,
  restoreDomGlobals,
  sendToApp,
  waitFor,
  IMAGE_ID,
} from "../support/widget-runtime-host.mjs";
import { JSDOM } from "jsdom";

test("canvas honors composer preference with both host routes available", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body><main></main></body></html>", { url: "https://widget.local/", pretendToBeVisual: true });
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    authConfig: { defaultAuthMode: "chatgpt", apiKeyConfigured: true, chatgptRequirement: "codex_app_imagegen_handoff", canvasSubmissionMode: "composer" },
    hostCapabilities: { message: { text: {}, image: {} }, updateModelContext: { text: {}, image: {}, structuredContent: {} } },
  });
  try {
    await import(`../../web/editor-runtime.mjs?submission-mode=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "换成绿色";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await waitFor(() => document.querySelector("[data-action=submit]")?.disabled === false);
    document.querySelector("[data-action=submit]").click();
    await waitFor(() => host.modelContexts.some((item) => item.content?.some((block) => block.type === "image")));
    await waitFor(() => host.displayModeRequests.includes("inline"));
    assert.equal(host.messages.length, 0);
    const context = host.modelContexts.find((item) => item.content?.some((block) => block.type === "image"));
    assert.deepEqual(context.content.map((item) => item.type), ["text", "image"]);
    assert.equal(context.structuredContent.authMode, "chatgpt");
  } finally {
    sendToApp(dom.window, { jsonrpc: "2.0", id: "submission-mode-teardown", method: "ui/resource-teardown", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    host.dispose(); restoreDomGlobals(previous); dom.window.close();
  }
});

test("opening an existing result card loads the configured model list without searching", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body><main></main></body></html>", { url: "https://widget.local/", pretendToBeVisual: true });
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialArtifacts: [{ id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1 }],
    authConfig: { defaultAuthMode: "chatgpt", apiKeyConfigured: true, chatgptRequirement: "codex_app_imagegen_handoff" },
  });
  try {
    await import(`../../web/editor-runtime.mjs?result-model-entry=${Date.now()}`);
    await waitFor(() => document.querySelector('[data-action="open-editor"]')?.disabled === false);
    document.querySelector('[data-action="open-editor"]').click();
    await waitFor(() => document.querySelector('[data-auth-mode="apikey"]'));
    document.querySelector('[data-auth-mode="apikey"]').click();
    await waitFor(() => document.querySelector('[data-profile="primary/gpt-image-2"]'));
    assert.equal(host.toolCalls.filter(({ name }) => name === "list_image_models").length, 1);
    assert.equal(document.querySelector('[data-profile="primary/gpt-image-2"]').hidden, false);
  } finally {
    sendToApp(dom.window, { jsonrpc: "2.0", id: "result-model-entry-teardown", method: "ui/resource-teardown", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    host.dispose(); restoreDomGlobals(previous); dom.window.close();
  }
});

test("configured API models remain selectable when ChatGPT is the preferred route", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body><main></main></body></html>", { url: "https://widget.local/", pretendToBeVisual: true });
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    authConfig: { defaultAuthMode: "chatgpt", apiKeyConfigured: true, chatgptRequirement: "codex_app_imagegen_handoff" },
    modelCatalog: { activeProfile: "first", models: [
      { id: "first", model: "first-image", provider: "p", capabilities: { edit: true } },
      { id: "second", model: "future-image", displayName: "自定义模型", aliases: ["beta"], provider: "q", capabilities: { edit: true }, parameterFields: { seed: { type: "integer", path: ["seed"], default: 7 } } },
    ] },
  });
  try {
    await import(`../../web/editor-runtime.mjs?api-selector=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    assert.equal(document.querySelector('[data-auth-mode="chatgpt"]').getAttribute("aria-pressed"), "true");
    document.querySelector('[data-auth-mode="apikey"]').click();
    const selector = document.querySelector("[data-model-selector]");
    assert.equal(selector.hidden, false);
    selector.querySelector("summary").click();
    const search = selector.querySelector('input[type="search"]');
    search.value = "beta";
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    selector.querySelector('[data-profile="second"]').click();
    assert.equal(document.querySelector("[data-action=submit]").disabled, true);
    const input = selector.querySelector('input[type="number"]');
    input.value = "13";
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    document.querySelector('[data-auth-mode="chatgpt"]').click();
    document.querySelector('[data-auth-mode="apikey"]').click();
    assert.equal(selector.querySelector("summary").textContent, "自定义模型");
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "换成蓝色";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    document.querySelector("[data-action=submit]").click();
    await waitFor(() => host.toolCalls.some(({ name }) => name === "prepare_image_edit_submission"));
    assert.deepEqual(host.toolCalls.find(({ name }) => name === "prepare_image_edit_submission").arguments.modelSelection,
      { authMode: "apikey", modelProfileId: "second", parameters: { seed: 13 } });
  } finally {
    sendToApp(dom.window, { jsonrpc: "2.0", id: "model-selector-teardown", method: "ui/resource-teardown", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    host.dispose(); restoreDomGlobals(previous); dom.window.close();
  }
});

test("a failed catalog stays actionable and reloads only when the user requests it", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body><main></main></body></html>", { url: "https://widget.local/", pretendToBeVisual: true });
  const previous = installDomGlobals(dom.window);
  let rejectCatalog = true;
  const host = installHost(dom.window, { toolName: "open_image_editor", rejectModelCatalog: () => rejectCatalog });
  try {
    await import(`../../web/editor-runtime.mjs?model-catalog-retry=${Date.now()}`);
    await waitFor(() => document.querySelector('[data-model-catalog-state="error"]'));
    assert.equal(document.querySelector('input[type="search"]'), null);
    assert.equal(document.querySelector("[data-action=submit]").disabled, true);
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "保留形状，改成绿色";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(document.querySelector("[data-action=submit]").disabled, true, "editing the prompt must not bypass an unavailable model catalog");
    document.querySelector('[data-auth-mode="chatgpt"]').click();
    document.querySelector('[data-auth-mode="apikey"]').click();
    assert.equal(host.toolCalls.filter(({ name }) => name === "list_image_models").length, 1);
    rejectCatalog = false;
    document.querySelector("[data-model-retry]").click();
    await waitFor(() => document.querySelector('[data-profile="primary/gpt-image-2"]'));
    assert.equal(host.toolCalls.filter(({ name }) => name === "list_image_models").length, 2);
    assert.equal(document.querySelector("[data-prompt]").value, "保留形状，改成绿色");
    assert.equal(document.querySelector("[data-action=submit]").disabled, false);
  } finally {
    sendToApp(dom.window, { jsonrpc: "2.0", id: "model-catalog-retry-teardown", method: "ui/resource-teardown", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    host.dispose(); restoreDomGlobals(previous); dom.window.close();
  }
});

test("canvas reads the explicitly active custom profile rather than the legacy profile", async () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body><main></main></body></html>", {
    url: "https://widget.local/", pretendToBeVisual: true,
  });
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    modelCatalog: {
      activeProfile: "vendor/image25",
      models: [{ id: "vendor/image25", provider: "vendor", model: "gpt-image-2.5-flare", capabilities: { mask: true } }],
    },
  });
  try {
    await import(`../../web/editor-runtime.mjs?custom-profile=${Date.now()}`);
    await waitFor(() => host.toolCalls.some(({ name }) => name === "list_image_models"));
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.doesNotMatch(document.body.textContent, /无法读取当前模型能力/);
  } finally {
    sendToApp(dom.window, { jsonrpc: "2.0", id: "custom-profile-teardown", method: "ui/resource-teardown", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});


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
