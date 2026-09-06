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
  const pendingRequests = new Map();
  const expectedContexts = new Map();
  const contextWaiters = new Map();
  return Object.freeze({ applyContext, consumeRequestedContext, request });

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
    if (context?.displayMode) {
      for (const resolve of contextWaiters.get(context.displayMode) || []) {
        resolve({ mode: context.displayMode });
      }
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
    if (getDisplayMode() === mode && !pendingRequests.has(mode)) {
      setStatus("", "neutral");
      return true;
    }
    setRequestPending(mode, 1);
    setExpectedContext(mode, 1);
    let resolveContext;
    const contextChanged = new Promise((resolve) => { resolveContext = resolve; });
    const waiters = contextWaiters.get(mode) || new Set();
    waiters.add(resolveContext);
    contextWaiters.set(mode, waiters);
    let requestSucceeded = false;
    try {
      // The host may publish its actual display mode before replying to the request.
      // Either confirmation can release rendering; a late reply must not rewind it.
      const result = await Promise.race([app.requestDisplayMode({ mode }), contextChanged]);
      if (!isActive()) return false;
      requestSucceeded = true;
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
    } finally {
      waiters.delete(resolveContext);
      if (!waiters.size) contextWaiters.delete(mode);
      setRequestPending(mode, -1);
      if (requestSucceeded) {
        setTimeout(() => setExpectedContext(mode, -1), 0);
      } else {
        setExpectedContext(mode, -1);
      }
    }
  }

  function consumeRequestedContext(mode) {
    if ((expectedContexts.get(mode) || 0) < 1) return false;
    setExpectedContext(mode, -1);
    return true;
  }

  function setRequestPending(mode, delta) {
    const next = (pendingRequests.get(mode) || 0) + delta;
    if (next > 0) pendingRequests.set(mode, next);
    else pendingRequests.delete(mode);
  }

  function setExpectedContext(mode, delta) {
    const next = (expectedContexts.get(mode) || 0) + delta;
    if (next > 0) expectedContexts.set(mode, next);
    else expectedContexts.delete(mode);
  }
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
