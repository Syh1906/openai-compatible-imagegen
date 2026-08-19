import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import { createEditorRenderer } from "../../web/editor-renderer.mjs";
import { createEditorState } from "../../web/editor-state.mjs";


test("editor renderer exposes complete stage 4.5 style and mask controls", () => {
  withRenderer(({ document, renderer }) => {
    renderer.mountEditor();

    const slots = [...document.querySelectorAll("[data-color-slot]")];
    assert.equal(slots.length, 4);
    assert.equal(document.querySelector("[data-custom-color-select]"), null);
    assert.ok(slots.every((slot) => slot.getAttribute("role") === "radio"));
    assert.ok(slots.every((slot) => /右键编辑/.test(slot.getAttribute("aria-description") || "")));
    assert.ok(document.querySelector("[data-action=edit-active-color]"));
    assert.ok(document.querySelector("[data-color-editor-overlay] [data-custom-color-panel]"));
    assert.equal(document.querySelector('[data-custom-color-panel] input[type="color"]'), null);
    assert.ok(document.querySelector("[data-custom-color-area]"));
    assert.ok(document.querySelector("[data-custom-color-hue]"));
    assert.ok(document.querySelector("[data-custom-color-current]"));
    assert.ok(document.querySelector("[data-custom-color-draft]"));
    assert.ok(document.querySelector("[data-custom-color-apply]"));
    assert.equal(document.querySelector("[data-action=undo]").title, "撤销 (Ctrl+Z)");
    assert.equal(document.querySelector("[data-action=redo]").title, "重做 (Ctrl+Y)");
    assert.deepEqual(
      [...document.querySelectorAll("[data-mask-mode]")].map((item) => [item.dataset.maskMode, item.textContent.trim()]),
      [["edit", "改图区域"], ["protect", "保护内容"]],
    );
    assert.deepEqual(
      [...document.querySelectorAll("[data-mask-radius]")].map((item) => Number(item.dataset.maskRadius)),
      [0.02, 0.035, 0.06],
    );
    assert.ok(document.querySelector('[data-destroy-confirm] [role="alertdialog"]'));
    assert.ok(document.querySelector("[data-action=confirm-destroy]"));
    assert.ok(document.querySelector("[data-action=cancel-destroy]"));
  });
});

test("editor renderer keeps compact actions named and empty copy tool-agnostic", () => {
  withRenderer(({ document, renderer }) => {
    renderer.mountEditor();

    const intentToggle = document.querySelector("[data-action=toggle-intents]");
    const destroy = document.querySelector("[data-action=destroy]");
    const clear = document.querySelector("[data-action=clear]");
    const canvas = document.querySelector("[data-canvas]");
    const closeGuidance = document.querySelector("[data-close-guidance]");
    assert.equal(intentToggle?.getAttribute("aria-label"), "修改意图");
    assert.equal(destroy?.getAttribute("aria-label"), "销毁画布");
    assert.equal(destroy?.getAttribute("aria-controls"), "destroy-confirm-dialog");
    assert.equal(clear?.textContent.trim(), "清除草稿");
    assert.equal(clear?.getAttribute("aria-label"), "清除当前工作草稿");
    assert.equal(canvas?.getAttribute("tabindex"), "0");
    assert.equal(canvas?.getAttribute("aria-label"), "图片标注画布");
    assert.equal(closeGuidance?.tagName, "BUTTON");
    assert.equal(closeGuidance?.getAttribute("aria-label"), "关闭画布说明");
    assert.equal(closeGuidance?.getAttribute("aria-describedby"), "close-guidance-description");
    assert.match(document.querySelector("#close-guidance-description")?.textContent || "", /返回会话.*保留.*直接关闭.*移除入口/);
    assert.equal(document.querySelector("[data-close-guidance-tooltip]")?.getAttribute("role"), "tooltip");
    const canvasHintId = canvas?.getAttribute("aria-describedby");
    assert.ok(canvasHintId);
    assert.equal(
      document.getElementById(canvasHintId)?.textContent.trim(),
      "选择工具后将焦点移到画布。画笔、箭头、矩形和蒙版按空格开始，方向键绘制，Enter 完成；文字按 Enter 创建；选中标注后方向键移动。",
    );
    assert.equal(document.querySelector("[data-intents] .muted")?.textContent.trim(), "在图片上标出要处理的位置。");
    assert.doesNotMatch(document.querySelector("[data-intents]")?.textContent || "", /箭头|矩形|画笔|文字|蒙版/);
  });
});

test("editor renderer keeps one explicit active slot while every slot remains editable", () => {
  withRenderer(({ document, renderer }) => {
    renderer.mountEditor();
    const base = createEditorState({ image: image("img_current", { data: "AA==" }) });
    const update = (editor) => renderer.updateEditor({
      editor,
      imageUrl: "data:image/png;base64,AA==",
      submissionInFlight: false,
      artifactLoadInFlight: false,
      undoCount: 0,
      redoCount: 0,
      modelCapabilities: { mask: true },
      intentPanelOpen: false,
      destroyConfirmOpen: false,
      submissionStatus: "",
      submissionStatusTone: "neutral",
    });

    update(base);
    assert.deepEqual(slotColors(document), ["#ef4444", "#2563eb", "#16a34a", "#111827"]);
    assert.equal(activeColorSlot(document), "0");
    assert.equal(document.querySelector("[data-custom-color-panel]").hidden, true);

    update({ ...base, color: "#22c55e", colorSlots: ["#ef4444", "#2563eb", "#22c55e", "#111827"], activeColorSlot: 2 });
    assert.equal(activeColorSlot(document), "2");
    assert.match(document.querySelector('[data-color-slot="2"]').getAttribute("aria-label"), /#22C55E/);
    assert.match(document.querySelector('[data-color-slot="2"]').getAttribute("aria-description"), /右键/);

    update({ ...base, color: "#2563eb", colorSlots: ["#ef4444", "#2563eb", "#22c55e", "#111827"], activeColorSlot: 1 });
    assert.equal(activeColorSlot(document), "1");
    assert.deepEqual(slotColors(document), ["#ef4444", "#2563eb", "#22c55e", "#111827"]);
  });
});

test("editor renderer presents mask modes, brush size, version loading, and destroy confirmation as real states", () => {
  withRenderer(({ document, renderer }) => {
    renderer.mountEditor();
    const editor = createEditorState({
      image: image("img_current", { data: "AA==" }),
      children: [image("img_child")],
    });

    renderer.updateEditor({
      editor: { ...editor, activeTool: "mask", maskMode: "protect", maskBrushRadius: 0.06 },
      imageUrl: "data:image/png;base64,AA==",
      submissionInFlight: false,
      artifactLoadInFlight: false,
      undoCount: 0,
      redoCount: 0,
      modelCapabilities: { mask: true },
      intentPanelOpen: false,
      destroyConfirmOpen: true,
      submissionStatus: "",
      submissionStatusTone: "neutral",
    });

    assert.equal(document.querySelector("[data-mask-options]")?.hidden, false);
    assert.equal(document.querySelector('[data-mask-mode="protect"]')?.getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector('[data-mask-radius="0.06"]')?.getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector("[data-destroy-confirm]")?.hidden, false);
    assert.equal(document.querySelector('[data-version-id="img_child"] .version-thumb')?.textContent.trim(), "读取中");
  });
});

test("editor lineage gives repeated revisions unique accessible names with status and image suffix", () => {
  withRenderer(({ document, renderer }) => {
    renderer.mountEditor();
    const editor = createEditorState({ image: image("img_current_ABC123", { data: "AA==" }) });
    editor.lineage = [
      { ...image("img_child_FIRST1", { data: "AA==" }), role: "child" },
      { ...image("img_child_SECOND2", { loadError: "读取失败" }), role: "child" },
    ];

    renderer.updateEditor({
      editor,
      imageUrl: "data:image/png;base64,AA==",
      submissionInFlight: false,
      artifactLoadInFlight: false,
      undoCount: 0,
      redoCount: 0,
      modelCapabilities: { mask: true },
      intentPanelOpen: false,
      destroyConfirmOpen: false,
      submissionStatus: "",
      submissionStatusTone: "neutral",
    });

    const labels = [...document.querySelectorAll("[data-version-id]")].map((item) => item.getAttribute("aria-label"));
    assert.equal(new Set(labels).size, 2);
    assert.match(labels[0], /修订 1/);
    assert.match(labels[0], /已读取/);
    assert.match(labels[0], /FIRST1/);
    assert.match(labels[1], /修订 2/);
    assert.match(labels[1], /读取失败/);
    assert.match(labels[1], /ECOND2/);
  });
});

test("mask intent fields explain edit and protect semantics", () => {
  withRenderer(({ document, renderer }) => {
    renderer.mountEditor();
    const base = createEditorState({ image: image("img_current", { data: "AA==" }) });
    const mask = (id, mode, color) => ({
      id,
      type: "mask",
      mode,
      brushRadius: 0.035,
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
      points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.3 }],
      text: "",
      color,
      strokeWidth: 5,
    });

    renderer.updateEditor({
      editor: {
        ...base,
        annotations: [
          mask("mask_edit", "edit", "#ef4444"),
          mask("mask_protect", "protect", "#2563eb"),
        ],
      },
      imageUrl: "data:image/png;base64,AA==",
      submissionInFlight: false,
      artifactLoadInFlight: false,
      undoCount: 0,
      redoCount: 0,
      modelCapabilities: { mask: true },
      intentPanelOpen: false,
      destroyConfirmOpen: false,
      submissionStatus: "",
      submissionStatusTone: "neutral",
    });

    assert.deepEqual(
      [...document.querySelectorAll("[data-annotation-text]")].map((field) => ({
        label: field.getAttribute("aria-label"),
        placeholder: field.getAttribute("placeholder"),
        meta: field.closest("[data-annotation-id]").querySelector(".annotation-item-meta span")?.textContent,
      })),
      [
        { label: "改图区域说明", placeholder: "描述这个区域需要如何修改（可选）", meta: "改图说明" },
        { label: "保护内容说明", placeholder: "说明要保留的主体、文字或纹理（可选）", meta: "保护说明" },
      ],
    );
  });
});

test("result cards expose image-scoped draft state and a continue editing action", () => {
  withRenderer(({ document, renderer }) => {
    renderer.renderInline({
      candidates: [
        { ...image("img_pending"), imageUrl: "data:image/png;base64,AA==", draftState: { kind: "pending" } },
        { ...image("img_updated"), imageUrl: "data:image/png;base64,AA==", draftState: { kind: "updated" } },
      ],
      openingImageId: "",
      inlineStatus: "",
      inlineStatusTone: "neutral",
      inlineStatusImageId: "",
      onOpen() {},
    });

    assert.equal(document.querySelector('[data-result-image-id="img_pending"] [data-draft-state]')?.textContent, "待发送");
    assert.equal(document.querySelector('[data-result-image-id="img_updated"] [data-draft-state]')?.textContent, "有更新");
    assert.deepEqual([...document.querySelectorAll("[data-action=open-editor]")].map((item) => item.textContent.trim()), ["继续编辑", "继续编辑"]);
  });
});

test("selecting a canvas annotation reveals its intent without stealing input focus", () => {
  withRenderer(({ document, renderer, window }) => {
    renderer.mountEditor();
    const base = createEditorState({ image: image("img_current", { data: "AA==" }) });
    const annotation = {
      id: "annotation_1",
      type: "rectangle",
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
      points: [],
      text: "调整这里",
      color: "#ef4444",
      strokeWidth: 5,
    };
    const editor = { ...base, annotations: [annotation] };
    let revealed = null;
    window.Element.prototype.scrollIntoView = function scrollIntoView(options) {
      revealed = { id: this.dataset.annotationId, options };
    };
    const update = (value) => renderer.updateEditor({
      editor: value,
      imageUrl: "data:image/png;base64,AA==",
      submissionInFlight: false,
      artifactLoadInFlight: false,
      undoCount: 0,
      redoCount: 0,
      modelCapabilities: { mask: true },
      intentPanelOpen: false,
      destroyConfirmOpen: false,
      submissionStatus: "",
      submissionStatusTone: "neutral",
    });

    update(editor);
    const applyColor = document.querySelector('[data-action="apply-foreground-color"]');
    assert.ok(applyColor);
    assert.equal(applyColor.disabled, true);
    assert.match(applyColor.getAttribute("aria-label") || "", /第 1 条标注/);
    const prompt = document.querySelector("[data-prompt]");
    prompt.focus();
    update({ ...editor, color: "#2563eb", activeColorSlot: 1, selectedAnnotationId: annotation.id });

    assert.deepEqual(revealed, { id: annotation.id, options: { block: "nearest" } });
    assert.equal(document.activeElement, prompt);
    assert.equal(document.querySelector('[data-action="apply-foreground-color"]').disabled, false);
  });
});

function withRenderer(callback) {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>');
  const previous = new Map();
  for (const [name, value] of Object.entries({
    document: dom.window.document,
    Element: dom.window.Element,
    SVGElement: dom.window.SVGElement,
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try {
    callback({ document: dom.window.document, renderer: createEditorRenderer(dom.window.document.querySelector("main")), window: dom.window });
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    dom.window.close();
  }
}

function image(id, extra = {}) {
  return { id, mimeType: "image/png", width: 100, height: 100, parentIds: [], childIds: [], ...extra };
}

function activeColorSlot(document) {
  return document.querySelector('[data-color-slot][aria-checked="true"]')?.dataset.colorSlot || null;
}

function slotColors(document) {
  return [...document.querySelectorAll("[data-color-slot]")].map((item) => item.dataset.color);
}
