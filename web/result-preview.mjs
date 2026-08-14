import { FolderOpen, Maximize2, ZoomIn, ZoomOut, X, createIcons } from "lucide";

import { escapeHtml } from "./editor-annotation-view.mjs";
import { toImageUrl } from "./result-state.mjs";

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;
const SCALE_STEP = 0.25;
const PREVIEW_PADDING = 48;
const IMAGE_ID_PATTERN = /^img_[0-9A-HJKMNP-TV-Z]{26}$/;
const previewIcons = { FolderOpen, Maximize2, ZoomIn, ZoomOut, X };

export function createResultFileRevealController({ root, app, isActive = () => true, onBusyChange = () => {}, onFailure = () => {} }) {
  const inFlight = new Set();
  let contextMenu = null;
  let contextTrigger = null;
  let disposed = false;

  const reveal = async (imageId, { surface = "card" } = {}) => {
    if (!isMutable() || !IMAGE_ID_PATTERN.test(imageId) || inFlight.has(imageId)) return false;
    inFlight.add(imageId);
    onBusyChange(imageId, surface, true);
    clearRevealStatus(root, imageId, surface);
    setRevealBusy(root, imageId, surface, true);
    try {
      const result = await app.callServerTool({
        name: "reveal_image_artifact",
        arguments: { imageId },
      });
      if (
        result?.isError
        || result?.structuredContent?.status !== "revealed"
        || result.structuredContent.imageId !== imageId
      ) {
        throw new Error("artifact reveal request failed");
      }
      return true;
    } catch {
      onFailure(imageId, surface);
      if (isMutable()) setRevealStatus(root, imageId, surface, "无法在文件夹中显示图片", "error");
      return false;
    } finally {
      inFlight.delete(imageId);
      onBusyChange(imageId, surface, false);
      if (isMutable()) setRevealBusy(root, imageId, surface, false);
    }
  };

  const closeContextMenu = ({ restoreFocus = false } = {}) => {
    if (!contextMenu) return;
    contextMenu.remove();
    contextMenu = null;
    if (restoreFocus) contextTrigger?.focus({ preventScroll: true });
    contextTrigger = null;
  };

  const openContextMenu = ({ card, imageId, clientX, clientY, trigger }) => {
    if (!isMutable()) return;
    closeContextMenu();
    contextTrigger = trigger;
    contextMenu = document.createElement("div");
    contextMenu.className = "result-context-menu";
    contextMenu.dataset.resultContextMenu = "";
    contextMenu.setAttribute("role", "menu");
    contextMenu.setAttribute("aria-label", "图片操作");
    contextMenu.innerHTML = '<button data-action="reveal-result-image" type="button" role="menuitem"><i data-result-lucide="folder-open"></i><span>在文件夹中显示</span></button>';
    root.append(contextMenu);
    createIcons({
      icons: { FolderOpen },
      nameAttr: "data-result-lucide",
      attrs: { width: 16, height: 16, "stroke-width": 1.8, "aria-hidden": "true" },
    });
    const cardRect = card.getBoundingClientRect();
    const requestedX = clientX || cardRect.left + 12;
    const requestedY = clientY || cardRect.top + 12;
    const menuWidth = contextMenu.offsetWidth || 184;
    const menuHeight = contextMenu.offsetHeight || 42;
    contextMenu.style.left = `${Math.max(8, Math.min(requestedX, window.innerWidth - menuWidth - 8))}px`;
    contextMenu.style.top = `${Math.max(8, Math.min(requestedY, window.innerHeight - menuHeight - 8))}px`;
    const menuItem = contextMenu.querySelector("[data-action=reveal-result-image]");
    menuItem.addEventListener("click", (event) => {
      event.stopPropagation();
      closeContextMenu({ restoreFocus: true });
      void reveal(imageId, { surface: "card" });
    });
    menuItem.focus({ preventScroll: true });
  };

  const handleContextMenu = (event) => {
    if (!isMutable()) return;
    if (contextMenu?.contains(event.target)) return;
    const card = event.target?.closest?.("[data-result-image-id]");
    const imageId = card?.dataset.resultImageId || "";
    if (!card || !IMAGE_ID_PATTERN.test(imageId) || !card.querySelector("[data-action=preview-image]")) {
      closeContextMenu();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const trigger = event.target?.closest?.("button") || card.querySelector("[data-action=preview-image]");
    openContextMenu({ card, imageId, clientX: event.clientX, clientY: event.clientY, trigger });
  };
  const handleDocumentPointerDown = (event) => {
    if (contextMenu && !contextMenu.contains(event.target)) closeContextMenu();
  };
  const handleDocumentKeyDown = (event) => {
    if (event.key !== "Escape" || !contextMenu) return;
    event.preventDefault();
    closeContextMenu({ restoreFocus: true });
  };
  const handleWindowResize = () => closeContextMenu();
  const handleWindowScroll = () => closeContextMenu();
  root.addEventListener("contextmenu", handleContextMenu);
  document.addEventListener("pointerdown", handleDocumentPointerDown, true);
  document.addEventListener("keydown", handleDocumentKeyDown);
  window.addEventListener("resize", handleWindowResize);
  window.addEventListener("scroll", handleWindowScroll, true);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    closeContextMenu();
    root.removeEventListener("contextmenu", handleContextMenu);
    document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
    document.removeEventListener("keydown", handleDocumentKeyDown);
    window.removeEventListener("resize", handleWindowResize);
    window.removeEventListener("scroll", handleWindowScroll, true);
  };

  const isMutable = () => !disposed && isActive();

  return { reveal, isInFlight: (imageId) => inFlight.has(imageId), closeContextMenu, dispose };
}

export function createResultPreviewSession({ root, app, getState, onReveal, onSessionEnd = () => {}, isActive = () => true }) {
  let activeImageId = "";
  let transition = "";
  let closeAfterOpen = false;
  let cleanupControls = null;
  let fullscreenObserved = false;
  // A close can produce more than one delayed inline notification. Keep this
  // session barrier until a fresh fullscreen host state proves that a reopened
  // preview owns the current display transition.
  let awaitingFreshFullscreenHostState = false;
  let fullscreenObservedDuringOpen = false;
  let operationToken = 0;
  let disposed = false;

  const open = async (imageId) => {
    if (!isMutable() || !imageId || activeImageId || transition) return false;
    const state = getState();
    const candidate = state.candidates.find((item) => item.id === imageId);
    if (!state.hostReady || !candidate || !toImageUrl(candidate)) {
      reportCardError(imageId, "当前图片尚未准备好");
      return false;
    }
    if (!state.availableDisplayModes.includes("fullscreen")) {
      reportCardError(imageId, "当前 Codex App 不支持全屏图片预览");
      return false;
    }

    const operation = ++operationToken;
    activeImageId = imageId;
    transition = "opening";
    fullscreenObserved = false;
    fullscreenObservedDuringOpen = false;
    reconcile();
    try {
      const result = await app.requestDisplayMode({ mode: "fullscreen" });
      if (!isCurrent(operation, imageId)) return false;
      if (result.mode !== "fullscreen") throw new Error("preview display mode mismatch");
      if (awaitingFreshFullscreenHostState && fullscreenObservedDuringOpen) {
        awaitingFreshFullscreenHostState = false;
      }
      fullscreenObservedDuringOpen = false;
      fullscreenObserved = true;
      transition = "";
      if (closeAfterOpen) {
        closeAfterOpen = false;
        return close();
      }
      reconcile();
      restorePreviewFocus();
      return true;
    } catch (error) {
      if (!isCurrent(operation, imageId)) return false;
      endSession(imageId, "Codex 未能打开图片预览");
      return false;
    }
  };

  const close = async () => {
    if (!isMutable()) return false;
    if (!activeImageId) return true;
    if (transition === "opening") {
      closeAfterOpen = true;
      return false;
    }
    if (transition) return false;
    const imageId = activeImageId;
    const state = getState();
    if (!state.availableDisplayModes.includes("inline")) {
      reportPreviewError("当前 Codex App 不支持返回结果卡");
      return false;
    }

    const operation = ++operationToken;
    transition = "closing";
    markPreviewBusy(true);
    try {
      const result = await app.requestDisplayMode({ mode: "inline" });
      if (!isCurrent(operation, imageId)) return true;
      if (result.mode !== "inline") throw new Error("preview return mode mismatch");
      awaitingFreshFullscreenHostState = true;
      endSession(imageId);
      return true;
    } catch (error) {
      if (!isCurrent(operation, imageId)) return true;
      transition = "";
      markPreviewBusy(false);
      reportPreviewError("Codex 未能关闭图片预览");
      return false;
    }
  };

  function reconcile() {
    if (!isMutable()) return;
    const results = root.querySelector(".inline-results");
    const state = getState();
    const candidate = state.candidates.find((item) => item.id === activeImageId);
    const imageUrl = candidate ? toImageUrl(candidate) : "";
    document.body.dataset.previewOpen = String(Boolean(candidate && imageUrl));
    if (!candidate || !imageUrl) {
      cleanupControls?.();
      cleanupControls = null;
      root.querySelector("[data-result-preview]")?.remove();
      if (results) {
        results.inert = false;
        results.removeAttribute("aria-hidden");
      }
      return;
    }

    let preview = root.querySelector("[data-result-preview]");
    if (!preview || preview.dataset.imageId !== activeImageId) {
      cleanupControls?.();
      cleanupControls = null;
      preview?.remove();
      root.insertAdjacentHTML("beforeend", previewMarkup(candidate, imageUrl));
      renderPreviewIcons();
      cleanupControls = bindPreviewControls({
        root,
        onClose: close,
        onReveal,
        isActive: () => isMutable() && activeImageId === candidate.id,
      });
      preview = root.querySelector("[data-result-preview]");
    }
    if (results) {
      results.inert = true;
      results.setAttribute("aria-hidden", "true");
    }
    markPreviewBusy(transition === "closing");
  }

  function syncHostContext(displayMode) {
    if (!isMutable()) return false;
    if (!activeImageId) return false;
    if (awaitingFreshFullscreenHostState && transition === "opening") {
      if (displayMode === "fullscreen") fullscreenObservedDuringOpen = true;
      if (displayMode === "inline") fullscreenObservedDuringOpen = false;
      reconcile();
      return true;
    }
    if (displayMode === "fullscreen") {
      awaitingFreshFullscreenHostState = false;
      fullscreenObserved = true;
      reconcile();
      restorePreviewFocus();
      return true;
    }
    if (displayMode === "inline" && awaitingFreshFullscreenHostState) {
      reconcile();
      return true;
    }
    if (displayMode === "inline" && (transition === "opening" || transition === "closing" || fullscreenObserved)) {
      endSession(activeImageId);
      return true;
    }
    reconcile();
    return true;
  }

  function endSession(imageId, cardError = "") {
    if (!isMutable()) return false;
    operationToken += 1;
    activeImageId = "";
    transition = "";
    closeAfterOpen = false;
    fullscreenObserved = false;
    fullscreenObservedDuringOpen = false;
    reconcile();
    onSessionEnd();
    if (cardError) reportCardError(imageId, cardError);
    restoreTriggerFocus(imageId);
  }

  function isCurrent(operation, imageId) {
    return isMutable() && operationToken === operation && activeImageId === imageId;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    operationToken += 1;
    cleanupControls?.();
    cleanupControls = null;
  }

  function isMutable() {
    return !disposed && isActive();
  }

  function reportCardError(imageId, message) {
    const card = [...root.querySelectorAll("[data-result-image-id]")]
      .find((item) => item.dataset.resultImageId === imageId);
    const status = card?.querySelector("[data-inline-status]");
    if (!status) return;
    status.textContent = message;
    status.dataset.statusTone = "error";
  }

  function reportPreviewError(message) {
    const status = root.querySelector("[data-preview-status]");
    if (status) status.textContent = message;
  }

  function markPreviewBusy(busy) {
    const preview = root.querySelector("[data-result-preview]");
    if (!preview) return;
    preview.dataset.previewBusy = String(busy);
    preview.querySelectorAll("[data-preview-action]").forEach((button) => {
      button.disabled = busy;
    });
  }

  function restoreTriggerFocus(imageId) {
    window.requestAnimationFrame(() => {
      if (!isMutable()) return;
      const trigger = [...root.querySelectorAll("[data-action=preview-image]")]
        .find((item) => item.dataset.previewImageId === imageId);
      trigger?.focus();
    });
  }

  function restorePreviewFocus() {
    const imageId = activeImageId;
    if (!imageId) return;
    window.requestAnimationFrame(() => {
      if (!isMutable()) return;
      if (activeImageId !== imageId) return;
      const preview = root.querySelector("[data-result-preview]");
      if (!preview || preview.dataset.imageId !== imageId) return;
      if (!preview.contains(document.activeElement)) {
        preview.querySelector("[data-preview-action=close]")?.focus({ preventScroll: true });
      }
    });
  }

  return { open, close, reconcile, syncHostContext, dispose, isActive: () => isMutable() && Boolean(activeImageId) };
}

function previewMarkup(candidate, imageUrl) {
  const imageId = escapeHtml(candidate.id || "");
  const imageName = escapeHtml(candidate.name || `图片 ${candidate.id.slice(-6)}`);
  const width = Math.max(1, Number(candidate.width) || 1);
  const height = Math.max(1, Number(candidate.height) || 1);
  return `<section class="result-preview" id="result-image-preview" data-result-preview data-image-id="${imageId}" data-image-width="${width}" data-image-height="${height}" data-preview-scale="1" role="dialog" aria-modal="true" aria-labelledby="result-preview-title">
    <header class="result-preview-toolbar">
      <div class="result-preview-identity"><strong id="result-preview-title">${imageName}</strong><span>${imageId}</span></div>
      <span class="result-preview-status" data-preview-status role="status" aria-live="polite"></span>
      <div class="result-preview-controls" role="group" aria-label="图片预览缩放">
        <button class="result-preview-icon" data-preview-action="zoom-out" type="button" aria-label="缩小" title="缩小 (-)"><i data-lucide="zoom-out"></i></button>
        <button class="result-preview-scale" data-preview-action="reset" type="button" aria-label="适应窗口" title="适应窗口 (0)">100%</button>
        <button class="result-preview-icon" data-preview-action="zoom-in" type="button" aria-label="放大" title="放大 (+)"><i data-lucide="zoom-in"></i></button>
        <button class="result-preview-icon result-preview-fit" data-preview-action="reset" type="button" aria-label="适应窗口" title="适应窗口"><i data-lucide="maximize-2"></i></button>
        <button class="result-preview-icon" data-preview-action="reveal" type="button" aria-label="在文件夹中显示" title="在文件夹中显示"><i data-lucide="folder-open"></i></button>
        <span class="result-preview-rule" aria-hidden="true"></span>
        <button class="result-preview-icon" data-preview-action="close" type="button" aria-label="关闭图片预览" title="关闭图片预览"><i data-lucide="x"></i></button>
      </div>
    </header>
    <div class="result-preview-viewport" data-preview-viewport data-can-pan="false">
      <div class="result-preview-stage" data-preview-stage>
        <img class="result-preview-image" data-preview-image src="${imageUrl}" alt="${imageName}" draggable="false">
      </div>
    </div>
  </section>`;
}

function bindPreviewControls({ root, onClose, onReveal, isActive = () => true }) {
  const preview = root.querySelector("[data-result-preview]");
  const viewport = preview.querySelector("[data-preview-viewport]");
  const stage = preview.querySelector("[data-preview-stage]");
  const image = preview.querySelector("[data-preview-image]");
  const sourceWidth = Math.max(1, Number(preview.dataset.imageWidth) || 1);
  const sourceHeight = Math.max(1, Number(preview.dataset.imageHeight) || 1);
  let scale = 1;
  let fitWidth = sourceWidth;
  let fitHeight = sourceHeight;
  let drag = null;
  let suppressBackdropClick = false;

  const applyScale = (nextScale, anchor = null) => {
    const previousWidth = Number.parseFloat(stage.style.width) || viewport.clientWidth || window.innerWidth;
    const previousHeight = Number.parseFloat(stage.style.height) || viewport.clientHeight || window.innerHeight;
    const anchorX = anchor?.x ?? (viewport.clientWidth / 2);
    const anchorY = anchor?.y ?? (viewport.clientHeight / 2);
    const contentX = viewport.scrollLeft + anchorX;
    const contentY = viewport.scrollTop + anchorY;
    scale = clamp(Math.round(nextScale / SCALE_STEP) * SCALE_STEP, MIN_SCALE, MAX_SCALE);
    updateLayout();
    const nextWidth = Number.parseFloat(stage.style.width) || previousWidth;
    const nextHeight = Number.parseFloat(stage.style.height) || previousHeight;
    viewport.scrollLeft = (contentX / previousWidth) * nextWidth - anchorX;
    viewport.scrollTop = (contentY / previousHeight) * nextHeight - anchorY;
  };

  const updateFit = () => {
    const availableWidth = Math.max(1, viewport.clientWidth || window.innerWidth || sourceWidth);
    const availableHeight = Math.max(1, viewport.clientHeight || window.innerHeight || sourceHeight);
    const fit = Math.max(0.01, Math.min(
      Math.max(1, availableWidth - PREVIEW_PADDING) / sourceWidth,
      Math.max(1, availableHeight - PREVIEW_PADDING) / sourceHeight,
    ));
    fitWidth = sourceWidth * fit;
    fitHeight = sourceHeight * fit;
    updateLayout();
  };

  const updateLayout = () => {
    const viewportWidth = Math.max(1, viewport.clientWidth || window.innerWidth || fitWidth);
    const viewportHeight = Math.max(1, viewport.clientHeight || window.innerHeight || fitHeight);
    const imageWidth = fitWidth * scale;
    const imageHeight = fitHeight * scale;
    image.style.width = `${imageWidth}px`;
    image.style.height = `${imageHeight}px`;
    stage.style.width = `${Math.max(viewportWidth, imageWidth + PREVIEW_PADDING)}px`;
    stage.style.height = `${Math.max(viewportHeight, imageHeight + PREVIEW_PADDING)}px`;
    preview.dataset.previewScale = formatScale(scale);
    viewport.dataset.canPan = String(scale > 1);
    preview.querySelector("[data-preview-action=zoom-out]").disabled = scale <= MIN_SCALE;
    preview.querySelector("[data-preview-action=zoom-in]").disabled = scale >= MAX_SCALE;
    preview.querySelector(".result-preview-scale").textContent = `${Math.round(scale * 100)}%`;
  };

  const handleAction = (event) => {
    const action = event.currentTarget.dataset.previewAction;
    if (action === "zoom-in") applyScale(scale + SCALE_STEP);
    else if (action === "zoom-out") applyScale(scale - SCALE_STEP);
    else if (action === "reset") applyScale(1);
    else if (action === "reveal") void onReveal(preview.dataset.imageId, { surface: "preview" });
    else if (action === "close") void onClose();
  };

  const handleWheel = (event) => {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    applyScale(scale + (event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP), {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  const handleKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void onClose();
      return;
    }
    if (["+", "="].includes(event.key)) applyScale(scale + SCALE_STEP);
    else if (event.key === "-") applyScale(scale - SCALE_STEP);
    else if (event.key === "0") applyScale(1);
    else if (event.key === "Tab") {
      const controls = [...preview.querySelectorAll("button:not(:disabled)")];
      if (!controls.length) return;
      const currentIndex = controls.indexOf(document.activeElement);
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? controls.length - 1 : currentIndex - 1)
        : (currentIndex === controls.length - 1 ? 0 : currentIndex + 1);
      controls[nextIndex].focus();
      event.preventDefault();
      return;
    } else return;
    event.preventDefault();
  };

  const beginPan = (event) => {
    suppressBackdropClick = false;
    if (event.button !== 0 || scale <= 1 || event.target !== image) return;
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop, moved: false, captured: false };
  };

  const continuePan = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(deltaX, deltaY) > 3) {
      drag.moved = true;
      if (viewport.setPointerCapture) {
        viewport.setPointerCapture(event.pointerId);
        drag.captured = true;
      }
      preview.dataset.panning = "true";
    }
    if (!drag.moved) return;
    event.preventDefault();
    viewport.scrollLeft = drag.scrollLeft - deltaX;
    viewport.scrollTop = drag.scrollTop - deltaY;
  };

  const finishPan = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    suppressBackdropClick = drag.moved;
    if (drag.captured) viewport.releasePointerCapture?.(event.pointerId);
    drag = null;
    preview.dataset.panning = "false";
  };

  const handleBackdropClick = (event) => {
    if (suppressBackdropClick) {
      suppressBackdropClick = false;
      return;
    }
    if (event.target === viewport || event.target === stage) void onClose();
  };

  const handleDoubleClick = (event) => {
    event.preventDefault();
    applyScale(scale === 1 ? 2 : 1);
  };

  const actionButtons = [...preview.querySelectorAll("[data-preview-action]")];
  actionButtons.forEach((button) => button.addEventListener("click", handleAction));
  viewport.addEventListener("wheel", handleWheel, { passive: false });
  viewport.addEventListener("pointerdown", beginPan);
  viewport.addEventListener("pointermove", continuePan);
  viewport.addEventListener("pointerup", finishPan);
  viewport.addEventListener("pointercancel", finishPan);
  viewport.addEventListener("click", handleBackdropClick);
  image.addEventListener("dblclick", handleDoubleClick);
  document.addEventListener("keydown", handleKeyDown);
  window.addEventListener("resize", updateFit);
  updateFit();
  queueMicrotask(() => {
    if (isActive()) preview.querySelector("[data-preview-action=close]")?.focus();
  });

  return () => {
    actionButtons.forEach((button) => button.removeEventListener("click", handleAction));
    document.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("resize", updateFit);
    viewport.removeEventListener("wheel", handleWheel);
    viewport.removeEventListener("pointerdown", beginPan);
    viewport.removeEventListener("pointermove", continuePan);
    viewport.removeEventListener("pointerup", finishPan);
    viewport.removeEventListener("pointercancel", finishPan);
    viewport.removeEventListener("click", handleBackdropClick);
    image.removeEventListener("dblclick", handleDoubleClick);
  };
}

function renderPreviewIcons() {
  createIcons({
    icons: previewIcons,
    attrs: { width: 18, height: 18, "stroke-width": 1.8, "aria-hidden": "true" },
  });
}

function setRevealBusy(root, imageId, surface, busy) {
  if (surface !== "preview") return;
  const preview = root.querySelector("[data-result-preview]");
  if (preview?.dataset.imageId === imageId) {
    const button = preview.querySelector("[data-preview-action=reveal]");
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
  }
}

function clearRevealStatus(root, imageId, surface) {
  const status = findRevealStatus(root, imageId, surface);
  if (!status || status.dataset.statusSource !== "reveal") return;
  status.textContent = "";
  delete status.dataset.statusTone;
  delete status.dataset.statusSource;
}

function setRevealStatus(root, imageId, surface, message, tone) {
  const status = findRevealStatus(root, imageId, surface);
  if (!status) return;
  status.textContent = message;
  status.dataset.statusTone = tone;
  status.dataset.statusSource = "reveal";
}

function findRevealStatus(root, imageId, surface) {
  return surface === "preview"
    ? root.querySelector(`[data-result-preview][data-image-id="${imageId}"] [data-preview-status]`)
    : [...root.querySelectorAll("[data-result-image-id]")]
      .find((card) => card.dataset.resultImageId === imageId)
      ?.querySelector("[data-inline-status]");
}

function formatScale(scale) {
  return String(Number(scale.toFixed(2)));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
