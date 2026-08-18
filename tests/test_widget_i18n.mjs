import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { createWidgetI18n, messageKeys, resolveWidgetLocale } from "../web/widget-i18n.mjs";
import { createEditorToast } from "../web/editor-toast.mjs";
import {
  IMAGE_ID,
  installDomGlobals,
  installHost,
  pointerEvent,
  restoreDomGlobals,
  waitFor,
} from "./support/widget-runtime-host.mjs";

test("widget locales have identical keys and use English outside Chinese locales", () => {
  assert.deepEqual(messageKeys("en"), messageKeys("zh-CN"));
  assert.equal(resolveWidgetLocale(), "en");
  assert.equal(resolveWidgetLocale("en-US"), "en");
  assert.equal(resolveWidgetLocale("fr-FR"), "en");
  assert.equal(resolveWidgetLocale("zh"), "zh-CN");
  assert.equal(resolveWidgetLocale("zh-CN"), "zh-CN");
  assert.equal(resolveWidgetLocale("zh-TW"), "zh-CN");
  assert.equal(resolveWidgetLocale("ZH-Hant-HK"), "zh-CN");

  const i18n = createWidgetI18n();
  assert.equal(i18n.locale, "en");
  assert.equal(i18n.t("result.openCanvas"), "Open canvas");
  i18n.setLocale("zh-TW");
  assert.equal(i18n.t("result.openCanvas"), "打开画布");

  const english = createWidgetI18n("en-US");
  for (const key of messageKeys()) {
    assert.doesNotMatch(english.t(key), /\p{Script=Han}/u, key);
  }
});

test("runtime toasts use the active widget locale", () => {
  const dom = new JSDOM('<!doctype html><html><body><main><div data-toast></div></main></body></html>', {
    pretendToBeVisual: true,
    url: "https://widget.local/",
  });
  const previous = installDomGlobals(dom.window);
  try {
    const i18n = createWidgetI18n("en-US");
    const toast = createEditorToast({
      root: document.querySelector("main"),
      window: dom.window,
      isActive: () => true,
      localize: i18n.localizeText,
      onFallback: () => {},
    });
    toast.show("宿主尚未连接，暂时无法返回会话");
    assert.equal(document.querySelector("[data-toast]").textContent, "The host is not connected, so the conversation cannot be restored yet");
    i18n.setLocale("zh-TW");
    toast.show("The host is not connected, so the conversation cannot be restored yet");
    assert.equal(document.querySelector("[data-toast]").textContent, "宿主尚未连接，暂时无法返回会话");
    toast.dispose();
  } finally {
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("localizing an already Chinese tree does not rewrite its DOM", async () => {
  const dom = new JSDOM('<!doctype html><html><body><main aria-label="会话图片结果"><button title="打开画布">打开画布</button></main></body></html>');
  const root = dom.window.document.querySelector("main");
  const mutations = [];
  const observer = new dom.window.MutationObserver((records) => mutations.push(...records));
  observer.observe(root, { attributes: true, characterData: true, subtree: true });

  createWidgetI18n("zh-CN").localizeTree(root);
  await Promise.resolve();

  observer.disconnect();
  assert.equal(mutations.length, 0);
  dom.window.close();
});

test("result card follows the initial host locale and live locale changes", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialHostContext: { locale: "en-US" },
    initialArtifacts: [{ id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] }],
  });

  try {
    await import(`../web/editor-runtime.mjs?i18n-result=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-action=open-editor]")?.textContent.trim() === "Open canvas");
    assert.equal(document.querySelector(".eyebrow")?.textContent, "Image result");

    host.notifyHostContextChanged({ locale: "zh-TW" });
    await waitFor(() => document.querySelector("[data-action=open-editor]")?.textContent.trim() === "打开画布");
    assert.equal(document.querySelector(".eyebrow")?.textContent, "图片结果");
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("editor text, tooltips, placeholders, and accessibility labels are localized", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    initialHostContext: { locale: "en-US" },
  });

  try {
    await import(`../web/editor-runtime.mjs?i18n-editor=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    assert.equal(document.querySelector("[data-action=back]")?.textContent.trim(), "Back to conversation");
    assert.equal(document.querySelector("[data-action=submit]")?.textContent.trim(), "Submit changes");
    assert.equal(document.querySelector("[data-prompt]")?.placeholder, "For example: keep the overall style and subject proportions unchanged");
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 1 }));
    assert.equal(document.querySelector("[data-annotation-id] strong")?.textContent, "Area adjustment");
    assert.deepEqual(collectHanTextAndAttributes(document.querySelector("main")), []);

    host.notifyHostContextChanged({ locale: "zh-Hant-HK" });
    await waitFor(() => document.querySelector("[data-action=back]")?.textContent.trim() === "返回会话");
    assert.equal(document.querySelector("[data-action=submit]")?.textContent.trim(), "提交修改");
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

function collectHanTextAndAttributes(root) {
  const values = [];
  const walker = root.ownerDocument.createTreeWalker(root, root.ownerDocument.defaultView.NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const value = walker.currentNode.nodeValue.trim();
    if (/\p{Script=Han}/u.test(value)) values.push(value);
  }
  for (const element of root.querySelectorAll("*")) {
    for (const name of ["aria-label", "aria-description", "aria-valuetext", "placeholder", "title"]) {
      const value = element.getAttribute(name);
      if (value && /\p{Script=Han}/u.test(value)) values.push(`${name}=${value}`);
    }
  }
  return values;
}
