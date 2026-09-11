export function initialModelSelection(saved, image, models, authMode) {
  if (saved) return saved;
  const source = image?.parameters;
  const verified = models.find((model) => model.id === source?.modelProfileId
    && model.selectionFingerprint === source?.selectionFingerprint && source?.selectionFingerprint);
  const model = verified || models.find((item) => item.isDefault) || null;
  return { authMode, ...(model ? { modelProfileId: model.id, ...(model.selectionFingerprint ? { selectionFingerprint: model.selectionFingerprint } : {}) } : {}) };
}

export function modelSelectionStatus(selection, models) {
  if (selection?.authMode === "chatgpt") return { blocked: false, label: "ChatGPT · 本次修改" };
  const model = models.find((item) => item.id === selection?.modelProfileId);
  if (!model) return { blocked: true, label: selection?.modelProfileId ? `配置已不可用：${selection.modelProfileId}` : "请配置并选择编辑模型" };
  if (selection.selectionFingerprint && model.selectionFingerprint !== selection.selectionFingerprint) return { blocked: true, label: "此模型配置已改变，请重新选择", model };
  if (model.availability === "missing_credentials") return { blocked: true, label: "此供应商尚未配置 API Key", model };
  if (!(model.effectiveCapabilities || model.capabilities)?.edit) return { blocked: true, label: "此模型未启用图片编辑", model };
  return { blocked: false, label: `${model.displayName || model.model} · ${model.providerDisplayName || model.provider}`, model };
}

export function renderModelSelector(root, { models = [], catalogStatus = models.length ? "ready" : "empty", selection, locked = false, onChange, onRetry }) {
  const container = root.querySelector("[data-model-selector]");
  if (!container) return;
  container.hidden = selection?.authMode !== "apikey";
  if (container.hidden) { const menu = container.querySelector("details"); if (menu) menu.open = false; return; }
  const status = modelSelectionStatus(selection, models);
  const key = JSON.stringify({ models, catalogStatus, selection, locked });
  if (container.dataset.renderKey === key) return;
  const sameProfile = container.dataset.profileId === selection?.modelProfileId;
  const parametersOpen = sameProfile && container.querySelector(".model-parameters")?.open;
  const focusedParameter = sameProfile && container.contains(root.ownerDocument.activeElement)
    ? root.ownerDocument.activeElement?.dataset.parameterId : null;
  container.dataset.renderKey = key;
  container.dataset.profileId = selection?.modelProfileId || "";
  const doc = root.ownerDocument;
  const make = (tag, text, className) => {
    const element = doc.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const icon = (name, className = "") => {
    const element = make("i", undefined, className);
    element.dataset.lucide = name;
    element.setAttribute("aria-hidden", "true");
    return element;
  };
  const label = make("span", "本次编辑模型", "prompt-label");
  const heading = make("div", undefined, "model-picker-heading");
  heading.append(label);
  if (catalogStatus === "ready") heading.append(make("span", `已配置 ${models.length} 个`, "model-catalog-count"));
  if (catalogStatus !== "ready") {
    const state = make("div", undefined, "model-catalog-state");
    state.dataset.modelCatalogState = catalogStatus;
    state.setAttribute("role", catalogStatus === "error" ? "alert" : "status");
    const messages = {
      idle: ["正在读取模型…", "正在准备本次可用的编辑模型。"],
      loading: ["正在读取模型…", "读取完成后将显示已配置模型。"],
      error: ["模型列表读取失败", "未能读取已配置模型，请重新读取。"],
      empty: ["尚未配置 API 模型", "配置模型并重新绑定项目后，再读取列表。"],
      unconfigured: ["尚未配置 API 模型", "请先配置 API 模型，再重新打开画布。"],
    };
    const [title, description] = messages[catalogStatus];
    state.append(make("strong", title), make("p", description));
    if (["idle", "loading"].includes(catalogStatus)) state.setAttribute("aria-busy", "true");
    if (["error", "empty"].includes(catalogStatus) && onRetry) {
      const retry = make("button", undefined, "model-retry");
      retry.type = "button";
      retry.dataset.modelRetry = "";
      retry.disabled = locked;
      retry.append(icon("rotate-ccw"), make("span", "重新读取"));
      retry.addEventListener("click", () => onRetry());
      state.append(retry);
    }
    container.replaceChildren(heading, state);
    return;
  }
  const details = make("details", undefined, "model-picker");
  const summary = make("summary");
  summary.append(make("span", status.model?.displayName || status.model?.model || selection?.modelProfileId || "选择模型", "model-picker-current"), icon("chevron-down", "model-picker-chevron"));
  summary.setAttribute("aria-label", "选择本次编辑模型");
  summary.setAttribute("aria-expanded", "false");
  summary.setAttribute("aria-controls", "editor-model-options");
  summary.setAttribute("aria-disabled", String(locked));
  const panel = make("div", undefined, "model-picker-menu");
  const searchField = make("label", undefined, "model-picker-search");
  const search = make("input");
  search.type = "search";
  search.autocomplete = "off";
  search.placeholder = "搜索名称、别名或供应商";
  search.setAttribute("aria-label", "搜索模型");
  searchField.append(icon("search"), search);
  const list = make("div", undefined, "model-picker-options");
  list.id = "editor-model-options";
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", "已配置模型");
  const empty = make("p", "没有匹配的模型，请尝试其他名称", "model-picker-empty");
  empty.setAttribute("role", "status");
  empty.hidden = true;
  for (const model of models) {
    const itemStatus = modelSelectionStatus({ authMode: "apikey", modelProfileId: model.id }, models);
    const button = make("button");
    button.type = "button";
    button.dataset.profile = model.id;
    button.dataset.search = [model.displayName, model.model, model.id, model.provider, model.providerDisplayName, ...(model.aliases || [])].join(" ").normalize("NFKC").toLowerCase();
    button.disabled = locked || itemStatus.blocked;
    button.setAttribute("aria-pressed", String(model.id === selection?.modelProfileId));
    button.title = model.id;
    const copy = make("span", undefined, "model-option-copy");
    const name = make("span", undefined, "model-option-name");
    name.append(make("strong", model.displayName || model.model));
    if (model.isDefault) name.append(make("span", "默认", "model-default-badge"));
    copy.append(name, make("small", `${model.providerDisplayName || model.provider} · ${model.model}`));
    if (itemStatus.blocked) copy.append(make("small", itemStatus.label, "model-option-warning"));
    button.append(copy, icon("check", "model-option-check"));
    button.addEventListener("click", () => {
      if (button.disabled) return;
      details.open = false;
      summary.focus();
      onChange({ authMode: "apikey", modelProfileId: model.id, ...(model.selectionFingerprint ? { selectionFingerprint: model.selectionFingerprint } : {}) });
      container.querySelector("summary")?.focus();
    });
    list.append(button);
  }
  search.addEventListener("input", () => {
    const query = search.value.normalize("NFKC").trim().toLowerCase();
    const buttons = [...list.children];
    for (const button of buttons) button.hidden = !button.dataset.search.includes(query);
    empty.hidden = buttons.some((button) => !button.hidden);
  });
  details.addEventListener("toggle", () => { summary.setAttribute("aria-expanded", String(details.open)); if (details.open) search.focus(); });
  summary.addEventListener("click", (event) => { if (locked) event.preventDefault(); });
  details.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); details.open = false; summary.focus(); }
    if (details.open && ((["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && !(doc.activeElement === search && ["Home", "End"].includes(event.key))) || (event.key === "Enter" && doc.activeElement === search))) {
      const buttons = [...list.children].filter((item) => !item.hidden && !item.disabled);
      if (!buttons.length) return;
      event.preventDefault();
      if (event.key === "Enter") { buttons[0].click(); return; }
      const index = buttons.indexOf(doc.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : index < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1)
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
      buttons[next].scrollIntoView?.({ block: "nearest" });
    }
  });
  details.addEventListener("focusout", (event) => { if (event.relatedTarget && !details.contains(event.relatedTarget)) details.open = false; });
  panel.append(searchField, list, empty);
  details.append(summary, panel);
  const note = make("p", status.blocked ? status.label : "仅用于本次修改，不更改默认模型", "model-picker-note");
  note.setAttribute("role", "status");
  if (status.blocked) note.dataset.tone = "warning";
  container.replaceChildren(heading, details, note);
  if (status.model) {
    const fields = Object.entries(status.model.parameterFields || {});
    if (fields.length) {
      const advanced = make("details", undefined, "model-parameters");
      advanced.open = Boolean(parametersOpen);
      const parameterSummary = make("summary");
      parameterSummary.append(icon("sliders-horizontal"), make("span", "本次模型参数"), icon("chevron-down", "model-picker-chevron"));
      advanced.append(parameterSummary);
      for (const [id, field] of fields) {
        const wrapper = make("label", undefined, "model-parameter");
        wrapper.append(make("span", field.title || id));
        const value = field.path.reduce((object, key) => object?.[key], selection.parameters || status.model.parameters || {}) ?? field.default;
        const input = make("input");
        input.dataset.parameterId = id;
        input.type = field.type === "boolean" ? "checkbox" : ["number", "integer"].includes(field.type) ? "number" : "text";
        if (input.type === "checkbox") input.checked = Boolean(value);
        else input.value = value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
        if (field.minimum !== undefined) input.min = String(field.minimum);
        if (field.maximum !== undefined) input.max = String(field.maximum);
        if (input.type === "number") input.step = field.type === "integer" ? "1" : "any";
        input.disabled = locked;
        input.title = field.description || field.title || id;
        if (Array.isArray(field.enum) && ["string", "number", "integer"].includes(field.type)) {
          const suggestions = make("datalist");
          suggestions.id = `model-param-${encodeURIComponent(id)}`;
          for (const value of field.enum) { const option = make("option"); option.value = String(value); suggestions.append(option); }
          input.setAttribute("list", suggestions.id);
          wrapper.append(suggestions);
        }
        input.addEventListener("change", () => {
          if (!input.checkValidity()) { input.reportValidity(); return; }
          let next;
          try {
            next = input.type === "checkbox" ? input.checked : input.type === "number" ? (input.value === "" ? undefined : Number(input.value))
              : ["object", "array"].includes(field.type) ? (input.value ? JSON.parse(input.value) : undefined) : (input.value || undefined);
          } catch { input.setCustomValidity("请输入有效的 JSON"); input.reportValidity(); return; }
          input.setCustomValidity("");
          const parameters = structuredClone(selection.parameters || status.model.parameters || {});
          let target = parameters;
          for (const key of field.path.slice(0, -1)) { if (!target[key] || typeof target[key] !== "object") target[key] = {}; target = target[key]; }
          const last = field.path.at(-1);
          if (next === undefined) delete target[last]; else target[last] = next;
          onChange({ ...selection, parameters });
        });
        input.addEventListener("input", () => input.setCustomValidity(""));
        wrapper.append(input);
        advanced.append(wrapper);
      }
      container.append(advanced);
      if (focusedParameter) [...advanced.querySelectorAll("input")].find((input) => input.dataset.parameterId === focusedParameter)?.focus();
    }
  }
}
