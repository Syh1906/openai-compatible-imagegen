import {
  ArrowUpRight,
  Brush,
  ChevronLeft,
  Eraser,
  Eye,
  EyeOff,
  Maximize2,
  MousePointer2,
  PanelRight,
  Pencil,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
  createIcons,
} from "lucide";

import { annotationOverlay, escapeHtml, labelFor } from "./editor-annotation-view.mjs";


const toolDefinitions = [
  ["select", "mouse-pointer-2", "选择"],
  ["pen", "pencil", "画笔"],
  ["arrow", "arrow-up-right", "箭头"],
  ["rectangle", "square", "矩形"],
  ["text", "type", "文字"],
  ["eraser", "eraser", "擦除"],
  ["mask", "brush", "遮罩笔刷"],
];
const lucideIcons = { ArrowUpRight, Brush, ChevronLeft, Eraser, Eye, EyeOff, Maximize2, MousePointer2, PanelRight, Pencil, Redo2, Square, Trash2, Type, Undo2, X };

export function createEditorRenderer(root) {
  return {
    isEditorMounted() {
      return Boolean(root.querySelector(".editor-app"));
    },

    renderInline({ candidates, openingImageId, inlineStatus, inlineStatusTone, inlineStatusImageId, onOpen }) {
      const items = candidates?.length ? candidates : [{ id: "", imageUrl: "" }];
      root.onclick = null;
      root.innerHTML = `<section class="inline-results ${items.length > 1 ? "multiple" : ""}" aria-label="会话图片结果">${items.map((candidate, index) => {
        const hasImage = Boolean(candidate.id && candidate.imageUrl);
        const opening = openingImageId === candidate.id;
        const canvasDestroyed = candidate.canvasStatus === "destroyed";
        return `
          <article class="inline-result" data-result-image-id="${escapeHtml(candidate.id || "")}" data-canvas-status="${canvasDestroyed ? "destroyed" : "available"}">
            <div class="inline-preview">
              ${hasImage ? `<img class="source-image" data-image src="${candidate.imageUrl}" alt="候选图片 ${index + 1}">` : `<div class="inline-loading">${candidate.loadError ? "图片读取失败" : candidate.id ? "正在读取图片..." : "正在等待会话图片..."}</div>`}
            </div>
            <div class="inline-details">
              <div class="inline-copy"><span class="eyebrow">${items.length > 1 ? `候选 ${index + 1}` : "图片结果"}</span><strong>${hasImage ? (candidate.name || `图片 ${candidate.id.slice(-6)}`) : candidate.loadError ? "无法显示图片" : "准备画布"}</strong><span data-image-id>${candidate.id || "尚未绑定图片"}</span></div>
              ${canvasDestroyed
                ? '<span class="canvas-destroyed-status" role="status">画布已销毁</span>'
                : `<button class="open-editor-button" data-action="open-editor" data-image-id="${escapeHtml(candidate.id || "")}" ${hasImage && !openingImageId ? "" : "disabled"}>${opening ? "正在打开..." : "打开画布"}</button>`}
              <p class="inline-status" data-inline-status data-status-tone="${candidate.loadError ? "error" : inlineStatusTone}" role="status" aria-live="polite">${candidate.loadError ? escapeHtml(candidate.loadError) : opening || candidate.id === inlineStatusImageId || items.length === 1 ? inlineStatus : ""}</p>
            </div>
          </article>`;
      }).join("")}</section>`;
      root.querySelectorAll("[data-action=open-editor]").forEach((button) => {
        button.addEventListener("click", () => onOpen(button.dataset.imageId));
      });
    },

    mountEditor() {
      root.innerHTML = `
        <section class="editor-app" aria-label="聚焦图片编辑器">
          <header class="topbar">
            <div class="identity"><button class="return-button" data-action="back" aria-label="返回会话" title="返回会话"><i data-lucide="chevron-left"></i><span>返回会话</span></button><div><strong data-image-name>等待图片</strong><span data-image-id>未绑定图片</span></div></div>
            <div class="lineage-crumb" data-lineage-crumb>当前图片</div>
            <div class="top-actions"><span class="close-guidance" data-close-guidance title="请使用“返回会话”收起画布；直接使用 Codex 的关闭按钮可能移除会话入口。"><span class="close-guidance-mark" aria-hidden="true">i</span><span class="close-guidance-text">使用“返回会话”收起，直接关闭可能移除入口</span></span><button class="text-icon" data-action="undo" aria-label="撤销" title="撤销"><i data-lucide="undo-2"></i></button><button class="text-icon" data-action="redo" aria-label="重做" title="重做"><i data-lucide="redo-2"></i></button><label class="zoom-control"><select data-zoom-select aria-label="缩放"><option value="0.75">75%</option><option value="1" selected>100%</option><option value="1.25">125%</option><option value="1.5">150%</option></select></label><button class="text-icon" data-action="fit" aria-label="适应窗口" title="适应窗口"><i data-lucide="maximize-2"></i></button><button class="text-icon" data-action="toggle-annotations" aria-label="隐藏标注" title="隐藏标注" aria-pressed="true"><span data-visible-icon><i data-lucide="eye"></i></span><span data-hidden-icon hidden><i data-lucide="eye-off"></i></span></button><button class="intent-panel-toggle" data-action="toggle-intents" aria-controls="intent-panel" aria-expanded="false"><i data-lucide="panel-right"></i><span>修改意图</span></button><button class="destroy-button" data-action="destroy"><i data-lucide="trash-2"></i><span>销毁画布</span></button></div>
          </header>
          <div class="workspace">
            <aside class="tool-rail" aria-label="标注工具">${toolDefinitions.map(([tool, icon, label]) => `<button class="tool-button" data-tool="${tool}" aria-label="${label}" title="${label}" aria-pressed="false" ${tool === "mask" ? "hidden" : ""}><i data-lucide="${icon}"></i></button>`).join("")}<span class="rail-rule"></span><button class="swatch active" data-color="#ef4444" aria-label="红色标注" title="红色标注" aria-pressed="true"></button><button class="swatch" data-color="#2563eb" aria-label="蓝色标注" title="蓝色标注" aria-pressed="false"></button><button class="swatch" data-color="#111827" aria-label="黑色标注" title="黑色标注" aria-pressed="false"></button><button class="stroke-button" data-stroke="3" aria-label="细线" title="细线" aria-pressed="false">—</button><button class="stroke-button active" data-stroke="5" aria-label="中线" title="中线" aria-pressed="true">━</button></aside>
            <section class="canvas-zone"><div class="canvas-frame"><div class="canvas-content" data-canvas><div class="empty-state" data-empty>正在等待会话图片...</div><img class="source-image" data-image alt="当前图片" hidden><svg class="annotation-layer" data-layer viewBox="0 0 1000 1000" preserveAspectRatio="none" hidden></svg></div></div></section>
            <aside class="intent-panel" id="intent-panel" data-intent-panel><div class="panel-heading"><div><span class="eyebrow">本次修改</span><h1 data-intent-count>尚未标注</h1></div><div class="panel-heading-actions"><button class="quiet-button panel-close" data-action="toggle-intents" aria-label="关闭修改意图面板" title="关闭"><i data-lucide="x"></i></button><button class="quiet-button" data-action="clear" aria-label="清除本次修改" title="清除本次修改">清除</button></div></div><div class="intent-list" data-intents><p class="muted">在图片上添加箭头、区域或文字，修改意图会在这里汇总。</p></div><label class="prompt-label" for="prompt">补充要求</label><textarea id="prompt" data-prompt maxlength="600" placeholder="例如：保持整体风格一致，避免改变主体比例"></textarea><div class="prompt-meta"><span>可选</span><span data-prompt-count>0/600</span></div></aside>
          </div>
          <footer class="bottom-bar"><div class="version-strip" data-lineage></div><div class="submit-row"><div class="submit-copy"><span class="annotation-summary" data-summary>已标注 0 处</span><span class="submit-status" data-submit-status role="status" aria-live="polite"></span></div><button class="submit-button" data-action="submit" type="button" disabled>提交修改</button></div></footer>
          <div class="toast" data-toast role="status" aria-live="polite"></div>
        </section>`;
      renderIcons();
    },

    updateEditor({
      editor,
      imageUrl,
      submissionInFlight,
      artifactLoadInFlight,
      undoCount,
      redoCount,
      modelCapabilities,
      intentPanelOpen,
      submissionStatus,
      submissionStatusTone,
    }) {
      const hasImage = Boolean(editor.image.id);
      const interactionLocked = submissionInFlight || artifactLoadInFlight;
      root.querySelector(".editor-app")?.setAttribute("aria-busy", String(interactionLocked));
      root.querySelector("[data-empty]").hidden = hasImage;
      const image = root.querySelector("[data-image]");
      image.hidden = !hasImage || !imageUrl;
      if (imageUrl && image.src !== imageUrl) image.src = imageUrl;
      root.querySelector("[data-image-name]").textContent = hasImage ? (editor.image.name || `图片 ${editor.image.id.slice(-6)}`) : "等待图片";
      root.querySelector("[data-image-id]").textContent = hasImage ? editor.image.id : "未绑定图片";
      root.querySelector("[data-zoom-select]").value = String(editor.zoom);
      const canvas = root.querySelector("[data-canvas]");
      canvas.style.aspectRatio = `${Math.max(1, editor.image.width || 1)} / ${Math.max(1, editor.image.height || 1)}`;
      canvas.style.transform = `scale(${editor.zoom})`;
      root.querySelector("[data-layer]").hidden = !hasImage || !editor.annotationVisible;
      root.querySelector("[data-layer]").style.opacity = editor.annotationVisible ? "1" : "0";
      const annotationVisibility = root.querySelector("[data-action=toggle-annotations]");
      annotationVisibility.setAttribute("aria-pressed", String(editor.annotationVisible));
      annotationVisibility.setAttribute("aria-label", editor.annotationVisible ? "隐藏标注" : "显示标注");
      annotationVisibility.title = editor.annotationVisible ? "隐藏标注" : "显示标注";
      annotationVisibility.querySelector("[data-visible-icon]").hidden = !editor.annotationVisible;
      annotationVisibility.querySelector("[data-hidden-icon]").hidden = editor.annotationVisible;
      root.querySelector("[data-summary]").textContent = `已标注 ${editor.annotations.length} 处`;
      root.querySelector("[data-intent-count]").textContent = editor.annotations.length ? `${editor.annotations.length} 处修改意图` : "尚未标注";
      root.querySelector("[data-prompt]").value = editor.prompt;
      root.querySelector("[data-prompt-count]").textContent = `${editor.prompt.length}/600`;
      root.querySelector("[data-prompt]").disabled = interactionLocked;
      const submitButton = root.querySelector("[data-action=submit]");
      submitButton.disabled = interactionLocked || !hasImage || (!editor.annotations.length && !editor.prompt.trim());
      submitButton.textContent = submissionInFlight ? "正在提交..." : "提交修改";
      root.querySelector("[data-action=undo]").disabled = interactionLocked || !undoCount;
      root.querySelector("[data-action=redo]").disabled = interactionLocked || !redoCount;
      root.querySelector("[data-action=back]").disabled = interactionLocked;
      root.querySelector("[data-action=destroy]").disabled = interactionLocked;
      root.querySelector("[data-action=clear]").disabled = interactionLocked || (!editor.annotations.length && !editor.prompt.trim());
      root.querySelector("[data-zoom-select]").disabled = interactionLocked;
      root.querySelectorAll("[data-tool], [data-color], [data-stroke], [data-version-id]").forEach((control) => { control.disabled = interactionLocked; });
      root.querySelectorAll("[data-tool]").forEach((button) => {
        const active = button.dataset.tool === editor.activeTool;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
      root.querySelector("[data-tool=mask]").hidden = modelCapabilities?.mask !== true;
      root.querySelectorAll("[data-color]").forEach((button) => {
        const active = button.dataset.color === (editor.color || "#ef4444");
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
      root.querySelectorAll("[data-stroke]").forEach((button) => {
        const active = Number(button.dataset.stroke) === (editor.strokeWidth || 5);
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
      const intentList = root.querySelector("[data-intents]");
      const activeElement = root.ownerDocument.activeElement;
      const focusedAnnotation = activeElement?.matches?.("[data-annotation-text]")
        ? { id: activeElement.dataset.annotationText, start: activeElement.selectionStart, end: activeElement.selectionEnd }
        : null;
      const intentScrollTop = intentList.scrollTop;
      intentList.innerHTML = editor.annotations.length ? editor.annotations.map((item, index) => `<div class="intent-item ${item.id === editor.selectedAnnotationId ? "selected" : ""}" data-annotation-id="${escapeHtml(item.id)}" ${item.id === editor.selectedAnnotationId ? 'aria-current="true"' : ""}><span class="intent-number">${index + 1}</span><div class="intent-content"><strong>${labelFor(item.type)}</strong><textarea data-annotation-text="${escapeHtml(item.id)}" rows="3" maxlength="600" aria-label="${labelFor(item.type)}说明" placeholder="描述这里需要如何修改" ${interactionLocked ? "disabled" : ""}>${escapeHtml(item.text || "")}</textarea><div class="annotation-item-meta"><span>修改说明</span><span data-annotation-count>${String(item.text || "").length}/600</span></div><button class="quiet-button annotation-delete" data-action="remove-annotation" data-annotation-target="${escapeHtml(item.id)}" type="button" aria-label="删除第 ${index + 1} 条标注" title="删除" ${interactionLocked ? "disabled" : ""}><i data-lucide="trash-2"></i></button></div></div>`).join("") : `<p class="muted">在图片上添加箭头、区域或文字，修改意图会在这里汇总。</p>`;
      renderIcons();
      intentList.scrollTop = intentScrollTop;
      if (focusedAnnotation) {
        const field = [...intentList.querySelectorAll("[data-annotation-text]")]
          .find((candidate) => candidate.dataset.annotationText === focusedAnnotation.id);
        if (field) {
          field.focus({ preventScroll: true });
          field.setSelectionRange(focusedAnnotation.start, focusedAnnotation.end);
        }
      }
      root.querySelector("[data-lineage-crumb]").textContent = editor.lineage.map((item) => item.role === "current" ? "当前版本" : item.role === "parent" ? "父版本" : "子版本").join(" › ");
      root.querySelector("[data-lineage]").innerHTML = editor.lineage.map((item) => `<button class="version-item ${item.role === "current" ? "current" : ""}" data-version-id="${item.id}"><span class="version-thumb">${item.data ? `<img src="data:${item.mimeType};base64,${item.data}" alt="">` : ""}</span><span>${item.role === "current" ? "当前" : item.role === "parent" ? "父版本" : "修订"}</span></button>`).join("");
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
      submitStatus.classList.toggle("visible", Boolean(submissionStatus));
    },

    renderAnnotationLayer(editor) {
      const layer = root.querySelector("[data-layer]");
      if (!layer) return;
      layer.innerHTML = editor.annotations.map((item, index) => annotationOverlay(item, index, item.id === editor.selectedAnnotationId)).join("");
    },

    renderPreviewAnnotation(editor, item) {
      this.renderAnnotationLayer(editor);
      root.querySelector("[data-layer]")?.insertAdjacentHTML("beforeend", annotationOverlay(item, editor.annotations.length));
    },
  };
}

function renderIcons() {
  if (typeof document === "undefined") return;
  createIcons({
    icons: lucideIcons,
    attrs: { width: 18, height: 18, "stroke-width": 1.8, "aria-hidden": "true" },
  });
}
