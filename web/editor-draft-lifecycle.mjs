import { normalizeEditorColorState, normalizeMaskOperationState } from "./editor-state.mjs";
import { createEditorDraftSaveQueue } from "./editor-draft-save-queue.mjs";

export function createEditorDraftLifecycle({
  window,
  document,
  sessionController,
  draftRegistry,
  getEditor,
  setEditor,
  getUndoStack,
  setUndoStack,
  getRedoStack,
  setRedoStack,
  isEligible,
  onError,
}) {
  const saveQueue = createEditorDraftSaveQueue({
    save: async (draft) => {
      const saved = await sessionController.saveDraft(draft);
      if (!saved) throw new Error("editor session draft save unavailable");
    },
    onError,
    setTimeoutFn: window.setTimeout.bind(window),
    clearTimeoutFn: window.clearTimeout.bind(window),
  });

  const lifecycle = {
    bind(signal) {
      window.addEventListener("blur", lifecycle.flushInBackground, { signal });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") lifecycle.flushInBackground();
      }, { signal });
    },

    track() {
      if (!isEligible()) return false;
      const editor = getEditor();
      return saveQueue.track({ annotations: editor.annotations, prompt: editor.prompt });
    },

    async flush() {
      lifecycle.track();
      await saveQueue.flush();
    },

    flushInBackground() {
      if (!isEligible()) return;
      lifecycle.track();
      void saveQueue.flush().catch(() => {});
    },

    discardServerDraft() {
      saveQueue.discard();
    },

    whenIdle() {
      return saveQueue.whenIdle();
    },

    saveWorking() {
      const editor = getEditor();
      if (!editor.image.id) return;
      draftRegistry.saveWorking(editor, { undoStack: getUndoStack(), redoStack: getRedoStack() });
    },

    restoreWorking(baseEditor) {
      const restored = draftRegistry.restore(baseEditor);
      setEditor(normalize(restored.editor));
      setUndoStack(restored.undoStack.map(normalize));
      setRedoStack(restored.redoStack.map(normalize));
    },

    restoreTransferred(draft) {
      if (!draft) return;
      setEditor(normalize({
        ...getEditor(),
        annotations: structuredClone(draft.annotations),
        prompt: draft.prompt,
        selectedAnnotationId: null,
        editingTextAnnotationId: null,
      }));
      setUndoStack([]);
      setRedoStack([]);
      lifecycle.saveWorking();
    },
  };

  return lifecycle;
}

function normalize(editor) {
  return normalizeMaskOperationState(normalizeEditorColorState(editor));
}
