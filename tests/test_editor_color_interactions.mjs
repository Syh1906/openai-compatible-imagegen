import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import {
  IMAGE_ID,
  installDomGlobals,
  installHost,
  pointerEvent,
  restoreDomGlobals,
  waitFor,
} from "./support/widget-runtime-host.mjs";

test("four peer color slots stay distinct and use one anchored controlled editor", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?custom-color-choice=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    const customChoice = document.querySelector('[data-color-slot="3"]');
    const colorPanel = document.querySelector("[data-custom-color-panel]");
    const colorArea = document.querySelector("[data-custom-color-area]");
    const hue = document.querySelector("[data-custom-color-hue]");
    const hex = document.querySelector("[data-custom-color-hex]");
    assert.ok(colorArea);
    assert.ok(hue);
    assert.equal(colorPanel.querySelector('input[type="color"]'), null);
    assert.deepEqual([...document.querySelectorAll("[data-color-slot]")].map((slot) => slot.dataset.color), ["#ef4444", "#2563eb", "#16a34a", "#111827"]);
    assert.equal(new Set([...document.querySelectorAll("[data-color-slot]")].map((slot) => slot.dataset.color)).size, 4);
    assert.equal(customChoice.style.getPropertyValue("--swatch"), "#111827");
    assert.equal(customChoice.getAttribute("aria-expanded"), "false");
    assert.equal(colorPanel.hidden, true);
    assert.deepEqual(activeColorChoices(), ["#ef4444"]);

    customChoice.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: false, cancelable: true }));
    assert.deepEqual(activeColorChoices(), ["#111827"]);
    assert.equal(colorPanel.hidden, true);
    assert.equal(customChoice.getAttribute("aria-expanded"), "false");

    document.querySelector('[data-color="#ef4444"]').click();
    assert.deepEqual(activeColorChoices(), ["#ef4444"]);
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 260, pointerId: 1 }));
    assert.ok(document.querySelector('[data-layer] rect[stroke="#ef4444"]'));

    Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 700 });
    customChoice.getBoundingClientRect = () => ({ left: 20, right: 60, top: 500, bottom: 540, width: 40, height: 40 });
    colorPanel.getBoundingClientRect = () => ({ left: 0, right: 260, top: 0, bottom: 320, width: 260, height: 320 });

    const contextMenu = () => new dom.window.MouseEvent("contextmenu", {
      bubbles: false,
      cancelable: true,
      button: 2,
    });
    const openMenu = contextMenu();
    customChoice.dispatchEvent(openMenu);
    assert.equal(openMenu.defaultPrevented, true);
    assert.equal(customChoice.getAttribute("aria-expanded"), "true");
    assert.equal(colorPanel.hidden, false);
    assert.equal(colorPanel.style.left, "68px");
    assert.equal(colorPanel.style.top, "360px");
    assert.equal(colorPanel.dataset.placement, "right");
    assert.equal(document.querySelector("[data-custom-color-panel-title]").textContent, "编辑颜色 4");
    assert.deepEqual(activeColorChoices(), ["#ef4444"]);

    hue.value = "120";
    hue.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    colorArea.getBoundingClientRect = () => ({ left: 100, right: 300, top: 100, bottom: 200, width: 200, height: 100 });
    colorArea.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 300, clientY: 100, pointerId: 2 }));
    colorArea.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 100, pointerId: 2 }));
    assert.equal(hex.value, "#00FF00");
    assert.deepEqual(
      ["red", "green", "blue"].map((channel) => document.querySelector(`[data-custom-color-${channel}]`).value),
      ["0", "255", "0"],
    );
    assert.equal(document.querySelector("[data-custom-color-current]").style.getPropertyValue("--preview-color"), "#111827");
    assert.equal(document.querySelector("[data-custom-color-draft]").style.getPropertyValue("--preview-color"), "#00ff00");
    assert.equal(customChoice.style.getPropertyValue("--swatch"), "#111827");
    assert.ok(document.querySelector('[data-layer] rect[stroke="#ef4444"]'));
    document.querySelector("[data-custom-color-cancel]").click();
    assert.equal(colorPanel.hidden, true);
    assert.deepEqual(activeColorChoices(), ["#ef4444"]);
    assert.equal(customChoice.style.getPropertyValue("--swatch"), "#111827");

    customChoice.dispatchEvent(contextMenu());
    customChoice.dispatchEvent(contextMenu());
    assert.equal(customChoice.getAttribute("aria-expanded"), "false");
    assert.equal(colorPanel.hidden, true);
    assert.deepEqual(activeColorChoices(), ["#ef4444"]);

    const keyboardMenu = new dom.window.KeyboardEvent("keydown", {
      key: "F10",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    customChoice.dispatchEvent(keyboardMenu);
    assert.equal(keyboardMenu.defaultPrevented, true);
    assert.equal(colorPanel.hidden, false);

    document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(colorPanel.hidden, true);
    assert.equal(document.activeElement, customChoice);
    assert.deepEqual(activeColorChoices(), ["#ef4444"]);

    customChoice.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      key: "F10",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
    assert.equal(colorPanel.hidden, false);

    hex.value = "#12";
    hex.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(hex.getAttribute("aria-invalid"), "true");
    assert.equal(document.querySelector("[data-custom-color-apply]").disabled, true);
    assert.equal(document.querySelector("[data-custom-color-error]").hidden, false);
    hex.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    assert.equal(colorPanel.hidden, false);
    assert.deepEqual(activeColorChoices(), ["#ef4444"]);
    assert.equal(customChoice.style.getPropertyValue("--swatch"), "#111827");

    hex.value = "#22c55e";
    hex.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(document.querySelector("[data-custom-color-hex]").value, "#22C55E");
    assert.deepEqual(
      ["red", "green", "blue"].map((channel) => document.querySelector(`[data-custom-color-${channel}]`).value),
      ["34", "197", "94"],
    );
    document.querySelector("[data-custom-color-apply]").click();
    assert.deepEqual(activeColorChoices(), ["#ef4444"]);
    assert.equal(customChoice.dataset.color, "#22c55e");
    assert.equal(customChoice.style.getPropertyValue("--swatch"), "#22c55e");
    assert.equal(colorPanel.hidden, true);
    assert.ok(document.querySelector('[data-layer] rect[stroke="#ef4444"]'));

    customChoice.click();
    assert.deepEqual(activeColorChoices(), ["#22c55e"]);
    assert.ok(document.querySelector('[data-layer] rect[stroke="#ef4444"]'));
    document.querySelector('[data-action="apply-foreground-color"]').click();
    assert.ok(document.querySelector('[data-layer] rect[stroke="#22c55e"]'));

    document.body.dispatchEvent(historyKey(dom.window, "z"));
    assert.ok(document.querySelector('[data-layer] rect[stroke="#ef4444"]'));
    document.body.dispatchEvent(historyKey(dom.window, "y"));
    assert.ok(document.querySelector('[data-layer] rect[stroke="#22c55e"]'));

    document.querySelector('[data-color="#2563eb"]').click();
    assert.deepEqual(activeColorChoices(), ["#2563eb"]);
    assert.ok(document.querySelector('[data-layer] rect[stroke="#22c55e"]'));
    document.querySelector('[data-action="apply-foreground-color"]').click();
    assert.ok(document.querySelector('[data-layer] rect[stroke="#2563eb"]'));
    assert.equal(customChoice.style.getPropertyValue("--swatch"), "#22c55e");

    customChoice.click();
    assert.deepEqual(activeColorChoices(), ["#22c55e"]);
    assert.ok(document.querySelector('[data-layer] rect[stroke="#2563eb"]'));
    document.querySelector('[data-action="apply-foreground-color"]').click();
    assert.ok(document.querySelector('[data-layer] rect[stroke="#22c55e"]'));
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("ContextMenu key toggles any slot editor without selecting that slot", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?custom-color-context-menu=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const customChoice = document.querySelector('[data-color-slot="2"]');
    const colorPanel = document.querySelector("[data-custom-color-panel]");
    const savedColor = customChoice.style.getPropertyValue("--swatch");
    const menuKey = () => new dom.window.KeyboardEvent("keydown", {
      key: "ContextMenu",
      bubbles: true,
      cancelable: true,
    });

    const open = menuKey();
    customChoice.dispatchEvent(open);
    assert.equal(open.defaultPrevented, true);
    assert.equal(colorPanel.hidden, false);
    assert.equal(customChoice.style.getPropertyValue("--swatch"), savedColor);
    assert.deepEqual(activeColorChoices(), ["#ef4444"]);

    const close = menuKey();
    customChoice.dispatchEvent(close);
    assert.equal(close.defaultPrevented, true);
    assert.equal(colorPanel.hidden, true);
    assert.equal(customChoice.style.getPropertyValue("--swatch"), savedColor);
    assert.deepEqual(activeColorChoices(), ["#ef4444"]);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("outside pointer events keep a color-slot draft open until an explicit action", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?custom-color-outside-click=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const customChoice = document.querySelector('[data-color-slot="3"]');
    const colorPanel = document.querySelector("[data-custom-color-panel]");
    customChoice.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
      bubbles: false,
      cancelable: true,
      button: 2,
    }));
    const hex = document.querySelector("[data-custom-color-hex]");
    hex.value = "#22c55e";
    hex.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(document.querySelector("[data-custom-color-draft]").style.getPropertyValue("--preview-color"), "#22c55e");
    assert.equal(document.querySelector("[data-color-editor-overlay]").dataset.open, "true");
    assert.equal(document.querySelector(".editor-app").dataset.colorEditorOpen, "true");

    document.body.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 700, clientY: 500, pointerId: 8 }));
    document.body.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 700, clientY: 500, pointerId: 8 }));
    document.body.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    assert.equal(colorPanel.hidden, false);
    assert.equal(customChoice.style.getPropertyValue("--swatch"), "#111827");
    assert.deepEqual(activeColorChoices(), ["#ef4444"]);

    document.querySelector("[data-custom-color-cancel]").click();
    assert.equal(colorPanel.hidden, true);
    assert.equal(document.querySelector("[data-color-editor-overlay]").dataset.open, "false");
    assert.equal(document.querySelector(".editor-app").dataset.colorEditorOpen, "false");
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("reset restores the edited slot default as a draft and applies only on confirmation", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?custom-color-reset=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const second = document.querySelector('[data-color-slot="1"]');

    applyCustomColor(dom.window, "#a855f7", { slot: 1 });
    assert.equal(second.dataset.color, "#a855f7");
    second.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
      bubbles: false,
      cancelable: true,
      button: 2,
    }));

    const reset = document.querySelector("[data-custom-color-reset]");
    assert.ok(reset);
    assert.equal(reset.getAttribute("aria-label"), "恢复颜色 2 为默认色 #2563EB");
    assert.equal(reset.title, "恢复颜色 2 为默认色 #2563EB");
    reset.click();
    assert.equal(document.querySelector("[data-custom-color-hex]").value, "#2563EB");
    assert.equal(document.querySelector("[data-custom-color-draft]").style.getPropertyValue("--preview-color"), "#2563eb");
    assert.equal(second.dataset.color, "#a855f7");
    assert.equal(document.querySelector("[data-custom-color-panel]").hidden, false);

    document.querySelector("[data-custom-color-cancel]").click();
    assert.equal(second.dataset.color, "#a855f7");
    second.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
      bubbles: false,
      cancelable: true,
      button: 2,
    }));
    document.querySelector("[data-custom-color-reset]").click();
    document.querySelector("[data-custom-color-apply]").click();
    assert.equal(second.dataset.color, "#2563eb");
    assert.equal(document.querySelector("[data-custom-color-panel]").hidden, true);
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("switching image identity discards the previous image color draft", async () => {
  const childId = "img_01J00000000000000000000001";
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?color-draft-image-switch=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const second = document.querySelector('[data-color-slot="1"]');
    second.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
      bubbles: false,
      cancelable: true,
      button: 2,
    }));
    const hex = document.querySelector("[data-custom-color-hex]");
    hex.value = "#a855f7";
    hex.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(document.querySelector("[data-custom-color-panel]").hidden, false);

    host.notifyResultArtifacts([{
      id: childId,
      mimeType: "image/png",
      width: 1,
      height: 1,
      operation: "edit",
      parentIds: [IMAGE_ID],
      childIds: [],
      annotationId: "ann_01J00000000000000000000000",
    }]);
    await waitFor(() => document.querySelector(".editor-app [data-image-id]")?.textContent === childId);

    assert.equal(document.querySelector("[data-custom-color-panel]").hidden, true);
    assert.equal(document.querySelector("[data-color-editor-overlay]").dataset.open, "false");
    const childSecond = document.querySelector('[data-color-slot="1"]');
    childSecond.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
      bubbles: false,
      cancelable: true,
      button: 2,
    }));
    assert.equal(document.querySelector("[data-custom-color-hex]").value, "#2563EB");
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("a failed version switch keeps the readable canvas and exposes a terminal error", async () => {
  const childId = "img_01J00000000000000000000001";
  const current = {
    id: IMAGE_ID,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: "edit",
    parentIds: [],
    childIds: [childId],
  };
  const { dom, host, previous } = createRuntimeHost({
    toolName: "open_image_editor",
    initialArtifacts: [current],
    failArtifactDataImageId: childId,
  });

  try {
    await import(`../web/editor-runtime.mjs?failed-version-switch=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    await waitFor(() => document.querySelector(`[data-version-id="${childId}"] .version-error`) !== null);
    const beforeUrl = document.querySelector("[data-image]").getAttribute("src");

    const childReadsBefore = host.toolCalls.filter(({ name, arguments: args }) => (
      name === "read_image_artifact_data" && args.imageId === childId
    )).length;
    document.querySelector(`[data-version-id="${childId}"]`).click();
    await waitFor(() => host.toolCalls.filter(({ name, arguments: args }) => (
      name === "read_image_artifact_data" && args.imageId === childId
    )).length > childReadsBefore);
    await waitFor(() => document.querySelector("[data-submit-status]")?.textContent === "图片读取失败 · IMG-SERVER");

    assert.equal(document.querySelector("[data-image-id]").textContent, IMAGE_ID);
    assert.equal(document.querySelector("[data-image]").hidden, false);
    assert.equal(document.querySelector("[data-image]").getAttribute("src"), beforeUrl);
    assert.equal(document.querySelector(`[data-version-id="${childId}"] .version-error`)?.textContent.trim(), "读取失败");
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

test("window resize repositions an open color editor relative to its slot", async () => {
  const { dom, host, previous } = createRuntimeHost({ toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?custom-color-resize=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 700 });
    const customChoice = document.querySelector('[data-color-slot="3"]');
    const colorPanel = document.querySelector("[data-custom-color-panel]");
    customChoice.getBoundingClientRect = () => ({ left: 20, right: 60, top: 500, bottom: 540, width: 40, height: 40 });
    colorPanel.getBoundingClientRect = () => ({ left: 0, right: 260, top: 0, bottom: 320, width: 260, height: 320 });
    customChoice.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
      bubbles: false,
      cancelable: true,
      button: 2,
    }));
    assert.equal(colorPanel.style.left, "68px");

    Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 300 });
    dom.window.dispatchEvent(new dom.window.Event("resize"));
    assert.equal(colorPanel.style.left, "32px");
    assert.equal(colorPanel.style.top, "360px");
  } finally {
    await closeRuntime(host);
    restoreRuntime(dom, previous);
  }
});

function createRuntimeHost(options) {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  dom.window.document.body.dataset.tool = options.toolName;
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, options);
  return { dom, host, previous };
}

function activeColorChoices() {
  return [...document.querySelectorAll('[data-color-slot][aria-checked="true"]')].map((item) => item.dataset.color);
}

function activeColorSlotElement() {
  return document.querySelector('[data-color-slot][aria-checked="true"]');
}

function applyCustomColor(window, color, { panelAlreadyOpen = false, slot = null } = {}) {
  if (!panelAlreadyOpen) {
    const choice = slot === null ? activeColorSlotElement() : document.querySelector(`[data-color-slot="${slot}"]`);
    choice.dispatchEvent(new window.MouseEvent("contextmenu", {
      bubbles: false,
      cancelable: true,
      button: 2,
    }));
  }
  const hex = document.querySelector("[data-custom-color-hex]");
  hex.value = color;
  hex.dispatchEvent(new window.Event("input", { bubbles: true }));
  document.querySelector("[data-custom-color-apply]").click();
}

function historyKey(window, key, options = {}) {
  return new window.KeyboardEvent("keydown", {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  });
}

async function returnToResults() {
  document.querySelector("[data-action=back]")?.click();
  await waitFor(() => document.querySelector(".inline-results") !== null);
}

async function closeRuntime(host) {
  if (document.querySelector(".editor-app")) await returnToResults().catch(() => {});
  host.dispose();
}

function restoreRuntime(dom, previous) {
  restoreDomGlobals(previous);
  dom.window.close();
}
