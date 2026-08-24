const AUTH_MODES = new Set(["apikey", "chatgpt"]);


export function createEditorAuthRoute(receipt) {
  if (
    !receipt
    || !AUTH_MODES.has(receipt.defaultAuthMode)
    || typeof receipt.apiKeyConfigured !== "boolean"
    || receipt.chatgptRequirement !== "codex_app_imagegen_handoff"
  ) {
    return null;
  }
  return Object.freeze({
    selectedAuthMode: receipt.defaultAuthMode,
    apiKeyConfigured: receipt.apiKeyConfigured,
    chatgptRequirement: receipt.chatgptRequirement,
  });
}


export function selectEditorAuthMode(route, authMode) {
  if (!route) throw new Error("auth route is unavailable");
  if (!AUTH_MODES.has(authMode)) throw new Error("auth mode is invalid");
  return Object.freeze({ ...route, selectedAuthMode: authMode });
}


export function authRouteStatus(route) {
  if (!route) return { label: "路线信息暂不可用", tone: "neutral" };
  if (route.selectedAuthMode === "apikey") {
    return route.apiKeyConfigured
      ? { label: "API Key 已配置", tone: "success" }
      : { label: "需要配置", tone: "warning" };
  }
  return { label: "当前图片生成路线暂不支持画布编辑", tone: "warning" };
}
