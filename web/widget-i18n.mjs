const MESSAGE_PAIRS = Object.freeze({
  "result.region": ["Conversation image results", "会话图片结果"],
  "result.imageResult": ["Image result", "图片结果"],
  "result.openCanvas": ["Open canvas", "打开画布"],
  "result.previewCandidate": ["Enlarge candidate image {number}", "放大预览候选图片 {number}"],
  "result.preview": ["Enlarge preview", "放大预览"],
  "result.candidateAlt": ["Candidate image {number}", "候选图片 {number}"],
  "result.imageName": ["Image {id}", "图片 {id}"],
  "editor.region": ["Focused image editor", "聚焦图片编辑器"],
  "editor.back": ["Back to conversation", "返回会话"],
  "editor.waitingImage": ["Waiting for image", "等待图片"],
  "editor.unboundImage": ["No image bound", "未绑定图片"],
  "editor.currentImage": ["Current image", "当前图片"],
  "editor.closeHelp": ["Close canvas guidance", "关闭画布说明"],
  "editor.keepCanvas": ["Back to conversation keeps this canvas", "返回会话可保留画布"],
  "editor.closeHelpText": ["Use Back to conversation to keep the current canvas and unsent changes. Closing the Codex canvas directly may remove its entry point.", "使用“返回会话”会保留当前画布和未发送修改；直接关闭 Codex 画布可能移除入口。"],
  "editor.undo": ["Undo", "撤销"],
  "editor.undoTitle": ["Undo (Ctrl+Z)", "撤销 (Ctrl+Z)"],
  "editor.redo": ["Redo", "重做"],
  "editor.redoTitle": ["Redo (Ctrl+Y)", "重做 (Ctrl+Y)"],
  "editor.zoom": ["Zoom", "缩放"],
  "editor.fit": ["Fit to window", "适应窗口"],
  "editor.reveal": ["Show in folder", "在文件夹中显示"],
  "editor.hideAnnotations": ["Hide annotations", "隐藏标注"],
  "editor.showAnnotations": ["Show annotations", "显示标注"],
  "editor.intents": ["Edit instructions", "修改意图"],
  "editor.destroy": ["Destroy canvas", "销毁画布"],
  "editor.annotationTools": ["Annotation tools", "标注工具"],
  "tool.select": ["Select", "选择"],
  "tool.pen": ["Pen", "画笔"],
  "tool.arrow": ["Arrow", "箭头"],
  "tool.rectangle": ["Rectangle", "矩形"],
  "tool.text": ["Text", "文字"],
  "tool.eraser": ["Eraser", "擦除"],
  "tool.mask": ["Mask brush", "蒙版笔刷"],
  "style.foreground": ["Foreground color", "前景色"],
  "style.color": ["Color {number} {color}", "颜色 {number} {color}"],
  "style.colorHelp": ["Left click to select; right click to edit", "左键选择；右键编辑"],
  "style.colorTitle": ["Color {number} {color}: left click to select, right click to edit", "颜色 {number} {color}：左键选择，右键编辑"],
  "style.editCurrent": ["Edit current color", "编辑当前颜色"],
  "style.editCurrentNumber": ["Edit current color {number}", "编辑当前颜色 {number}"],
  "style.thin": ["Thin line", "细线"],
  "style.medium": ["Medium line", "中线"],
  "mask.nextStroke": ["Next stroke", "下一笔"],
  "mask.actions": ["Next mask operation", "下一笔蒙版操作"],
  "mask.paint": ["Paint mask", "绘制蒙版"],
  "mask.erase": ["Erase part of mask", "局部擦除蒙版"],
  "mask.modes": ["Next mask mode", "下一笔蒙版模式"],
  "mask.edit": ["Edit area", "改图区域"],
  "mask.protect": ["Protected content", "保护内容"],
  "mask.editTitle": ["Allow the model to change only this area on the next stroke", "下一笔只允许模型修改该区域"],
  "mask.protectTitle": ["Mark content to preserve on the next stroke; lighting may adapt naturally", "下一笔标记要保留的内容；光影可随整体自然适配"],
  "mask.sizes": ["Next mask brush size", "下一笔蒙版笔刷大小"],
  "mask.small": ["Small mask brush", "小号蒙版笔刷"],
  "mask.medium": ["Medium mask brush", "中号蒙版笔刷"],
  "mask.large": ["Large mask brush", "大号蒙版笔刷"],
  "mask.smallTitle": ["Use a small brush on the next stroke", "下一笔使用小号笔刷"],
  "mask.mediumTitle": ["Use a medium brush on the next stroke", "下一笔使用中号笔刷"],
  "mask.largeTitle": ["Use a large brush on the next stroke", "下一笔使用大号笔刷"],
  "mask.paintFirst": ["Paint a mask on the current area layer first", "先在当前区域层绘制蒙版"],
  "size.small": ["Small", "小"],
  "size.medium": ["Medium", "中"],
  "size.large": ["Large", "大"],
  "canvas.keyboardHelp": ["Move focus to the canvas after selecting a tool. For pen, arrow, rectangle, and mask, press Space to start, use arrow keys to draw, and press Enter to finish. For text, press Enter to create it. Use arrow keys to move a selected annotation.", "选择工具后将焦点移到画布。画笔、箭头、矩形和蒙版按空格开始，方向键绘制，Enter 完成；文字按 Enter 创建；选中标注后方向键移动。"],
  "canvas.region": ["Image annotation canvas", "图片标注画布"],
  "canvas.waiting": ["Waiting for a conversation image...", "正在等待会话图片..."],
  "canvas.currentAlt": ["Current image", "当前图片"],
  "intent.thisEdit": ["This edit", "本次修改"],
  "intent.none": ["No annotations", "尚未标注"],
  "intent.close": ["Close edit instructions panel", "关闭修改意图面板"],
  "common.close": ["Close", "关闭"],
  "intent.clearWorking": ["Clear current working draft", "清除当前工作草稿"],
  "intent.clear": ["Clear draft", "清除草稿"],
  "intent.empty": ["Mark the areas to process on the image.", "在图片上标出要处理的位置。"],
  "intent.prompt": ["Additional instructions", "补充要求"],
  "intent.promptPlaceholder": ["For example: keep the overall style and subject proportions unchanged", "例如：保持整体风格一致，避免改变主体比例"],
  "common.optional": ["Optional", "可选"],
  "intent.summary": ["{count} annotations", "已标注 {count} 处"],
  "intent.count": ["{count} edit instructions", "{count} 处修改意图"],
  "annotation.arrow": ["Arrow pointer", "箭头指引"],
  "annotation.rectangle": ["Area adjustment", "区域调整"],
  "annotation.text": ["Text instruction", "文字要求"],
  "annotation.pen": ["Pen annotation", "画笔标注"],
  "annotation.region": ["Edit area", "修改区域"],
  "annotation.description": ["Describe how this area should change", "描述这里需要如何修改"],
  "annotation.descriptionLabel": ["Edit description", "修改说明"],
  "annotation.label": ["{label} description", "{label}说明"],
  "annotation.applyColor": ["Apply the current foreground color to annotation {number}", "将当前前景色应用到第 {number} 条标注"],
  "annotation.applyColorShort": ["Apply foreground color", "应用前景色"],
  "annotation.applyCurrentColor": ["Apply current foreground color", "应用当前前景色"],
  "annotation.color": ["Annotation color {color}", "标注颜色 {color}"],
  "annotation.delete": ["Delete annotation {number}", "删除第 {number} 条标注"],
  "common.delete": ["Delete", "删除"],
  "lineage.currentVersion": ["Current version", "当前版本"],
  "lineage.parentVersion": ["Parent version", "父版本"],
  "lineage.childVersion": ["Child version", "子版本"],
  "lineage.revision": ["Revision", "修订"],
  "lineage.loaded": ["Loaded", "已读取"],
  "lineage.loadFailed": ["Load failed", "读取失败"],
  "lineage.loading": ["Loading", "读取中"],
  "lineage.accessible": ["{role} {number}, {status}, image {id}", "{role} {number}，{status}，图片 {id}"],
  "submit.default": ["Submit changes", "提交修改"],
  "destroy.title": ["Destroy this canvas?", "销毁当前画布？"],
  "destroy.description": ["The image and saved versions will remain. The current canvas draft and entry point will be removed.", "图片和已保存版本会保留；当前画布草稿与入口将被移除。"],
  "common.cancel": ["Cancel", "取消"],
  "destroy.confirm": ["Destroy canvas", "销毁画布"],
  "clear.title": ["Clear the current working draft?", "清除当前工作草稿？"],
  "clear.description": ["This clears annotations and additional instructions from the current working draft. The previous version already in the task input will not be removed automatically.", "这会清除当前工作草稿中的标注和补充要求；任务输入框中已存在的上一版不会被自动移除。"],
  "clear.confirm": ["Clear draft", "清除草稿"],
  "color.title": ["Edit color {number}", "编辑颜色 {number}"],
  "color.close": ["Close color panel", "关闭颜色面板"],
  "color.sv": ["Saturation and brightness", "饱和度和明度"],
  "color.svValue": ["Saturation {saturation}%, brightness {brightness}%", "饱和度 {saturation}%，明度 {brightness}%"],
  "color.hue": ["Hue", "色相"],
  "color.comparison": ["Color comparison", "颜色对比"],
  "color.current": ["Current", "当前"],
  "color.new": ["New color", "新颜色"],
  "color.hex": ["HEX color value", "HEX 颜色值"],
  "color.red": ["Red channel", "红色通道"],
  "color.green": ["Green channel", "绿色通道"],
  "color.blue": ["Blue channel", "蓝色通道"],
  "color.restore": ["Restore color {number} to default {color}", "恢复颜色 {number} 为默认色 {color}"],
  "color.restoreShort": ["Restore default", "恢复默认"],
  "common.apply": ["Apply", "应用"],
  "runtime.hostDisconnected": ["The host is not connected, so the conversation cannot be restored yet", "宿主尚未连接，暂时无法返回会话"],
  "runtime.hostNotReady": ["The host is not connected, so this canvas cannot be opened yet", "宿主尚未连接，暂时无法打开画布"],
  "runtime.canvasNotReady": ["The canvas session is not ready yet", "当前画布会话尚未准备好"],
  "runtime.canvasOpenFailed": ["The canvas could not be opened", "画布打开失败"],
  "runtime.canvasOpenError": ["Codex could not open the canvas", "Codex 未能打开画布"],
  "runtime.canvasDestroyed": ["Canvas destroyed", "画布已销毁"],
  "runtime.canvasDestroyedTerminal": ["Canvas destroyed; editing is unavailable. Return to the conversation", "画布已销毁，无法继续编辑；请返回会话"],
  "runtime.canvasDestroyFailed": ["The canvas could not be destroyed", "画布销毁失败"],
  "runtime.canvasCleanupFailed": ["Canvas destroyed, but the session could not be cleaned up", "画布已销毁，但会话清理失败"],
  "runtime.saveFailed": ["Codex could not save the current canvas", "Codex 未能保存当前画布"],
  "runtime.saveAndCloseFailed": ["Codex could not save and close the current canvas", "Codex 未能保存并关闭当前画布"],
  "runtime.autosaveFailed": ["Codex could not save the current canvas automatically", "Codex 未能自动保存当前画布"],
  "runtime.returnFailed": ["Codex could not return to the conversation view", "Codex 未能返回会话视图"],
  "runtime.revealFailed": ["The image could not be shown in its folder", "无法在文件夹中显示图片"],
  "runtime.sessionStatusFailed": ["The canvas session status could not be confirmed", "无法确认画布会话状态"],
  "runtime.capabilitiesFailed": ["The current model capabilities could not be loaded", "无法读取当前模型能力"],
  "runtime.imageNotReady": ["The current image is not ready yet", "当前图片尚未准备好"],
  "runtime.hostConnectionFailed": ["The host connection failed. Reopen the current image", "宿主连接失败，请重新打开当前图片"],
  "runtime.expandUnsupported": ["This Codex App does not support expanding the canvas", "当前 Codex App 不支持展开画布"],
  "runtime.inlineUnsupported": ["This Codex App does not support returning to inline view", "当前 Codex App 不支持返回内联视图"],
  "runtime.displayModeFailed": ["The canvas display mode could not be changed", "画布显示模式切换失败"],
  "runtime.displayModeMismatch": ["The host did not switch to the requested display mode", "宿主未切换到请求的显示模式"],
  "runtime.switchVersionBlocked": ["Submit or clear the current changes before switching versions", "请先提交或清除当前修改，再切换版本"],
  "runtime.loadingVersion": ["Loading the selected version...", "正在加载所选版本..."],
  "runtime.submitting": ["Submitting changes", "提交修改"],
  "runtime.savingAnnotations": ["Saving annotations...", "正在保存标注..."],
  "runtime.preparingRequest": ["Preparing the edit request...", "正在准备修改请求..."],
  "runtime.openingCanvas": ["Opening canvas...", "正在打开画布..."],
  "runtime.placedInInput": ["Placed in input", "已放入输入框"],
  "runtime.waitingConfirmation": ["Waiting for the previous version to be confirmed", "等待上一版确认"],
  "runtime.updateInput": ["Update task input", "更新任务输入框"],
  "runtime.confirmAgain": ["Confirm again", "重新确认"],
  "runtime.submitChanges": ["Submit changes", "提交修改"],
  "runtime.destroyedStatus": ["Canvas destroyed", "画布已销毁"],
  "preview.zoomIn": ["Zoom in", "放大"],
  "preview.zoomInTitle": ["Zoom in (+)", "放大 (+)"],
  "preview.zoomOut": ["Zoom out", "缩小"],
  "preview.zoomOutTitle": ["Zoom out (-)", "缩小 (-)"],
  "preview.fit": ["Fit to window", "适应窗口"],
  "preview.fitTitle": ["Fit to window (0)", "适应窗口 (0)"],
  "preview.close": ["Close image preview", "关闭图片预览"],
  "preview.region": ["Image operations", "图片操作"],
  "preview.notReady": ["The current image is not ready yet", "当前图片尚未准备好"],
  "preview.fullscreenUnsupported": ["This Codex App does not support full-screen image preview", "当前 Codex App 不支持全屏图片预览"],
  "preview.openFailed": ["The image preview could not be opened", "未能打开图片预览"],
  "preview.closeFailed": ["The image preview could not be closed", "未能关闭图片预览"],
  "result.loading": ["Loading image...", "正在读取图片..."],
  "result.waiting": ["Waiting for a conversation image...", "正在等待会话图片..."],
  "result.loadFailed": ["Image could not be loaded", "图片读取失败"],
  "result.unavailable": ["Image unavailable", "无法显示图片"],
  "result.prepareCanvas": ["Prepare canvas", "准备画布"],
  "result.continueEditing": ["Continue editing", "继续编辑"],
  "result.canvasDestroyed": ["Canvas destroyed", "画布已销毁"],
  "result.candidate": ["Candidate {number}", "候选 {number}"],
  "result.imageId": ["Image {id}", "图片 {id}"],
  "result.unbound": ["No image bound", "尚未绑定图片"],
  "editor.annotationCanvas": ["Image annotation canvas", "图片标注画布"],
  "editor.waitingConversationImage": ["Waiting for a conversation image...", "正在等待会话图片..."],
  "editor.emptyInstruction": ["Mark the areas to process on the image.", "在图片上标出要处理的位置。"],
  "editor.optional": ["Optional", "可选"],
  "editor.prompt": ["Additional instructions", "补充要求"],
  "editor.noAnnotations": ["No annotations", "尚未标注"],
  "editor.annotationCount": ["{count} annotations", "已标注 {count} 处"],
  "editor.intentCount": ["{count} edit instructions", "{count} 处修改意图"],
  "editor.description": ["Describe how this area should change", "描述这里需要如何修改"],
  "editor.descriptionOptional": ["Describe how this area should change (optional)", "描述这个区域需要如何修改（可选）"],
  "editor.protectDescription": ["Describe the subject, text, or texture to preserve (optional)", "说明要保留的主体、文字或纹理（可选）"],
  "editor.eraseDescription": ["Explain why this local area should be erased (optional)", "说明局部擦除的原因（可选）"],
  "editor.editDescription": ["Edit description", "修改说明"],
  "editor.protectLabel": ["Protection description", "保护说明"],
  "editor.eraseLabel": ["Erase description", "擦除说明"],
  "editor.maskLabel": ["Image-edit description", "改图说明"],
  "editor.applyColorNumber": ["Apply the current foreground color to annotation {number}", "将当前前景色应用到第 {number} 条标注"],
  "editor.deleteAnnotation": ["Delete annotation {number}", "删除第 {number} 条标注"],
  "editor.applyForeground": ["Apply foreground color", "应用前景色"],
  "editor.maskHint": ["Paint a mask on the current area layer first", "先在当前区域层绘制蒙版"],
  "editor.eraseCurrentMask": ["Erase the current area-layer mask", "局部擦除当前区域层蒙版"],
  "editor.colorComparison": ["Color comparison", "颜色对比"],
  "editor.currentColor": ["Current", "当前"],
  "editor.newColor": ["New color", "新颜色"],
  "editor.colorValue": ["HEX color value", "HEX 颜色值"],
  "editor.invalidColor": ["Enter a complete #RRGGBB color", "请输入完整的 #RRGGBB 色值"],
  "editor.rgbRange": ["The value must be 0-255", "数值需为 0–255"],
  "status.previewing": ["Generating annotation preview...", "正在生成标注预览..."],
  "status.sending": ["Sending to the conversation...", "正在发送到会话..."],
  "status.requestSent": ["Edit request sent", "修改请求已发送"],
  "status.previewFailed": ["Annotation preview failed. Try again", "标注预览生成失败，请重试"],
  "status.prepareFailed": ["The edit submission could not be prepared. Try again", "修改提交准备失败，请重试"],
  "status.contextFailed": ["The model context could not be updated. Try again", "模型上下文更新失败，请重试"],
  "status.messageFailed": ["The conversation message could not be sent. Try again", "会话消息发送失败，请重试"],
  "status.submitFailed": ["Submission failed. Try again", "提交失败，请重试"],
  "status.capabilityUnsupported": ["This Codex App cannot submit images and text in one request", "当前 Codex App 不支持将图片和文字作为同一请求提交"],
  "status.previousPending": ["The previous task input update is still pending. Try again later", "上一次任务输入框更新仍在确认中，请稍后再提交"],
  "status.inputUpdateFailed": ["The task input could not be updated. You can submit again", "任务输入框更新失败，可重新提交"],
  "status.inputUpdateFailedPrevious": ["The task input could not be updated. The previous version remains and can be updated again", "任务输入框更新失败，仍保留上一版，可重新更新"],
  "status.inputUnconfirmed": ["The task input update was not confirmed. Check the input and submit again if it is missing", "任务输入框更新未获确认，请检查输入框；若未出现可重新提交"],
  "status.inputUpdated": ["Task input updated", "任务输入框已更新"],
  "status.inputUpdatedConfirm": ["Task input updated. Confirm before sending", "任务输入框已更新，请确认后发送"],
  "status.requestPlaced": ["Image edit request placed in task input", "图文修改请求已放入任务输入框"],
  "status.requestPlacedConfirm": ["Image edit request placed in task input. Confirm before sending", "图文修改请求已放入任务输入框，请确认后发送"],
  "status.confirmBeforeSending": ["Confirm before sending", "请确认后发送"],
  "status.waitingInput": ["Waiting for task input confirmation", "正在等待任务输入框确认"],
  "status.inputCurrent": ["Task input contains the current version", "任务输入框中是当前版本"],
  "status.inputPrevious": ["Task input still contains the previous version and can be updated", "任务输入框仍是上一版，可更新为当前修改"],
  "annotation.textDefault": ["Annotation text", "标注文字"],
  "annotation.added": ["Edit annotation added", "已添加修改标注"],
  "annotation.editCanvasText": ["Edit canvas text", "编辑画布文字"],
  "annotation.arrowHint": ["Focus on the position indicated by the arrow", "请关注箭头指向的位置"],
  "annotation.regionHint": ["Adjust the selected area", "请调整框选区域"],
  "annotation.textHint": ["Follow the text instruction", "请按文字说明处理"],
  "annotation.penHint": ["Use the brush-stroke area as reference", "请参考笔触范围"],
  "annotation.protectHint": ["Preserve the identity, shape, text, and texture of this content while allowing natural lighting adaptation", "保留该内容的身份、形状、文字和纹理，允许光影自然适配"],
  "annotation.editMask": ["Only allow the model to change this area", "只允许模型修改该区域"],
  "annotation.eraseEditMask": ["Erase image-edit mask", "擦除改图蒙版"],
  "annotation.eraseProtectMask": ["Erase protected-content mask", "擦除保护内容蒙版"],
  "annotation.removeEditMask": ["Remove part of the image-edit mask", "局部移除改图区域蒙版"],
  "annotation.removeProtectMask": ["Remove part of the protected-content mask", "局部移除保护内容蒙版"],
  "result.failureStage": ["Image load failed · {stage}", "图片读取失败 · {stage}"],
});

const LOCALE_INDEX = Object.freeze({ en: 0, "zh-CN": 1 });
const LOCALIZABLE_ATTRIBUTES = ["alt", "aria-label", "aria-description", "aria-valuetext", "placeholder", "title"];

export function resolveWidgetLocale(locale) {
  return typeof locale === "string" && /^zh(?:-|$)/i.test(locale.trim()) ? "zh-CN" : "en";
}

export function messageKeys() {
  return Object.keys(MESSAGE_PAIRS).sort();
}

export function createWidgetI18n(locale) {
  let currentLocale = resolveWidgetLocale(locale);
  const catalog = compileCatalog();
  const api = {
    get locale() { return currentLocale; },
    setLocale(nextLocale) {
      const resolved = resolveWidgetLocale(nextLocale);
      const changed = resolved !== currentLocale;
      currentLocale = resolved;
      return changed;
    },
    t(key, variables = {}) {
      const pair = MESSAGE_PAIRS[key];
      if (!pair) throw new Error(`unknown widget message key: ${key}`);
      return interpolate(pair[LOCALE_INDEX[currentLocale]], variables);
    },
    localizeText(value) {
      if (typeof value !== "string" || !value.trim()) return value;
      const leading = value.match(/^\s*/)?.[0] || "";
      const trailing = value.match(/\s*$/)?.[0] || "";
      const core = value.slice(leading.length, value.length - trailing.length);
      const exactKey = catalog.exact.get(core);
      if (exactKey) return `${leading}${api.t(exactKey)}${trailing}`;
      for (const entry of catalog.dynamic) {
        const variables = entry.match(core);
        if (variables) {
          const localizedVariables = Object.fromEntries(
            Object.entries(variables).map(([name, variable]) => [name, api.localizeText(variable)]),
          );
          return `${leading}${api.t(entry.key, localizedVariables)}${trailing}`;
        }
      }
      return value;
    },
    localizeTree(root) {
      if (!root) return;
      const view = root.ownerDocument.defaultView;
      const walker = root.ownerDocument.createTreeWalker(root, view.NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const localized = api.localizeText(walker.currentNode.nodeValue);
        if (localized !== walker.currentNode.nodeValue) walker.currentNode.nodeValue = localized;
      }
      for (const element of [root, ...root.querySelectorAll("*")]) {
        for (const name of LOCALIZABLE_ATTRIBUTES) {
          if (!element.hasAttribute?.(name)) continue;
          const value = element.getAttribute(name);
          const localized = api.localizeText(value);
          if (localized !== value) element.setAttribute(name, localized);
        }
      }
    },
  };
  return api;
}

function compileCatalog() {
  const entries = Object.entries(MESSAGE_PAIRS)
    .flatMap(([key, pair]) => pair.map((template) => ({
      key,
      template,
      literalLength: template.replace(/\{[a-zA-Z][a-zA-Z0-9]*\}/g, "").length,
      match: templateMatcher(template),
    })))
    .sort((left, right) => right.literalLength - left.literalLength || right.template.length - left.template.length);
  const exact = new Map();
  const dynamic = [];
  for (const entry of entries) {
    if (entry.template.includes("{")) dynamic.push(entry);
    else if (!exact.has(entry.template)) exact.set(entry.template, entry.key);
  }
  return { exact, dynamic };
}

function templateMatcher(template) {
  const names = [];
  let source = "";
  let cursor = 0;
  for (const match of template.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)) {
    source += escapeRegExp(template.slice(cursor, match.index));
    source += "(.+?)";
    names.push(match[1]);
    cursor = match.index + match[0].length;
  }
  source += escapeRegExp(template.slice(cursor));
  const pattern = new RegExp(`^${source}$`);
  return (value) => {
    const match = pattern.exec(value);
    return match ? Object.fromEntries(names.map((name, index) => [name, match[index + 1]])) : null;
  };
}

function interpolate(template, variables) {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_match, name) => String(variables[name] ?? `{${name}}`));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
