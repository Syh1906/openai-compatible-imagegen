import {
  DEFAULT_ANNOTATION_COLOR_SLOTS,
  updateAnnotation as updateEditorAnnotation,
} from "./editor-state.mjs";
import { computeAnchoredPanelPosition } from "./editor-layout.mjs";
import {
  hexToHsv,
  hexToRgb,
  hsvToHex,
  normalizeHexColor,
  rgbToHex,
} from "./editor-color.mjs";

export function createEditorColorController({
  root,
  getEditor,
  setEditor,
  getModelCapabilities,
  isInteractionLocked,
  renderer,
  render,
  clearStatus,
  discardInteraction,
  pushHistory,
  updateAnnotation = updateEditorAnnotation,
}) {
  let slot = null;
  let draft = null;
  let hue = null;
  let pointerId = null;
  let bindAbortController = null;

  const normalizedSlots = (value = getEditor().colorSlots) =>
    DEFAULT_ANNOTATION_COLOR_SLOTS.map(
      (fallback, index) => normalizeHexColor(value?.[index]) || fallback,
    );
  const normalizedSlot = (value) => {
    const number = Number(value);
    return Number.isInteger(number) &&
      number >= 0 &&
      number < DEFAULT_ANNOTATION_COLOR_SLOTS.length
      ? number
      : 0;
  };
  const refresh = () => {
    if (!renderer.isEditorMounted()) return;
    renderer.updateColorControls({
      editor: getEditor(),
      modelCapabilities: getModelCapabilities(),
      interactionLocked: isInteractionLocked(),
      colorEditorSlot: slot,
      colorEditorDraft: draft,
      colorEditorHue: hue,
    });
  };
  function position() {
    if (slot === null) return;
    const choice = root.querySelector(`[data-color-slot="${slot}"]`);
    const panel = root.querySelector("[data-custom-color-panel]");
    if (!choice || !panel || panel.hidden) return;
    const anchor = choice.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const result = computeAnchoredPanelPosition({
      anchor,
      panel: {
        width: panelRect.width || panel.offsetWidth || 260,
        height: panelRect.height || panel.offsetHeight || 320,
      },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    panel.style.left = `${result.left}px`;
    panel.style.top = `${result.top}px`;
    panel.style.setProperty("--color-panel-anchor-y", `${result.anchorY}px`);
    panel.dataset.placement = result.placement;
  }
  function setDraft(value, { draftHue = null } = {}) {
    const color = normalizeHexColor(value);
    if (!color) {
      updateFields(null, { invalidSource: "hex" });
      return;
    }
    draft = color;
    const hsv = hexToHsv(color);
    if (Number.isFinite(draftHue)) hue = ((draftHue % 360) + 360) % 360;
    else if (hsv?.saturation > 0) hue = hsv.hue;
    else if (hue === null) hue = hsv?.hue ?? 0;
    updateFields(color);
  }
  function open(nextSlot, { focusPanel = false } = {}) {
    slot = normalizedSlot(nextSlot);
    draft = normalizedSlots()[slot];
    hue = hexToHsv(draft)?.hue ?? 0;
    refresh();
    position();
    if (focusPanel) root.querySelector("[data-custom-color-area]")?.focus();
  }
  function close({ update = true, restoreFocus = false } = {}) {
    const focusSlot = slot;
    if (focusSlot === null && draft === null && hue === null) return;
    slot = null;
    draft = null;
    hue = null;
    pointerId = null;
    if (update) refresh();
    if (restoreFocus && focusSlot !== null)
      root.querySelector(`[data-color-slot="${focusSlot}"]`)?.focus();
  }
  function toggle(nextSlot, options = {}) {
    const normalized = normalizedSlot(nextSlot);
    if (slot === normalized) close({ restoreFocus: true });
    else open(normalized, options);
  }
  function choose(nextSlot, { colorSlots = null } = {}) {
    close({ update: false });
    const active = normalizedSlot(nextSlot);
    const colors = colorSlots ? normalizedSlots(colorSlots) : normalizedSlots();
    const color = colors[active];
    discardInteraction();
    const editor = getEditor();
    if (
      editor.annotations.find((item) => item.id === editor.selectedAnnotationId)
        ?.type === "mask"
    )
      return;
    if (
      editor.color !== color ||
      editor.activeColorSlot !== active ||
      !editor.colorSlots?.every((value, index) => value === colors[index])
    )
      setEditor({
        ...editor,
        color,
        colorSlots: colors,
        activeColorSlot: active,
      });
    clearStatus();
    render();
  }
  function applyToAnnotation(id) {
    const editor = getEditor();
    const selected = editor.annotations.find((item) => item.id === id);
    const color = normalizeHexColor(editor.color);
    if (
      !selected ||
      selected.type === "mask" ||
      !color ||
      selected.color === color
    )
      return;
    discardInteraction();
    const settledEditor = getEditor();
    pushHistory(settledEditor);
    setEditor(updateAnnotation(settledEditor, id, { color }));
    clearStatus();
    render();
  }
  function updateFromArea(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const saturation = clamp((event.clientX - rect.left) / rect.width);
    const value = 1 - clamp((event.clientY - rect.top) / rect.height);
    const currentHue = Number.isFinite(hue) ? hue : (hexToHsv(draft)?.hue ?? 0);
    const color = hsvToHex(currentHue, saturation, value);
    if (color) setDraft(color, { draftHue: currentHue });
  }
  function updateFields(color, { invalidSource = null } = {}) {
    const panel = root.querySelector("[data-custom-color-panel]");
    if (!panel) return;
    const apply = panel.querySelector("[data-custom-color-apply]");
    const reset = panel.querySelector("[data-custom-color-reset]");
    const validation = panel.querySelector("[data-custom-color-error]");
    reset.disabled =
      slot === null || color === DEFAULT_ANNOTATION_COLOR_SLOTS[slot];
    panel
      .querySelectorAll(
        "[data-custom-color-hex], [data-custom-color-red], [data-custom-color-green], [data-custom-color-blue]",
      )
      .forEach((field) => field.removeAttribute("aria-invalid"));
    if (!color) {
      apply.disabled = true;
      const selector =
        invalidSource === "rgb"
          ? "[data-custom-color-red], [data-custom-color-green], [data-custom-color-blue]"
          : "[data-custom-color-hex]";
      panel
        .querySelectorAll(selector)
        .forEach((field) => field.setAttribute("aria-invalid", "true"));
      if (validation) {
        validation.hidden = false;
        validation.textContent =
          invalidSource === "rgb"
            ? "RGB 数值需为 0–255"
            : "请输入完整的 #RRGGBB 色值";
      }
      return;
    }
    if (validation) {
      validation.hidden = true;
      validation.textContent = "";
    }
    const rgb = hexToRgb(color);
    const hsv = hexToHsv(color) || { hue: 0, saturation: 0, value: 0 };
    const currentHue = Number.isFinite(hue) ? hue : hsv.hue;
    const area = panel.querySelector("[data-custom-color-area]");
    area.style.setProperty("--picker-hue-color", `hsl(${currentHue} 100% 50%)`);
    area.style.setProperty("--picker-saturation", `${hsv.saturation * 100}%`);
    area.style.setProperty("--picker-value", `${(1 - hsv.value) * 100}%`);
    area.setAttribute("aria-valuenow", String(Math.round(hsv.value * 100)));
    area.setAttribute(
      "aria-valuetext",
      `饱和度 ${Math.round(hsv.saturation * 100)}%，明度 ${Math.round(hsv.value * 100)}%`,
    );
    panel.querySelector("[data-custom-color-hue]").value = String(
      Math.round(currentHue),
    );
    panel
      .querySelector("[data-custom-color-draft]")
      .style.setProperty("--preview-color", color);
    panel.querySelector("[data-custom-color-hex]").value = color.toUpperCase();
    panel.querySelector("[data-custom-color-red]").value = String(rgb.red);
    panel.querySelector("[data-custom-color-green]").value = String(rgb.green);
    panel.querySelector("[data-custom-color-blue]").value = String(rgb.blue);
    apply.disabled = false;
  }
  function apply() {
    const target = slot;
    const color = normalizeHexColor(draft);
    if (target === null || !color) return;
    const colors = normalizedSlots();
    colors[target] = color;
    const active = normalizedSlot(getEditor().activeColorSlot);
    close({ update: false });
    if (target === active) choose(target, { colorSlots: colors });
    else {
      setEditor({ ...getEditor(), colorSlots: colors });
      render();
    }
    root.querySelector(`[data-color-slot="${target}"]`)?.focus();
  }
  function bind() {
    bindAbortController?.abort();
    const bindingController = new window.AbortController();
    bindAbortController = bindingController;
    const listenerOptions = { signal: bindingController.signal };
    const panel = root.querySelector("[data-custom-color-panel]");
    const area = root.querySelector("[data-custom-color-area]");
    const hueControl = root.querySelector("[data-custom-color-hue]");
    root.querySelectorAll("[data-color-slot]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        choose(button.dataset.colorSlot);
      }, listenerOptions);
      button.addEventListener("keydown", handleSlotKeyDown, listenerOptions);
      button.addEventListener("contextmenu", (event) => {
        if (button.disabled) return;
        event.preventDefault();
        event.stopPropagation();
        toggle(button.dataset.colorSlot, { focusPanel: false });
      }, listenerOptions);
    });
    panel
      .querySelector("[data-custom-color-close]")
      .addEventListener("click", () => close({ restoreFocus: true }), listenerOptions);
    panel
      .querySelector("[data-custom-color-cancel]")
      .addEventListener("click", () => close({ restoreFocus: true }), listenerOptions);
    panel
      .querySelector("[data-custom-color-apply]")
      .addEventListener("click", apply, listenerOptions);
    panel
      .querySelector("[data-custom-color-reset]")
      .addEventListener("click", () => {
        if (slot !== null) setDraft(DEFAULT_ANNOTATION_COLOR_SLOTS[slot]);
      }, listenerOptions);
    area.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      pointerId = event.pointerId;
      area.setPointerCapture?.(event.pointerId);
      updateFromArea(event);
      event.preventDefault();
    }, listenerOptions);
    area.addEventListener("pointermove", (event) => {
      if (pointerId === event.pointerId) {
        updateFromArea(event);
        event.preventDefault();
      }
    }, listenerOptions);
    const finish = (event) => {
      if (pointerId !== event.pointerId) return;
      if (event.type === "lostpointercapture") {
        pointerId = null;
        return;
      }
      if (event.type !== "pointercancel") updateFromArea(event);
      area.releasePointerCapture?.(event.pointerId);
      pointerId = null;
      event.preventDefault();
    };
    area.addEventListener("pointerup", finish, listenerOptions);
    area.addEventListener("pointercancel", finish, listenerOptions);
    area.addEventListener("lostpointercapture", finish, listenerOptions);
    area.addEventListener("keydown", handleAreaKeyDown, listenerOptions);
    hueControl.addEventListener("input", (event) => {
      const hsv = hexToHsv(draft) || { saturation: 0, value: 0 };
      const color = hsvToHex(
        Number(event.target.value),
        hsv.saturation,
        hsv.value,
      );
      if (color) setDraft(color, { draftHue: Number(event.target.value) });
    }, listenerOptions);
    panel
      .querySelector("[data-custom-color-hex]")
      .addEventListener("input", (event) => {
        const color = normalizeHexColor(event.target.value);
        if (!color) {
          draft = null;
          updateFields(null, { invalidSource: "hex" });
        } else setDraft(color);
      }, listenerOptions);
    for (const channel of ["red", "green", "blue"])
      panel
        .querySelector(`[data-custom-color-${channel}]`)
        .addEventListener("input", () => {
          const color = rgbToHex(
            panel.querySelector("[data-custom-color-red]").value,
            panel.querySelector("[data-custom-color-green]").value,
            panel.querySelector("[data-custom-color-blue]").value,
          );
          if (!color) {
            draft = null;
            updateFields(null, { invalidSource: "rgb" });
          } else setDraft(color);
        }, listenerOptions);
    panel.addEventListener("keydown", (event) => {
      if (
        event.key === "Enter" &&
        event.target.matches("input") &&
        !panel.querySelector("[data-custom-color-apply]").disabled
      ) {
        event.preventDefault();
        apply();
      }
    }, listenerOptions);
    const rail = root.querySelector(".tool-rail");
    window.addEventListener("resize", position, listenerOptions);
    rail?.addEventListener("scroll", position, { passive: true, signal: bindingController.signal });
    return () => {
      bindingController.abort();
      if (bindAbortController === bindingController) bindAbortController = null;
    };
  }
  function handleSlotKeyDown(event) {
    const current = Number(event.currentTarget.dataset.colorSlot);
    if (
      (event.shiftKey && event.key === "F10") ||
      event.key === "ContextMenu"
    ) {
      event.preventDefault();
      toggle(current, { focusPanel: true });
      return;
    }
    const count = DEFAULT_ANNOTATION_COLOR_SLOTS.length;
    const target = {
      ArrowUp: (current - 1 + count) % count,
      ArrowLeft: (current - 1 + count) % count,
      ArrowDown: (current + 1) % count,
      ArrowRight: (current + 1) % count,
      Home: 0,
      End: count - 1,
    }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    choose(target);
    root.querySelector(`[data-color-slot="${target}"]`)?.focus();
  }
  function handleAreaKeyDown(event) {
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    )
      return;
    const hsv = hexToHsv(draft) || { hue: hue || 0, saturation: 0, value: 0 };
    const amount = event.shiftKey ? 0.1 : 0.01;
    const saturation = clamp(
      hsv.saturation +
        (event.key === "ArrowRight"
          ? amount
          : event.key === "ArrowLeft"
            ? -amount
            : 0),
    );
    const value = clamp(
      hsv.value +
        (event.key === "ArrowUp"
          ? amount
          : event.key === "ArrowDown"
            ? -amount
            : 0),
    );
    const color = hsvToHex(
      Number.isFinite(hue) ? hue : hsv.hue,
      saturation,
      value,
    );
    if (color) setDraft(color, { draftHue: hue });
    event.preventDefault();
  }
  return {
    bind,
    choose,
    toggle,
    close,
    applyToAnnotation,
    isOpen: () => slot !== null,
    position,
    handleSlotKeyDown,
    state: () => ({
      colorEditorSlot: slot,
      colorEditorDraft: draft,
      colorEditorHue: hue,
    }),
  };
}
function clamp(value) {
  return Math.min(1, Math.max(0, value));
}
