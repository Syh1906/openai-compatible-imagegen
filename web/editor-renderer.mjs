import {
  ArrowUpRight,
  Brush,
  Check,
  ChevronLeft,
  Eraser,
  Eye,
  EyeOff,
  FolderOpen,
  Maximize2,
  MousePointer2,
  PanelRight,
  Paintbrush,
  Pencil,
  Redo2,
  RotateCcw,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
  ZoomIn,
  createIcons,
} from "lucide";

import { annotationLayerMarkup, annotationViewBox, escapeHtml, isUserFacingAnnotation, labelFor } from "./editor-annotation-view.mjs";
import { hexToHsv, hexToRgb, normalizeHexColor } from "./editor-color.mjs";
import { computeCanvasGeometry } from "./editor-layout.mjs";
import { DEFAULT_ANNOTATION_COLOR_SLOTS, hasMaskPaintStroke } from "./editor-state.mjs";


const toolDefinitions = [
  ["select", "mouse-pointer-2", "选择"],
  ["pen", "pencil", "画笔"],
  ["arrow", "arrow-up-right", "箭头"],
  ["rectangle", "square", "矩形"],
  ["text", "type", "文字"],
  ["eraser", "eraser", "擦除"],
  ["mask", "brush", "蒙版笔刷"],
];
const lucideIcons = { ArrowUpRight, Brush, Check, ChevronLeft, Eraser, Eye, EyeOff, FolderOpen, Maximize2, MousePointer2, PanelRight, Paintbrush, Pencil, Redo2, RotateCcw, Square, Trash2, Type, Undo2, X, ZoomIn };

function foregroundColorControlsMarkup() {
  return `<div class="foreground-color-group" role="radiogroup" aria-label="前景色">${DEFAULT_ANNOTATION_COLOR_SLOTS.map((color, index) => `<button class="swatch color-slot${index === 0 ? " active" : ""}" data-color-slot="${index}" data-color="${color}" type="button" role="radio" aria-checked="${index === 0}" aria-label="颜色 ${index + 1} ${color.toUpperCase()}" aria-description="左键选择；右键编辑" aria-keyshortcuts="Shift+F10" aria-controls="custom-color-panel" aria-expanded="false" tabindex="${index === 0 ? "0" : "-1"}" title="颜色 ${index + 1} ${color.toUpperCase()}：左键选择，右键编辑" style="--swatch:${color}"><i class="swatch-check" data-lucide="check" aria-hidden="true"></i><i class="swatch-edit-affordance" data-lucide="pencil" aria-hidden="true"></i></button>`).join("")}<button class="text-icon color-edit-button" data-action="edit-active-color" type="button" aria-label="编辑当前颜色" title="编辑当前颜色"><i data-lucide="pencil"></i></button></div>`;
}

function colorEditorMarkup() {
  return `<div class="color-editor-overlay" data-color-editor-overlay>
    <section class="custom-color-panel" id="custom-color-panel" data-custom-color-panel data-placement="right" role="dialog" aria-labelledby="custom-color-panel-title" hidden>
      <div class="custom-color-panel-heading"><strong id="custom-color-panel-title" data-custom-color-panel-title>编辑颜色 1</strong><button class="quiet-button" data-custom-color-close type="button" aria-label="关闭颜色面板" title="关闭"><i data-lucide="x"></i></button></div>
      <div class="custom-color-panel-body">
        <div class="custom-color-area" data-custom-color-area role="slider" tabindex="0" aria-label="饱和度和明度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="饱和度 0%，明度 0%"><span class="custom-color-area-marker" aria-hidden="true"></span></div>
        <label class="custom-color-hue-label"><span class="sr-only">色相</span><input class="custom-color-hue" data-custom-color-hue type="range" min="0" max="359" step="1" value="0" aria-label="色相"></label>
        <div class="custom-color-previews" aria-label="颜色对比"><div><span class="custom-color-preview" data-custom-color-current></span><span>当前</span></div><div><span class="custom-color-preview" data-custom-color-draft></span><span>新颜色</span></div></div>
        <label class="color-field color-field-hex"><span>HEX</span><input data-custom-color-hex type="text" value="#000000" maxlength="7" spellcheck="false" aria-label="HEX 颜色值"></label>
        <div class="custom-color-rgb"><label class="color-field"><span>R</span><input data-custom-color-red type="number" min="0" max="255" inputmode="numeric" aria-label="红色通道"></label><label class="color-field"><span>G</span><input data-custom-color-green type="number" min="0" max="255" inputmode="numeric" aria-label="绿色通道"></label><label class="color-field"><span>B</span><input data-custom-color-blue type="number" min="0" max="255" inputmode="numeric" aria-label="蓝色通道"></label></div>
        <p class="color-validation" data-custom-color-error role="status" hidden></p>
      </div>
      <div class="custom-color-panel-actions"><button class="quiet-button color-reset-button" data-custom-color-reset type="button" aria-label="恢复颜色 1 为默认色 #EF4444" title="恢复颜色 1 为默认色 #EF4444"><i data-lucide="rotate-ccw"></i><span>恢复默认</span></button><button class="quiet-button" data-custom-color-cancel type="button">取消</button><button class="color-apply-button" data-custom-color-apply type="button">应用</button></div>
    </section>
  </div>`;
}
export function createEditorRenderer(root) {
  let lastSelectedAnnotationId = null;
  return {
    isEditorMounted() {
      return Boolean(root.querySelector(".editor-app"));
    },

    renderInline({ candidates, openingImageId, inlineStatus, inlineStatusTone, inlineStatusImageId, onOpen, onPreview, signal }) {
      const items = candidates?.length ? candidates : [{ id: "", imageUrl: "" }];
      root.onclick = null;
      root.innerHTML = `<section class="inline-results ${items.length > 1 ? "multiple" : ""}" aria-label="会话图片结果">${items.map((candidate, index) => {
        const hasImage = Boolean(candidate.id && candidate.imageUrl);
        const opening = openingImageId === candidate.id;
        const canvasDestroyed = candidate.canvasStatus === "destroyed";
        const draftKind = candidate.draftState?.kind || "empty";
        const draftLabel = { editing: "未提交", writing: "写入中", pending: "待发送", updated: "有更新" }[draftKind] || "";
        return `
          <article class="inline-result" data-result-image-id="${escapeHtml(candidate.id || "")}" data-canvas-status="${canvasDestroyed ? "destroyed" : "available"}">
            <div class="inline-preview">
              ${hasImage ? `<button class="inline-preview-trigger" data-action="preview-image" data-preview-image-id="${escapeHtml(candidate.id)}" type="button" aria-label="放大预览候选图片 ${index + 1}" aria-haspopup="dialog" aria-controls="result-image-preview" title="放大预览"><img class="source-image" data-image src="${candidate.imageUrl}" alt="候选图片 ${index + 1}" draggable="false"><span class="inline-preview-affordance" aria-hidden="true"><i data-lucide="zoom-in"></i></span></button>` : `<div class="${candidate.loadError ? "inline-error" : "inline-loading"}">${candidate.loadError ? "图片读取失败" : candidate.id ? "正在读取图片..." : "正在等待会话图片..."}</div>`}
            </div>
            <div class="inline-details">
              <div class="inline-copy"><span class="eyebrow">${items.length > 1 ? `候选 ${index + 1}` : "图片结果"}</span><strong>${hasImage ? (candidate.name || `图片 ${candidate.id.slice(-6)}`) : candidate.loadError ? "无法显示图片" : "准备画布"}</strong><span data-image-id>${candidate.id || "尚未绑定图片"}</span></div>${draftLabel ? `<span class="inline-draft-state" data-draft-state="${draftKind}">${draftLabel}</span>` : ""}
              ${canvasDestroyed
                ? '<span class="canvas-destroyed-status" role="status">画布已销毁</span>'
                : `<button class="open-editor-button" data-action="open-editor" data-image-id="${escapeHtml(candidate.id || "")}" ${hasImage && !openingImageId ? "" : "disabled"}>${opening ? "正在打开..." : draftLabel ? "继续编辑" : "打开画布"}</button>`}
              <p class="inline-status" data-inline-status data-status-tone="${candidate.loadError ? "error" : inlineStatusTone}" role="status" aria-live="polite">${candidate.loadError ? escapeHtml(candidate.loadError) : opening || candidate.id === inlineStatusImageId || items.length === 1 ? inlineStatus : ""}</p>
            </div>
          </article>`;
      }).join("")}</section>`;
      renderIcons();
      root.querySelectorAll("[data-action=open-editor]").forEach((button) => {
        button.addEventListener("click", () => onOpen(button.dataset.imageId), { signal });
      });
      root.querySelectorAll("[data-action=preview-image]").forEach((button) => {
        button.addEventListener("click", () => onPreview?.(button.dataset.previewImageId), { signal });
      });
    },

    mountEditor() {
      root.innerHTML = `
        <section class="editor-app" aria-label="聚焦图片编辑器">
          <header class="topbar">
            <div class="identity"><button class="return-button" data-action="back" aria-label="返回会话" title="返回会话"><i data-lucide="chevron-left"></i><span>返回会话</span></button><div><strong data-image-name>等待图片</strong><span data-image-id>未绑定图片</span></div></div>
            <div class="lineage-crumb" data-lineage-crumb>当前图片</div>
            <div class="top-actions"><span class="close-guidance-wrap" data-close-guidance-wrap data-open="false"><button class="close-guidance" data-close-guidance type="button" aria-label="关闭画布说明" aria-controls="close-guidance-description" aria-describedby="close-guidance-description" aria-expanded="false"><span class="close-guidance-mark" aria-hidden="true">i</span><span class="close-guidance-text">返回会话可保留画布</span></button><span class="close-guidance-tooltip" data-close-guidance-tooltip id="close-guidance-description" role="tooltip" aria-hidden="true">使用“返回会话”会保留当前画布和未发送修改；直接关闭 Codex 画布可能移除入口。</span></span><button class="text-icon" data-action="undo" aria-label="撤销" aria-keyshortcuts="Control+Z Meta+Z" title="撤销 (Ctrl+Z)"><i data-lucide="undo-2"></i></button><button class="text-icon" data-action="redo" aria-label="重做" aria-keyshortcuts="Control+Y Control+Shift+Z Meta+Shift+Z" title="重做 (Ctrl+Y)"><i data-lucide="redo-2"></i></button><label class="zoom-control"><select data-zoom-select aria-label="缩放"><option value="0.75">75%</option><option value="1" selected>100%</option><option value="1.25">125%</option><option value="1.5">150%</option></select></label><button class="text-icon" data-action="fit" aria-label="适应窗口" title="适应窗口"><i data-lucide="maximize-2"></i></button><button class="text-icon" data-action="reveal-image" aria-label="在文件夹中显示" title="在文件夹中显示" aria-busy="false"><i data-lucide="folder-open"></i></button><button class="text-icon" data-action="toggle-annotations" aria-label="隐藏标注" title="隐藏标注" aria-pressed="true"><span data-visible-icon><i data-lucide="eye"></i></span><span data-hidden-icon hidden><i data-lucide="eye-off"></i></span></button><button class="intent-panel-toggle" data-action="toggle-intents" type="button" aria-label="修改意图" title="修改意图" aria-controls="intent-panel" aria-expanded="false"><i data-lucide="panel-right"></i><span>修改意图</span></button><button class="destroy-button" data-action="destroy" type="button" aria-label="销毁画布" title="销毁画布" aria-haspopup="dialog" aria-controls="destroy-confirm-dialog"><i data-lucide="trash-2"></i><span>销毁画布</span></button></div>
          </header>
          <div class="workspace">
            <aside class="tool-rail" aria-label="标注工具">${toolDefinitions.map(([tool, icon, label]) => `<button class="tool-button" data-tool="${tool}" aria-label="${label}" title="${label}" aria-pressed="false" ${tool === "mask" ? "hidden" : ""}><i data-lucide="${icon}"></i></button>`).join("")}<div class="rail-style-controls" data-standard-style><span class="rail-rule"></span>${foregroundColorControlsMarkup()}<button class="stroke-button" data-stroke="3" aria-label="细线" title="细线" aria-pressed="false">—</button><button class="stroke-button active" data-stroke="5" aria-label="中线" title="中线" aria-pressed="true">━</button></div></aside>
            <section class="canvas-zone"><div class="canvas-options" data-mask-options hidden><span class="canvas-options-label">下一笔</span><div class="segmented-control mask-actions" role="group" aria-label="下一笔蒙版操作"><button data-mask-operation="paint" aria-label="绘制蒙版" title="绘制蒙版" aria-pressed="true"><i data-lucide="paintbrush"></i></button><button data-mask-operation="erase" aria-label="局部擦除蒙版" title="局部擦除蒙版" aria-pressed="false"><i data-lucide="eraser"></i></button><span class="sr-only" id="mask-erase-hint" data-mask-erase-hint role="status" aria-live="polite"></span></div><span class="canvas-options-rule" aria-hidden="true"></span><div class="segmented-control mask-modes" role="group" aria-label="下一笔蒙版模式"><button data-mask-mode="edit" aria-pressed="true" title="下一笔只允许模型修改该区域">改图区域</button><button data-mask-mode="protect" aria-pressed="false" title="下一笔标记要保留的内容；光影可随整体自然适配">保护内容</button></div><span class="canvas-options-rule" aria-hidden="true"></span><div class="segmented-control brush-sizes" role="group" aria-label="下一笔蒙版笔刷大小"><button data-mask-radius="0.02" aria-label="小号蒙版笔刷" title="下一笔使用小号笔刷" aria-pressed="false">小</button><button data-mask-radius="0.035" aria-label="中号蒙版笔刷" title="下一笔使用中号笔刷" aria-pressed="true">中</button><button data-mask-radius="0.06" aria-label="大号蒙版笔刷" title="下一笔使用大号笔刷" aria-pressed="false">大</button></div></div><span class="sr-only" id="canvas-keyboard-hint">选择工具后将焦点移到画布。画笔、箭头、矩形和蒙版按空格开始，方向键绘制，Enter 完成；文字按 Enter 创建；选中标注后方向键移动。</span><div class="canvas-frame"><div class="canvas-content" data-canvas tabindex="0" aria-label="图片标注画布" aria-describedby="canvas-keyboard-hint"><div class="empty-state" data-empty>正在等待会话图片...</div><img class="source-image" data-image alt="当前图片" draggable="false" hidden><svg class="annotation-layer" data-layer viewBox="0 0 1000 1000" preserveAspectRatio="none" hidden></svg></div></div></section>
            <aside class="intent-panel" id="intent-panel" data-intent-panel><div class="panel-heading"><div><span class="eyebrow">本次修改</span><h1 data-intent-count>尚未标注</h1></div><div class="panel-heading-actions"><button class="quiet-button panel-close" data-action="toggle-intents" aria-label="关闭修改意图面板" title="关闭"><i data-lucide="x"></i></button><button class="quiet-button" data-action="clear" type="button" aria-label="清除当前工作草稿" title="清除当前工作草稿" aria-haspopup="dialog" aria-controls="clear-confirm-dialog">清除草稿</button></div></div><div class="intent-list" data-intents><p class="muted">在图片上标出要处理的位置。</p></div><label class="prompt-label" for="prompt">补充要求</label><textarea id="prompt" data-prompt maxlength="600" placeholder="例如：保持整体风格一致，避免改变主体比例"></textarea><div class="prompt-meta"><span>可选</span><span data-prompt-count>0/600</span></div></aside>
          </div>
          <footer class="bottom-bar"><div class="version-strip" data-lineage></div><div class="submit-row"><div class="submit-copy"><span class="annotation-summary" data-summary>已标注 0 处</span><span class="submit-status" data-submit-status data-destroyed-terminal="false" role="status" aria-live="polite"></span></div><button class="submit-button" data-action="submit" type="button" disabled>提交修改</button></div></footer>
          <div class="toast" data-toast role="status" aria-live="polite"></div>
          ${colorEditorMarkup()}
          <div class="confirm-backdrop" data-destroy-confirm hidden><section class="confirm-dialog" id="destroy-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="destroy-title" aria-describedby="destroy-description"><h2 id="destroy-title">销毁当前画布？</h2><p id="destroy-description">图片和已保存版本会保留；当前画布草稿与入口将被移除。</p><div class="confirm-actions"><button class="quiet-button" data-action="cancel-destroy" type="button">取消</button><button class="danger-confirm" data-action="confirm-destroy" type="button">销毁画布</button></div></section></div>
          <div class="confirm-backdrop" data-clear-confirm hidden><section class="confirm-dialog" id="clear-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="clear-title" aria-describedby="clear-description"><h2 id="clear-title">清除当前工作草稿？</h2><p id="clear-description">这会清除当前工作草稿中的标注和补充要求；任务输入框中已存在的上一版不会被自动移除。</p><div class="confirm-actions"><button class="quiet-button" data-action="cancel-clear" type="button">取消</button><button class="danger-confirm" data-action="confirm-clear" type="button">清除草稿</button></div></section></div>
        </section>`;
      renderIcons();
    },

    updateEditor({
      editor,
      imageUrl,
      submissionInFlight,
      artifactLoadInFlight,
      destroyInFlight = false,
      destroyedEditorTerminal = false,
      revealInFlightImageId = "",
      undoCount,
      redoCount,
      modelCapabilities,
      intentPanelOpen,
      destroyConfirmOpen = false,
      clearConfirmOpen = false,
      draftState = { kind: "empty" },
      submissionStatus,
      submissionStatusTone,
      colorEditorSlot = null,
      colorEditorDraft = null,
      colorEditorHue = null,
    }) {
      const hasImage = Boolean(editor.image.id);
      const operationInFlight = submissionInFlight || artifactLoadInFlight || destroyInFlight;
      const interactionLocked = operationInFlight || destroyedEditorTerminal;
      root.querySelector(".editor-app")?.setAttribute("aria-busy", String(operationInFlight));
      root.querySelector("[data-empty]").hidden = hasImage;
      const image = root.querySelector("[data-image]");
      image.hidden = !hasImage || !imageUrl;
      if (imageUrl && image.src !== imageUrl) image.src = imageUrl;
      root.querySelector("[data-image-name]").textContent = hasImage ? (editor.image.name || `图片 ${editor.image.id.slice(-6)}`) : "等待图片";
      root.querySelector("[data-image-id]").textContent = hasImage ? editor.image.id : "未绑定图片";
      root.querySelector("[data-zoom-select]").value = String(editor.zoom);
      const canvas = root.querySelector("[data-canvas]");
      canvas.style.aspectRatio = `${Math.max(1, editor.image.width || 1)} / ${Math.max(1, editor.image.height || 1)}`;
      const viewBox = annotationViewBox(editor.image);
      root.querySelector("[data-layer]").setAttribute("viewBox", `0 0 ${viewBox.width} ${viewBox.height}`);
      applyCanvasGeometry(canvas, editor);
      root.querySelector("[data-layer]").hidden = !hasImage || !editor.annotationVisible;
      root.querySelector("[data-layer]").style.opacity = editor.annotationVisible ? "1" : "0";
      const annotationVisibility = root.querySelector("[data-action=toggle-annotations]");
      annotationVisibility.setAttribute("aria-pressed", String(editor.annotationVisible));
      annotationVisibility.setAttribute("aria-label", editor.annotationVisible ? "隐藏标注" : "显示标注");
      annotationVisibility.title = editor.annotationVisible ? "隐藏标注" : "显示标注";
      annotationVisibility.querySelector("[data-visible-icon]").hidden = !editor.annotationVisible;
      annotationVisibility.querySelector("[data-hidden-icon]").hidden = editor.annotationVisible;
      const visibleAnnotations = editor.annotations.filter(isUserFacingAnnotation);
      root.querySelector("[data-summary]").textContent = `已标注 ${visibleAnnotations.length} 处`;
      root.querySelector("[data-intent-count]").textContent = visibleAnnotations.length ? `${visibleAnnotations.length} 处修改意图` : "尚未标注";
      root.querySelector("[data-prompt]").value = editor.prompt;
      root.querySelector("[data-prompt-count]").textContent = `${editor.prompt.length}/600`;
      root.querySelector("[data-prompt]").disabled = interactionLocked;
      const submitButton = root.querySelector("[data-action=submit]");
      const pendingLocked = draftState.kind === "pending" || (draftState.kind === "updated" && draftState.canUpdate === false);
      submitButton.disabled = interactionLocked || pendingLocked || !hasImage || (!editor.annotations.length && !editor.prompt.trim());
      submitButton.textContent = submissionInFlight
        ? draftState.kind === "updated" ? "正在更新..." : "正在提交..."
        : draftState.kind === "pending"
          ? "已放入输入框"
          : draftState.kind === "updated"
            ? draftState.canUpdate === false ? "等待上一版确认" : "更新任务输入框"
            : draftState.kind === "writing"
              ? "重新确认"
              : "提交修改";
      submitButton.title = draftState.kind === "updated"
        ? draftState.canUpdate === false
          ? "上一版任务输入仍在等待 Codex 确认"
          : "用当前画布内容更新任务输入框中的待发送请求"
        : "";
      root.querySelector("[data-action=undo]").disabled = interactionLocked || !undoCount;
      root.querySelector("[data-action=redo]").disabled = interactionLocked || !redoCount;
      root.querySelector("[data-action=back]").disabled = submissionInFlight || artifactLoadInFlight || destroyInFlight;
      root.querySelector("[data-action=destroy]").disabled = interactionLocked;
      const revealButton = root.querySelector("[data-action=reveal-image]");
      const revealBusy = revealInFlightImageId === editor.image.id && Boolean(editor.image.id);
      revealButton.disabled = interactionLocked || !hasImage || revealBusy;
      revealButton.setAttribute("aria-busy", String(revealBusy));
      root.querySelector("[data-action=clear]").disabled = interactionLocked || (!editor.annotations.length && !editor.prompt.trim());
      root.querySelector("[data-zoom-select]").disabled = interactionLocked;
      root.querySelectorAll("[data-tool], [data-color-slot], [data-action=edit-active-color], [data-stroke], [data-version-id]").forEach((control) => { control.disabled = interactionLocked; });
      updateStyleControls(root, editor, modelCapabilities, interactionLocked, { colorEditorSlot, colorEditorDraft, colorEditorHue });
      const intentList = root.querySelector("[data-intents]");
      const activeElement = root.ownerDocument.activeElement;
      const focusedAnnotation = activeElement?.matches?.("[data-annotation-text]")
        ? { id: activeElement.dataset.annotationText, start: activeElement.selectionStart, end: activeElement.selectionEnd }
        : null;
      const intentScrollTop = intentList.scrollTop;
      const selectionChanged = Boolean(editor.selectedAnnotationId && editor.selectedAnnotationId !== lastSelectedAnnotationId);
      intentList.innerHTML = visibleAnnotations.length ? visibleAnnotations.map((item, index) => annotationItemMarkup(item, index, item.id === editor.selectedAnnotationId, interactionLocked, editor.color)).join("") : `<p class="muted">在图片上标出要处理的位置。</p>`;
      renderIcons();
      intentList.scrollTop = intentScrollTop;
      if (focusedAnnotation) {
        const field = [...intentList.querySelectorAll("[data-annotation-text]")]
          .find((candidate) => candidate.dataset.annotationText === focusedAnnotation.id);
        if (field) {
          field.focus({ preventScroll: true });
          field.setSelectionRange(focusedAnnotation.start, focusedAnnotation.end);
        }
      } else if (selectionChanged) {
        intentList.querySelector(`[data-annotation-id="${escapeHtml(editor.selectedAnnotationId)}"]`)?.scrollIntoView?.({ block: "nearest" });
      }
      lastSelectedAnnotationId = editor.selectedAnnotationId;
      root.querySelector("[data-lineage-crumb]").textContent = editor.lineage.map((item) => item.role === "current" ? "当前版本" : item.role === "parent" ? "父版本" : "子版本").join(" › ");
      const lineageRoleCounts = new Map();
      root.querySelector("[data-lineage]").innerHTML = editor.lineage.map((item) => {
        const roleCount = (lineageRoleCounts.get(item.role) || 0) + 1;
        lineageRoleCounts.set(item.role, roleCount);
        const roleLabel = item.role === "current" ? "当前版本" : item.role === "parent" ? "父版本" : "修订";
        const loadStatus = item.data ? "已读取" : item.loadError ? "读取失败" : "读取中";
        const accessibleLabel = `${roleLabel} ${roleCount}，${loadStatus}，图片 ${item.id.slice(-6)}`;
        const thumbnail = item.data
          ? `<img src="data:${item.mimeType};base64,${item.data}" alt="">`
          : item.loadError
            ? `<span class="version-error" role="status" title="${escapeHtml(item.loadError)}">读取失败</span>`
            : '<span class="version-loading" role="status">读取中</span>';
        return `<button class="version-item ${item.role === "current" ? "current" : ""}" data-version-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(accessibleLabel)}"><span class="version-thumb">${thumbnail}</span><span>${item.role === "current" ? "当前" : item.role === "parent" ? "父版本" : "修订"}</span></button>`;
      }).join("");
      root.querySelectorAll("[data-version-id]").forEach((control) => {
        control.disabled = interactionLocked;
        if (control.dataset.versionId === editor.image.id) control.setAttribute("aria-current", "true");
        else control.removeAttribute("aria-current");
      });
      const intentPanel = root.querySelector("[data-intent-panel]");
      intentPanel.classList.toggle("open", intentPanelOpen);
      root.querySelectorAll("[data-action=toggle-intents]").forEach((button) => button.setAttribute("aria-expanded", String(intentPanelOpen)));
      this.renderAnnotationLayer(editor);
      const submitStatus = root.querySelector("[data-submit-status]");
      submitStatus.textContent = submissionStatus;
      submitStatus.dataset.statusTone = submissionStatusTone;
      submitStatus.dataset.destroyedTerminal = String(destroyedEditorTerminal);
      submitStatus.classList.toggle("visible", Boolean(submissionStatus));
      root.querySelector("[data-destroy-confirm]").hidden = !destroyConfirmOpen;
      root.querySelector("[data-clear-confirm]").hidden = !clearConfirmOpen;
    },

    updateSelection({ editor, modelCapabilities, intentPanelOpen, colorEditorSlot = null, colorEditorDraft = null, colorEditorHue = null }) {
      updateStyleControls(root, editor, modelCapabilities, false, { colorEditorSlot, colorEditorDraft, colorEditorHue });
      root.querySelectorAll("[data-annotation-id]").forEach((item) => {
        const selected = item.dataset.annotationId === editor.selectedAnnotationId;
        item.classList.toggle("selected", selected);
        if (selected) item.setAttribute("aria-current", "true");
        else item.removeAttribute("aria-current");
      });
      root.querySelector("[data-intent-panel]").classList.toggle("open", intentPanelOpen);
      root.querySelectorAll("[data-action=toggle-intents]").forEach((button) => {
        button.setAttribute("aria-expanded", String(intentPanelOpen));
      });
      this.renderAnnotationLayer(editor);
    },

    updateColorControls({ editor, modelCapabilities, interactionLocked = false, colorEditorSlot = null, colorEditorDraft = null, colorEditorHue = null }) {
      updateStyleControls(root, editor, modelCapabilities, interactionLocked, { colorEditorSlot, colorEditorDraft, colorEditorHue });
    },

    updateCanvasGeometry(editor) {
      const canvas = root.querySelector("[data-canvas]");
      if (canvas) applyCanvasGeometry(canvas, editor);
    },

    renderAnnotationLayer(editor, keyboardState = null) {
      const layer = root.querySelector("[data-layer]");
      if (!layer) return;
      layer.innerHTML = `${annotationLayerMarkup(editor.annotations, editor.selectedAnnotationId, editor.image, editor.editingTextAnnotationId)}${keyboardCursorMarkup(keyboardState, editor.image)}`;
    },

    renderPreviewAnnotation(editor, item, keyboardState = null) {
      const layer = root.querySelector("[data-layer]");
      if (layer) layer.innerHTML = `${annotationLayerMarkup([...editor.annotations, item], editor.selectedAnnotationId, editor.image, editor.editingTextAnnotationId)}${keyboardCursorMarkup(keyboardState, editor.image)}`;
    },
  };
}

function keyboardCursorMarkup(state, image) {
  if (!state?.engaged || !state.cursor || state.imageId !== image?.id) return "";
  const viewBox = annotationViewBox(image);
  const x = state.cursor.x * viewBox.width;
  const y = state.cursor.y * viewBox.height;
  const radius = Math.max(9, Math.min(viewBox.width, viewBox.height) * 0.012);
  return `<g class="keyboard-cursor" aria-hidden="true" data-keyboard-cursor><circle cx="${x}" cy="${y}" r="${radius}" fill="none" stroke="#ffffff" stroke-width="4"/><circle cx="${x}" cy="${y}" r="${radius}" fill="none" stroke="#17191d" stroke-width="2"/><path d="M ${x - radius * 1.5} ${y} H ${x + radius * 1.5} M ${x} ${y - radius * 1.5} V ${y + radius * 1.5}" stroke="#ffffff" stroke-width="4"/><path d="M ${x - radius * 1.5} ${y} H ${x + radius * 1.5} M ${x} ${y - radius * 1.5} V ${y + radius * 1.5}" stroke="#17191d" stroke-width="2"/></g>`;
}

function annotationItemMarkup(item, index, selected, interactionLocked, foregroundColor) {
  const id = escapeHtml(item.id);
  const label = labelFor(item);
  const color = normalizeHexColor(item.color) || "#ef4444";
  const protectMask = item.type === "mask" && item.mode === "protect";
  const maskErase = item.type === "mask" && item.operation === "erase";
  const descriptionPlaceholder = maskErase
    ? "说明局部擦除的原因（可选）"
    : protectMask
    ? "说明要保留的主体、文字或纹理（可选）"
    : item.type === "mask"
      ? "描述这个区域需要如何修改（可选）"
      : "描述这里需要如何修改";
  const descriptionLabel = maskErase ? "擦除说明" : protectMask ? "保护说明" : item.type === "mask" ? "改图说明" : "修改说明";
  const applyColor = item.type !== "mask"
    ? `<button class="quiet-button annotation-apply-color" data-action="apply-foreground-color" data-annotation-target="${id}" type="button" aria-label="将当前前景色应用到第 ${index + 1} 条标注" title="应用当前前景色" ${interactionLocked || color === normalizeHexColor(foregroundColor) ? "disabled" : ""}><i data-lucide="paintbrush"></i><span>应用前景色</span></button>`
    : "";
  return `<div class="intent-item ${selected ? "selected" : ""}" data-annotation-id="${id}" style="--item-color:${escapeHtml(color)}" ${selected ? 'aria-current="true"' : ""}><span class="intent-number" title="标注颜色 ${color.toUpperCase()}">${index + 1}</span><div class="intent-content"><div class="intent-heading"><strong>${label}</strong><span class="annotation-color-chip" style="--annotation-color:${escapeHtml(color)}" title="标注颜色 ${color.toUpperCase()}" aria-label="标注颜色 ${color.toUpperCase()}"></span></div><textarea data-annotation-text="${id}" rows="3" maxlength="600" aria-label="${label}说明" placeholder="${descriptionPlaceholder}" ${interactionLocked ? "disabled" : ""}>${escapeHtml(item.text || "")}</textarea><div class="annotation-item-meta"><span>${descriptionLabel}</span><span data-annotation-count>${String(item.text || "").length}/600</span></div><div class="annotation-item-actions">${applyColor}<button class="quiet-button annotation-delete" data-action="remove-annotation" data-annotation-target="${id}" type="button" aria-label="删除第 ${index + 1} 条标注" title="删除" ${interactionLocked ? "disabled" : ""}><i data-lucide="trash-2"></i></button></div></div></div>`;
}

function updateStyleControls(root, editor, modelCapabilities, interactionLocked, { colorEditorSlot = null, colorEditorDraft = null, colorEditorHue = null } = {}) {
  root.querySelectorAll("[data-tool]").forEach((button) => {
    const active = button.dataset.tool === editor.activeTool;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  root.querySelector("[data-tool=mask]").hidden = modelCapabilities?.mask !== true;
  const selectedAnnotation = editor.annotations.find((item) => item.id === editor.selectedAnnotationId);
  const maskContext = modelCapabilities?.mask === true && editor.activeTool === "mask";
  const maskStyleLocked = maskContext || selectedAnnotation?.type === "mask";
  const maskMode = editor.maskMode;
  const maskOperation = editor.maskOperation;
  const maskBrushRadius = editor.maskBrushRadius;
  const maskEraseAvailable = hasMaskPaintStroke(editor.annotations, maskMode);
  const maskEraseHint = root.querySelector("[data-mask-erase-hint]");
  maskEraseHint.textContent = maskContext && !maskEraseAvailable ? "先在当前区域层绘制蒙版" : "";
  root.querySelector("[data-mask-options]").hidden = !maskContext;
  root.querySelector("[data-standard-style]").hidden = maskStyleLocked;
  root.querySelectorAll("[data-mask-mode]").forEach((button) => {
    const active = button.dataset.maskMode === maskMode;
    button.disabled = interactionLocked;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  root.querySelectorAll("[data-mask-operation]").forEach((button) => {
    const active = button.dataset.maskOperation === maskOperation;
    const eraseUnavailable = button.dataset.maskOperation === "erase" && !maskEraseAvailable;
    button.disabled = interactionLocked;
    button.setAttribute("aria-disabled", String(interactionLocked || eraseUnavailable));
    if (eraseUnavailable) button.setAttribute("aria-describedby", maskEraseHint.id);
    else button.removeAttribute("aria-describedby");
    button.title = eraseUnavailable ? "先在当前区域层绘制蒙版" : button.dataset.maskOperation === "erase" ? "局部擦除当前区域层蒙版" : "绘制蒙版";
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  root.querySelectorAll("[data-mask-radius]").forEach((button) => {
    const active = Number(button.dataset.maskRadius) === maskBrushRadius;
    button.disabled = interactionLocked;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const customColorPanel = root.querySelector("[data-custom-color-panel]");
  const colorSlots = DEFAULT_ANNOTATION_COLOR_SLOTS.map((fallback, index) => normalizeHexColor(editor.colorSlots?.[index]) || fallback);
  const activeColorSlot = Number.isInteger(editor.activeColorSlot) && editor.activeColorSlot >= 0 && editor.activeColorSlot < colorSlots.length
    ? editor.activeColorSlot
    : Math.max(0, colorSlots.indexOf(normalizeHexColor(editor.color)));
  const panelSlot = Number.isInteger(colorEditorSlot) && colorEditorSlot >= 0 && colorEditorSlot < colorSlots.length
    ? colorEditorSlot
    : activeColorSlot;
  const panelOpen = Number.isInteger(colorEditorSlot) && !interactionLocked && !maskStyleLocked;
  root.querySelector(".editor-app").dataset.colorEditorOpen = String(panelOpen);
  root.querySelector("[data-color-editor-overlay]").dataset.open = String(panelOpen);
  const savedSlotColor = colorSlots[panelSlot];
  const panelColor = normalizeHexColor(colorEditorDraft) || savedSlotColor;
  const panelRgb = hexToRgb(panelColor) || { red: 0, green: 0, blue: 0 };
  const panelHsv = hexToHsv(panelColor) || { hue: 0, saturation: 0, value: 0 };
  const panelHue = Number.isFinite(colorEditorHue) ? ((colorEditorHue % 360) + 360) % 360 : panelHsv.hue;
  root.querySelectorAll("[data-color-slot]").forEach((button) => {
    const index = Number(button.dataset.colorSlot);
    const color = colorSlots[index];
    const active = index === activeColorSlot;
    const expanded = panelOpen && index === panelSlot;
    button.disabled = interactionLocked || maskStyleLocked;
    button.dataset.color = color;
    button.style.setProperty("--swatch", color);
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("tabindex", active ? "0" : "-1");
    button.setAttribute("aria-label", `颜色 ${index + 1} ${color.toUpperCase()}`);
    button.setAttribute("aria-description", "左键选择；右键编辑");
    button.title = `颜色 ${index + 1} ${color.toUpperCase()}：左键选择，右键编辑`;
  });
  const colorEditButton = root.querySelector("[data-action=edit-active-color]");
  colorEditButton.disabled = interactionLocked || maskStyleLocked;
  colorEditButton.setAttribute("aria-label", `编辑颜色 ${activeColorSlot + 1}`);
  colorEditButton.title = `编辑当前颜色 ${activeColorSlot + 1}`;
  customColorPanel.hidden = !panelOpen;
  customColorPanel.querySelector("[data-custom-color-panel-title]").textContent = `编辑颜色 ${panelSlot + 1}`;
  const colorArea = customColorPanel.querySelector("[data-custom-color-area]");
  colorArea.style.setProperty("--picker-hue-color", `hsl(${panelHue} 100% 50%)`);
  colorArea.style.setProperty("--picker-saturation", `${panelHsv.saturation * 100}%`);
  colorArea.style.setProperty("--picker-value", `${(1 - panelHsv.value) * 100}%`);
  colorArea.setAttribute("aria-valuenow", String(Math.round(panelHsv.value * 100)));
  colorArea.setAttribute("aria-valuetext", `饱和度 ${Math.round(panelHsv.saturation * 100)}%，明度 ${Math.round(panelHsv.value * 100)}%`);
  customColorPanel.querySelector("[data-custom-color-hue]").value = String(Math.round(panelHue));
  customColorPanel.querySelector("[data-custom-color-current]").style.setProperty("--preview-color", savedSlotColor);
  customColorPanel.querySelector("[data-custom-color-draft]").style.setProperty("--preview-color", panelColor);
  customColorPanel.querySelector("[data-custom-color-hex]").value = panelColor.toUpperCase();
  customColorPanel.querySelector("[data-custom-color-red]").value = String(panelRgb.red);
  customColorPanel.querySelector("[data-custom-color-green]").value = String(panelRgb.green);
  customColorPanel.querySelector("[data-custom-color-blue]").value = String(panelRgb.blue);
  customColorPanel.querySelectorAll("input").forEach((control) => { control.disabled = !panelOpen; });
  colorArea.setAttribute("aria-disabled", String(interactionLocked || maskStyleLocked));
  const colorReset = customColorPanel.querySelector("[data-custom-color-reset]");
  const colorResetLabel = `恢复颜色 ${panelSlot + 1} 为默认色 ${DEFAULT_ANNOTATION_COLOR_SLOTS[panelSlot].toUpperCase()}`;
  colorReset.disabled = !panelOpen || panelColor === DEFAULT_ANNOTATION_COLOR_SLOTS[panelSlot];
  colorReset.setAttribute("aria-label", colorResetLabel);
  colorReset.title = colorResetLabel;
  customColorPanel.querySelector("[data-custom-color-apply]").disabled = !normalizeHexColor(panelColor) || !panelOpen;
  root.querySelectorAll("[data-stroke]").forEach((button) => {
    const active = Number(button.dataset.stroke) === (editor.strokeWidth || 5);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderIcons() {
  if (typeof document === "undefined") return;
  createIcons({
    icons: lucideIcons,
    attrs: { width: 18, height: 18, "stroke-width": 1.8, "aria-hidden": "true" },
  });
}

function applyCanvasGeometry(canvas, editor) {
  const frame = canvas.closest(".canvas-frame");
  const frameRect = frame?.getBoundingClientRect();
  const availableWidth = frame?.clientWidth || frameRect?.width || 0;
  const availableHeight = frame?.clientHeight || frameRect?.height || 0;
  if (availableWidth <= 0 || availableHeight <= 0) return;
  const oldWidth = Number.parseFloat(canvas.style.width) || availableWidth;
  const oldHeight = Number.parseFloat(canvas.style.height) || availableHeight;
  const centerX = visibleCenterRatio(frame.scrollLeft, availableWidth, oldWidth);
  const centerY = visibleCenterRatio(frame.scrollTop, availableHeight, oldHeight);
  const geometry = computeCanvasGeometry({
    availableWidth,
    availableHeight,
    imageWidth: editor.image.width,
    imageHeight: editor.image.height,
    zoom: editor.zoom,
  });
  canvas.style.width = `${geometry.width}px`;
  canvas.style.height = `${geometry.height}px`;
  const maxScrollLeft = Math.max(0, geometry.width - availableWidth);
  const maxScrollTop = Math.max(0, geometry.height - availableHeight);
  frame.scrollLeft = clamp(centerX * geometry.width - availableWidth / 2, 0, maxScrollLeft);
  frame.scrollTop = clamp(centerY * geometry.height - availableHeight / 2, 0, maxScrollTop);
}

function visibleCenterRatio(scrollOffset, viewportSize, contentSize) {
  if (!Number.isFinite(contentSize) || contentSize <= 0) return 0.5;
  const visibleSize = Math.min(viewportSize, contentSize);
  const maximumOffset = Math.max(0, contentSize - viewportSize);
  const offset = clamp(Number(scrollOffset) || 0, 0, maximumOffset);
  return (offset + visibleSize / 2) / contentSize;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
