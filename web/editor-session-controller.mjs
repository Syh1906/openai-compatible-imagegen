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
  let checkInFlight = false;
  let destroyedNotified = false;

  const controller = {
    get id() {
      return sessionId;
    },

    adopt(session) {
      if (!session?.id) return;
      const changedSession = session.id !== sessionId;
      sessionId = session.id;
      if (session.imageId) imageId = session.imageId;
      if (changedSession || session.status !== "destroyed") destroyedNotified = false;
    },

    async ensure(imageId) {
      if (sessionId) {
        const current = await app.callServerTool({
          name: "get_image_editor_session",
          arguments: { editorSessionId: sessionId },
        });
        if (current.isError) {
          if (hasErrorCode(current, "editor_session_not_found")) {
            resetLocalSession();
          } else {
            throw new Error("editor session state unavailable");
          }
        }
        if (sessionId) {
          const session = current.structuredContent?.editorSession;
          if (session?.status === "active" && session.imageId === imageId) {
            controller.adopt(session);
            return { opened: false, result: current, session };
          }
          if (session?.status === "active" || session?.status === "destroyed") {
            await controller.finalize();
          } else {
            throw new Error("editor session state unavailable");
          }
        }
      }

      const result = await app.callServerTool({
        name: "open_image_editor",
        arguments: { imageId },
      });
      const session = result.structuredContent?.editorSession;
      if (result.isError || !session?.id) throw new Error("editor session open failed");
      controller.adopt(session);
      return { opened: true, result, session };
    },

    async destroy() {
      if (!sessionId) return false;
      const result = await app.callServerTool({
        name: "destroy_image_editor",
        arguments: { editorSessionId: sessionId },
      });
      if (result.isError) {
        if (hasErrorCode(result, "editor_session_not_found")) {
          resetLocalSession();
          return true;
        }
        throw new Error("editor session destroy failed");
      }
      await controller.finalize();
      return true;
    },

    async finalize() {
      if (!sessionId) return false;
      const id = sessionId;
      const result = await app.callServerTool({
        name: "finalize_image_editor_session",
        arguments: { editorSessionId: id },
      });
      if (result.isError) throw new Error("editor session release failed");
      resetLocalSession();
      return true;
    },

    start(initialStatus = "active") {
      if (!sessionId) return;
      if (initialStatus === "destroyed") {
        void notifyDestroyed();
        return;
      }
      if (timer !== null || !setIntervalFn) return;
      void runCheck();
      timer = setIntervalFn(runCheck, pollIntervalMs);
    },

    stop() {
      if (timer !== null && clearIntervalFn) clearIntervalFn(timer);
      timer = null;
    },

    async checkStatus() {
      if (!sessionId) return null;
      const result = await app.callServerTool({
        name: "get_image_editor_session",
        arguments: { editorSessionId: sessionId },
      });
      if (result.isError) {
        if (!hasErrorCode(result, "editor_session_not_found") || !imageId) {
          throw new Error("editor session state unavailable");
        }
        const staleImageId = imageId;
        resetLocalSession();
        const recovered = await controller.ensure(staleImageId);
        return recovered.session.status;
      }
      const session = result.structuredContent?.editorSession;
      if (session?.status === "destroyed") await notifyDestroyed();
      return session?.status || null;
    },
  };

  async function notifyDestroyed() {
    if (destroyedNotified) return;
    destroyedNotified = true;
    controller.stop();
    await onDestroyed();
  }

  async function runCheck() {
    if (checkInFlight || !sessionId) return;
    checkInFlight = true;
    try {
      await controller.checkStatus();
    } catch (error) {
      controller.stop();
      onError(error);
    } finally {
      checkInFlight = false;
    }
  }

  function resetLocalSession() {
    controller.stop();
    sessionId = "";
    imageId = "";
    destroyedNotified = false;
  }

  return controller;
}

function hasErrorCode(result, code) {
  return result?.structuredContent?.error?.code === code;
}
