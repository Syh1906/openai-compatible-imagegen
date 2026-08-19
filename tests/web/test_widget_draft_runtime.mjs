import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import {
  CODEX_COMPOSER_HOST_CAPABILITIES,
  IMAGE_ID,
  installDomGlobals,
  installHost,
  pointerEvent,
  restoreDomGlobals,
  sendToApp,
  waitFor,
} from "../support/widget-runtime-host.mjs";

test("editor changes are saved automatically after the debounce window", { timeout: 5000 }, async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor" });

  try {
    await import(`../../web/editor-runtime.mjs?draft-autosave=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "防抖后自动保存";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    assert.equal(host.toolCalls.some(({ name }) => name === "save_image_editor_draft"), false);
    await waitFor(() => host.toolCalls.some(({ name }) => name === "save_image_editor_draft"), 1500);
    const saves = host.toolCalls.filter(({ name }) => name === "save_image_editor_draft");
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0].arguments.draft, { annotations: [], prompt: "防抖后自动保存" });
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a new editor widget restores the draft returned by open_image_editor", async () => {
  const draft = {
    annotations: [{
      id: "rectangle_1",
      type: "rectangle",
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
      color: "#22c55e",
      strokeWidth: 3,
      text: "保留这个矩形区域",
    }],
    prompt: "背景改为浅灰色",
  };
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor", initialEditorDraft: draft });

  try {
    await import(`../../web/editor-runtime.mjs?draft-restore=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);

    const restored = document.querySelector("[data-annotation-id='rectangle_1']");
    assert.ok(restored);
    assert.equal(restored.querySelector("textarea")?.value, "保留这个矩形区域");
    assert.equal(document.querySelector("[data-prompt]")?.value, "背景改为浅灰色");
    assert.equal(document.querySelector("[data-layer] rect")?.getAttribute("stroke-width"), "3");
    assert.deepEqual(
      [
        document.querySelector("[data-layer] rect")?.getAttribute("x"),
        document.querySelector("[data-layer] rect")?.getAttribute("y"),
        document.querySelector("[data-layer] rect")?.getAttribute("width"),
        document.querySelector("[data-layer] rect")?.getAttribute("height"),
      ],
      ["100", "200", "300", "400"],
    );
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("current Codex host stages annotations and prompt in one composer payload", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    hostCapabilities: CODEX_COMPOSER_HOST_CAPABILITIES,
  });

  try {
    await import(`../../web/editor-runtime.mjs?annotations=${Date.now()}`);
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => document.querySelector("[data-image-id]")?.textContent === IMAGE_ID);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });

    document.querySelector("[data-tool=arrow]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 1 }));
    document.querySelector("[data-tool=pen]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 400, clientY: 400, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 500, clientY: 500, pointerId: 2 }));

    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 2);
    assert.equal(host.modelContexts.length, 0);
    assert.equal(host.messages.length, 0);

    const firstAnnotation = document.querySelector("[data-annotation-id]");
    const secondAnnotation = document.querySelectorAll("[data-annotation-id]")[1];
    const firstDescription = firstAnnotation?.querySelector("textarea");
    assert.ok(firstDescription);
    assert.equal(firstDescription.maxLength, 600);
    assert.equal(firstAnnotation.querySelector("[data-annotation-count]")?.textContent, "0/600");
    firstDescription.focus();
    assert.equal(firstAnnotation.classList.contains("selected"), true);
    assert.equal(secondAnnotation?.classList.contains("selected"), false);
    firstDescription.value = "只修改箭头区域";
    firstDescription.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(firstAnnotation.querySelector("[data-annotation-count]")?.textContent, "7/600");
    assert.equal(secondAnnotation?.querySelector("textarea")?.value, "");

    document.querySelector("[data-action=submit]").click();
    assert.match(document.querySelector("[data-submit-status]")?.textContent || "", /^正在/);
    document.querySelector("[data-action=submit]").click();
    await waitFor(() => host.toolCalls.some(({ name }) => name === "prepare_image_edit_submission"));
    await waitFor(() => host.modelContexts.length === 1);
    await waitFor(() => document.querySelector(".inline-result") !== null);
    assert.equal(host.messages.length, 0);
    assert.equal(host.modelContexts[0].structuredContent.annotationCount, 2);
    assert.equal(host.modelContexts[0].structuredContent.intents[0], "1. 箭头指引：只修改箭头区域");
    assert.deepEqual(host.modelContexts[0].content.map((item) => item.type), ["text", "image"]);
    assert.match(host.modelContexts[0].content[0].text, /1\. 箭头指引：只修改箭头区域/);
    assert.match(host.modelContexts[0].content[0].text, /2\. 画笔标注：请参考笔触范围/);
    assert.equal(host.modelContexts[0].content[1].mimeType, "image/png");
    assert.equal(host.modelContexts[0].content[1].data, "cG5nLXByZXZpZXc=");
    assert.deepEqual([document.querySelector("[data-inline-status]")?.textContent, document.querySelector("[data-draft-state]")?.textContent, document.querySelector("[data-action=open-editor]")?.textContent.trim()], ["图文修改请求已放入任务输入框，请确认后发送", "待发送", "继续编辑"]);
    const prepareCalls = host.toolCalls.filter(({ name }) => name === "prepare_image_edit_submission");
    assert.equal(prepareCalls.length, 1);
    assert.equal(prepareCalls[0].arguments.parentImageId, IMAGE_ID);
    assert.equal(prepareCalls[0].arguments.items.length, 2);
    assert.equal(prepareCalls[0].arguments.items[0].text, "只修改箭头区域");
    assert.equal(host.displayModeRequests.at(-1), "inline");

    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => document.querySelector(".editor-app") !== null);
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 2);
    assert.equal(document.querySelector("[data-annotation-text]").value, "只修改箭头区域");
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("returning before submission preserves the result without creating an edit", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    hostCapabilities: CODEX_COMPOSER_HOST_CAPABILITIES,
  });

  try {
    await import(`../../web/editor-runtime.mjs?cancel-before-submit=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "只在画布中暂存，随后取消";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null);

    assert.equal(host.toolCalls.some(({ name }) => name === "prepare_image_edit_submission"), false);
    assert.equal(host.toolCalls.some(({ name }) => name === "edit_image"), false);
    assert.equal(document.querySelector("[data-draft-state]")?.textContent, "未提交");
    assert.equal(document.querySelector("[data-action=open-editor]")?.textContent.trim(), "继续编辑");
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a late composer acknowledgement unlocks its exact updated draft", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    hostCapabilities: CODEX_COMPOSER_HOST_CAPABILITIES,
    deferModelContext: true,
  });

  try {
    await import(`../../web/editor-runtime.mjs?late-composer-ack=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "第一版要求";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    document.querySelector("[data-action=submit]").click();

    await waitFor(() => host.modelContexts.length === 1);
    await waitFor(() => document.querySelector(".inline-result") !== null, 2000);
    assert.equal(document.querySelector("[data-draft-state]")?.textContent, "写入中");
    host.releaseModelContext();
    await Promise.resolve();

    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => document.querySelector(".editor-app") !== null);
    const restoredPrompt = document.querySelector("[data-prompt]");
    restoredPrompt.value = "迟到确认后的第二版要求";
    restoredPrompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    const submit = document.querySelector("[data-action=submit]");
    await waitFor(() => submit.disabled === false);
    assert.equal(submit.textContent, "更新任务输入框");
    submit.click();
    await waitFor(() => host.modelContexts.length === 2);
    assert.equal(host.toolCalls.filter(({ name }) => name === "prepare_image_edit_submission").length, 2);
    host.releaseModelContext();
    await waitFor(() => document.querySelector(".inline-result") !== null, 2000);
  } finally {
    host.rejectModelContext();
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});


test("a rejected task-input replacement restores the previous pending snapshot", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    hostCapabilities: CODEX_COMPOSER_HOST_CAPABILITIES,
    deferModelContext: true,
  });

  try {
    await import(`../../web/editor-runtime.mjs?rejected-replacement=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "第一版要求";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    document.querySelector("[data-action=submit]").click();

    await waitFor(() => host.modelContexts.length === 1);
    host.releaseModelContext();
    await waitFor(() => document.querySelector(".inline-result") !== null, 2000);
    assert.equal(document.querySelector("[data-draft-state]")?.textContent, "待发送");

    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => document.querySelector(".editor-app") !== null);
    const changedPrompt = document.querySelector("[data-prompt]");
    changedPrompt.value = "第二版要求";
    changedPrompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const submit = document.querySelector("[data-action=submit]");
    assert.equal(submit.textContent, "更新任务输入框");
    submit.click();

    await waitFor(() => host.modelContexts.length === 2);
    await waitFor(() => document.querySelector(".inline-result") !== null, 2000);
    assert.equal(document.querySelector("[data-draft-state]")?.textContent, "写入中");
    host.rejectModelContext();
    await waitFor(() => document.querySelector("[data-draft-state]")?.textContent === "有更新");
    assert.equal(document.querySelector("[data-inline-status]")?.textContent, "任务输入框更新失败，仍保留上一版，可重新更新");

    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => document.querySelector(".editor-app") !== null);
    assert.equal(document.querySelector("[data-action=submit]")?.textContent, "更新任务输入框");
  } finally {
    host.rejectModelContext();
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("resource teardown cancels a pending composer transaction before draft and display updates", { timeout: 5000 }, async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    hostCapabilities: CODEX_COMPOSER_HOST_CAPABILITIES,
    deferModelContext: true,
  });

  try {
    await import(`../../web/editor-runtime.mjs?teardown-pending-composer=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "销毁前的未完成要求";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    document.querySelector("[data-action=submit]").click();

    await waitFor(() => host.modelContexts.length === 1);
    const displayModeRequestsBeforeTeardown = [...host.displayModeRequests];
    sendToApp(dom.window, {
      jsonrpc: "2.0",
      id: "teardown-pending-composer",
      method: "ui/resource-teardown",
      params: {},
    });
    await waitFor(() => host.toolCalls.some(({ name }) => name === "finalize_image_editor_session"));
    host.releaseModelContext();
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(host.displayModeRequests, displayModeRequestsBeforeTeardown);
    assert.equal(document.body.dataset.view, "editor");
    assert.equal(document.querySelector(".inline-result"), null);
  } finally {
    host.rejectModelContext();
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});


test("a late composer rejection unlocks the changed draft for a new submission", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    hostCapabilities: CODEX_COMPOSER_HOST_CAPABILITIES,
    deferModelContext: true,
  });

  try {
    await import(`../../web/editor-runtime.mjs?late-composer-reject=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "第一版要求";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    document.querySelector("[data-action=submit]").click();

    await waitFor(() => host.modelContexts.length === 1);
    await waitFor(() => document.querySelector(".inline-result") !== null, 2000);
    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => document.querySelector(".editor-app") !== null);
    const changedPrompt = document.querySelector("[data-prompt]");
    changedPrompt.value = "迟到拒绝后的第二版要求";
    changedPrompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const submit = document.querySelector("[data-action=submit]");
    assert.equal(submit.disabled, true);
    assert.equal(submit.textContent, "等待上一版确认");

    host.rejectModelContext();
    await waitFor(() => submit.disabled === false);
    assert.equal(submit.textContent, "提交修改");
    assert.equal(document.querySelector("[data-submit-status]")?.textContent, "任务输入框更新失败，可重新提交");

    submit.click();
    await waitFor(() => host.modelContexts.length === 2);
    assert.equal(host.toolCalls.filter(({ name }) => name === "prepare_image_edit_submission").length, 2);
    assert.match(host.modelContexts[1].content[0].text, /迟到拒绝后的第二版要求/);
    host.releaseModelContext();
    await waitFor(() => document.querySelector(".inline-result") !== null, 2000);
  } finally {
    host.rejectModelContext();
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});
