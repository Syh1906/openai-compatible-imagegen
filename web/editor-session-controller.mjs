export const EDITOR_SESSION_SETTLED_TOMBSTONE_LIMIT = 256;

export function createEditorSessionController({
  app,
  onDestroyed = async () => {},
  onError = () => {},
  setIntervalFn = globalThis.setInterval?.bind(globalThis),
  clearIntervalFn = globalThis.clearInterval?.bind(globalThis),
  pollIntervalMs = 2000,
}) {
  let sessionId = "";
  let imageId = "";
  let timer = null;
  let activeCheck = null;
  const pendingSessions = new Map();
  const settledSessions = new Map();
  let lifecycleGeneration = 0;
  let sessionGeneration = 0;
  let uiOwnerSessionId = "";

  const controller = {
    get id() {
      return sessionId;
    },

    get imageId() {
      return imageId;
    },

    isUiOwner(id) {
      return Boolean(id) && id === uiOwnerSessionId;
    },

    adopt(session) {
      if (!session?.id || isRetiredSession(session.id)) return false;
      const changedSession = session.id !== sessionId;
      if (changedSession) sessionGeneration += 1;
      if (uiOwnerSessionId && uiOwnerSessionId !== session.id) retireSession(uiOwnerSessionId);
      sessionId = session.id;
      uiOwnerSessionId = session.id;
      if (session.imageId) imageId = session.imageId;
      return true;
    },

    async ensure(requestedImageId) {
      const lifecycle = lifecycleGeneration;
      if (sessionId) {
        const id = sessionId;
        const generation = sessionGeneration;
        const current = await app.callServerTool({
          name: "get_image_editor_session",
          arguments: { editorSessionId: id },
        });
        if (!isCurrentRequest(lifecycle, id, generation)) return emptyEnsureResult();
        if (current.isError) {
          if (hasErrorCode(current, "editor_session_not_found")) {
            retireSession(id);
            resetLocalSession({ preserveLifecycle: true });
          } else {
            throw new Error("editor session state unavailable");
          }
        }
        if (sessionId) {
          const session = current.structuredContent?.editorSession;
          if (session?.status === "active" && session.imageId === requestedImageId) {
            controller.adopt(session);
            return { opened: false, result: current, session };
          }
          if (session?.status === "active" || session?.status === "destroyed") {
            await finalizeSession(id, generation);
            if (!isCurrent(lifecycle) || sessionId) return emptyEnsureResult();
          } else {
            throw new Error("editor session state unavailable");
          }
        }
      }

      const result = await app.callServerTool({
        name: "open_image_editor",
        arguments: { imageId: requestedImageId },
      });
      const session = result.structuredContent?.editorSession;
      if (result.isError || !session?.id) throw new Error("editor session open failed");
      if (!isCurrent(lifecycle) || sessionId) {
        if (session.id !== sessionId) await releaseLateSession(session.id);
        return emptyEnsureResult();
      }
      if (!controller.adopt(session)) throw new Error("editor session open failed");
      return { opened: true, result, session };
    },

    async destroy() {
      if (!sessionId) return false;
      const id = sessionId;
      const generation = sessionGeneration;
      const result = await app.callServerTool({
        name: "destroy_image_editor",
        arguments: { editorSessionId: id },
      });
      const existingTransition = getDestroyedTransition(id, generation);
      if (existingTransition) {
        await existingTransition;
        return true;
      }
      if (!isCurrentSession(id, generation)) return false;
      if (result.isError) {
        if (hasErrorCode(result, "editor_session_not_found")) {
          retireSession(id);
          resetLocalSession();
          return false;
        }
        throw new Error("editor session destroy failed");
      }
      const status = result.structuredContent?.editorSession?.status;
      if (status === "released") {
        retireSession(id);
        resetLocalSession();
        return false;
      }
      if (status !== "destroyed") throw new Error("editor session destroy failed");
      return await notifyDestroyed(id, generation);
    },

    async finalize() {
      if (!sessionId) return false;
      const id = sessionId;
      const generation = sessionGeneration;
      controller.stop();
      return await finalizeSession(id, generation);
    },

    start(initialStatus = "active") {
      if (!sessionId) return;
      if (initialStatus === "destroyed") {
        const id = sessionId;
        const generation = sessionGeneration;
        void notifyDestroyed(id, generation).catch((error) => {
          reportSessionErrorOnce(id, generation, error);
        });
        return;
      }
      if (timer !== null || !setIntervalFn) return;
      void runCheck();
      timer = setIntervalFn(runCheck, pollIntervalMs);
    },

    stop() {
      lifecycleGeneration += 1;
      if (timer !== null && clearIntervalFn) clearIntervalFn(timer);
      timer = null;
    },

    async checkStatus() {
      if (!sessionId) return null;
      const lifecycle = lifecycleGeneration;
      const id = sessionId;
      const generation = sessionGeneration;
      const result = await app.callServerTool({
        name: "get_image_editor_session",
        arguments: { editorSessionId: id },
      });
      const session = result.structuredContent?.editorSession;
      if (session?.status === "destroyed") {
        const notified = await notifyDestroyed(id, generation, lifecycle);
        return notified ? "destroyed" : null;
      }
      if (!isCurrentRequest(lifecycle, id, generation)) return null;
      if (result.isError) {
        if (!hasErrorCode(result, "editor_session_not_found") || !imageId) {
          throw new Error("editor session state unavailable");
        }
        const staleImageId = imageId;
        retireSession(id);
        resetLocalSession({ preservePolling: true });
        const recovered = await controller.ensure(staleImageId);
        if (!isCurrent(lifecycle)) return null;
        return recovered.session?.status || null;
      }
      return session?.status || null;
    },
  };

  async function notifyDestroyed(id, generation, lifecycle = lifecycleGeneration) {
    const existing = getDestroyedTransition(id, generation);
    if (existing) {
      await existing;
      return true;
    }
    if (!isCurrentRequest(lifecycle, id, generation)) return false;
    const destroyedImageId = imageId;
    controller.stop();
    const terminal = beginPendingSession(id, generation);
    terminal.transitionPending = true;
    const promise = Promise.resolve().then(() => onDestroyed({
      sessionId: id,
      imageId: destroyedImageId,
      isUiOwner: () => controller.isUiOwner(id),
      finalize: () => finalizeSession(id, generation),
    }));
    terminal.transitionPromise = promise;
    const settleTransition = () => {
      terminal.transitionPending = false;
      settleSession(id, terminal);
    };
    void promise.then(
      settleTransition,
      (error) => {
        terminal.transitionRejected = true;
        terminal.transitionError = error;
        settleTransition();
      },
    );
    await promise;
    return true;
  }

  function getDestroyedTransition(id, generation) {
    const terminal = getRetiredSession(id);
    return terminal?.generation === generation ? terminal.transitionPromise : null;
  }

  function isDestroyedTransitionFailure(id, generation, error) {
    const terminal = getRetiredSession(id);
    return terminal?.generation === generation
      && terminal.transitionRejected
      && Object.is(terminal.transitionError, error);
  }

  async function runCheck() {
    if (!sessionId) return;
    const attempt = {
      lifecycle: lifecycleGeneration,
      id: sessionId,
      generation: sessionGeneration,
    };
    if (activeCheck && sameRequest(activeCheck, attempt)) return;
    activeCheck = attempt;
    try {
      await controller.checkStatus();
      if (!isCurrentRequest(attempt.lifecycle, attempt.id, attempt.generation)) return;
    } catch (error) {
      if (!isCurrentRequest(attempt.lifecycle, attempt.id, attempt.generation)
        && (!controller.isUiOwner(attempt.id)
          || !isDestroyedTransitionFailure(attempt.id, attempt.generation, error))) return;
      controller.stop();
      reportSessionErrorOnce(attempt.id, attempt.generation, error);
    } finally {
      if (activeCheck === attempt) activeCheck = null;
    }
  }

  function isCurrent(generation) {
    return generation === lifecycleGeneration;
  }

  function isCurrentSession(id, generation) {
    return id === sessionId && generation === sessionGeneration;
  }

  function isCurrentRequest(lifecycle, id, generation) {
    return isCurrent(lifecycle) && isCurrentSession(id, generation);
  }

  function finalizeSession(id, generation) {
    const existing = getRetiredSession(id);
    if (existing?.generation === generation && existing.finalizePromise) {
      return existing.finalizePromise;
    }

    const terminal = beginPendingSession(id, generation);
    terminal.finalizePending = true;
    const promise = (async () => {
      const result = await app.callServerTool({
        name: "finalize_image_editor_session",
        arguments: { editorSessionId: id },
      });
      if (result.isError) throw new Error("editor session release failed");
      if (sessionId === id && sessionGeneration === generation) {
        resetLocalSession({ preserveLifecycle: true });
      }
      return true;
    })();
    terminal.finalizePromise = promise;
    const settleFinalize = () => {
      terminal.finalizePending = false;
      settleSession(id, terminal);
    };
    void promise.then(settleFinalize, settleFinalize);
    return promise;
  }

  async function releaseLateSession(id) {
    const existing = getRetiredSession(id);
    if (existing?.finalizePromise) return await existing.finalizePromise;
    const terminal = beginPendingSession(id, null);
    terminal.finalizePending = true;
    const promise = (async () => {
      const result = await app.callServerTool({
        name: "finalize_image_editor_session",
        arguments: { editorSessionId: id },
      });
      if (result.isError) throw new Error("editor session release failed");
      return true;
    })();
    terminal.finalizePromise = promise;
    const settleFinalize = () => {
      terminal.finalizePending = false;
      settleSession(id, terminal);
    };
    void promise.then(settleFinalize, settleFinalize);
    return await promise;
  }

  function resetLocalSession({ preservePolling = false, preserveLifecycle = false } = {}) {
    if (!preservePolling) {
      if (preserveLifecycle) clearPolling();
      else controller.stop();
    }
    sessionId = "";
    imageId = "";
    sessionGeneration += 1;
  }

  function clearPolling() {
    if (timer !== null && clearIntervalFn) clearIntervalFn(timer);
    timer = null;
  }

  function retireSession(id) {
    if (!id) return;
    const existing = getRetiredSession(id);
    if (existing) return;
    addSettledSession(id, createSessionRecord(null));
  }

  function isRetiredSession(id) {
    return pendingSessions.has(id) || settledSessions.has(id);
  }

  function getRetiredSession(id) {
    return pendingSessions.get(id) || settledSessions.get(id);
  }

  function beginPendingSession(id, generation) {
    const existing = getRetiredSession(id);
    if (existing) {
      if (existing.generation === null && generation !== null) existing.generation = generation;
      if (settledSessions.delete(id)) pendingSessions.set(id, existing);
      return existing;
    }
    const terminal = createSessionRecord(generation);
    pendingSessions.set(id, terminal);
    return terminal;
  }

  function settleSession(id, terminal) {
    if (terminal.transitionPending || terminal.finalizePending) return;
    if (pendingSessions.get(id) !== terminal) return;
    pendingSessions.delete(id);
    addSettledSession(id, terminal);
  }

  function addSettledSession(id, terminal) {
    settledSessions.delete(id);
    settledSessions.set(id, terminal);
    while (settledSessions.size > EDITOR_SESSION_SETTLED_TOMBSTONE_LIMIT) {
      const oldestId = settledSessions.keys().next().value;
      settledSessions.delete(oldestId);
    }
  }

  function reportSessionErrorOnce(id, generation, error) {
    const terminal = getRetiredSession(id);
    if (terminal?.generation === generation) {
      if (terminal.errorReported) return;
      terminal.errorReported = true;
    }
    onError(error);
  }

  return controller;
}

function sameRequest(left, right) {
  return left.lifecycle === right.lifecycle
    && left.id === right.id
    && left.generation === right.generation;
}

function createSessionRecord(generation) {
  return {
    generation,
    transitionPromise: null,
    finalizePromise: null,
    transitionPending: false,
    finalizePending: false,
    transitionRejected: false,
    transitionError: undefined,
    errorReported: false,
  };
}

function emptyEnsureResult() {
  return { opened: false, result: null, session: null };
}

function hasErrorCode(result, code) {
  if (!result?.isError || !Array.isArray(result.content)) return false;
  return result.content.some((item) => (
    item?.type === "text"
    && typeof item.text === "string"
    && (item.text === code || item.text.startsWith(`${code}:`))
  ));
}
