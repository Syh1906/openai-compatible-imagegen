export function createHostDisplayModeController({
  app,
  isActive = () => true,
  getRole,
  setRole,
  getDisplayMode,
  getHostReady,
  getAvailableModes,
  setAvailableModes,
  setDisplayMode,
  setStatus,
  render,
}) {
  return Object.freeze({ applyContext, request });

  function applyContext(context, { initializeRole = false } = {}) {
    let changed = false;
    if (initializeRole) {
      const nextRole = context?.toolInfo?.tool?.name === "open_image_editor" ? "editor" : "result";
      if (nextRole !== getRole()) {
        setRole(nextRole);
        changed = true;
      }
    }
    if (context?.displayMode && context.displayMode !== getDisplayMode()) {
      setDisplayMode(context.displayMode);
      changed = true;
    }
    if (Array.isArray(context?.availableDisplayModes)
      && !sameValues(context.availableDisplayModes, getAvailableModes())) {
      setAvailableModes(context.availableDisplayModes);
      changed = true;
    }
    return changed;
  }

  async function request(mode) {
    if (!isActive()) return false;
    if (!getHostReady()) {
      setStatus("宿主尚未连接，暂时无法打开画布", "error");
      render();
      return false;
    }
    if (!getAvailableModes().includes(mode)) {
      setStatus(
        mode === "fullscreen" ? "当前 Codex App 不支持展开画布" : "当前 Codex App 不支持返回内联视图",
        "error",
      );
      render();
      return false;
    }
    try {
      const result = await app.requestDisplayMode({ mode });
      if (!isActive()) return false;
      const matches = result.mode === mode;
      setDisplayMode(result.mode);
      setStatus(matches ? "" : "宿主未切换到请求的显示模式", matches ? "neutral" : "error");
      render();
      return matches;
    } catch (error) {
      if (!isActive()) return false;
      setStatus("画布显示模式切换失败", "error");
      render();
      return false;
    }
  }
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
