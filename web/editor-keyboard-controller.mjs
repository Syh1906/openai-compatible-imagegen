import { addAnnotation, updateAnnotation } from "./editor-state.mjs";
import {
  advanceKeyboardAnnotation,
  createKeyboardAnnotationState,
  keyboardAnnotationPreview,
  nudgeSelectedAnnotation,
} from "./editor-keyboard-annotation.mjs";


export function createEditorKeyboardController({
  renderer,
  getEditor,
  setEditor,
  hasPointerInteraction,
  isInteractionLocked,
  pushHistory,
  clearStatus,
  openIntentPanel,
  startTextEditing,
  render,
}) {
  let state = createKeyboardAnnotationState();

  function handleCanvasKeyDown(event) {
    const editor = getEditor();
    if (isInteractionLocked() || !event.target?.closest?.("[data-canvas]") || hasPointerInteraction() || editor.editingTextAnnotationId) return false;

    if (!state.drawing && editor.selectedAnnotationId) {
      const moved = nudgeSelectedAnnotation(editor, event);
      if (moved) {
        const visibleEditor = showAnnotations(editor);
        pushHistory(visibleEditor);
        setEditor(updateAnnotation(visibleEditor, moved.id, moved));
        clearStatus();
        render();
        return true;
      }
    }

    const result = advanceKeyboardAnnotation(state, event, editor);
    if (!result.handled) return false;
    const visibleEditor = showAnnotations(editor);
    const visibilityChanged = visibleEditor !== editor;
    if (visibilityChanged) setEditor(visibleEditor);
    state = result.state;
    if (!result.annotation) {
      if (visibilityChanged) render();
      else renderLayer();
      return true;
    }

    pushHistory(visibleEditor);
    setEditor(addAnnotation(visibleEditor, result.annotation));
    clearStatus();
    openIntentPanel();
    if (result.startTextEditing) startTextEditing(result.annotation.id);
    else render();
    return true;
  }

  function cancel({ renderNow = true } = {}) {
    if (!state.drawing) return false;
    state = { ...state, drawing: null, engaged: false };
    if (renderNow) render();
    return true;
  }

  function discard() {
    state = { ...state, drawing: null, engaged: false };
  }

  function renderLayer() {
    const editor = getEditor();
    const preview = keyboardAnnotationPreview(state, editor);
    if (preview) renderer.renderPreviewAnnotation(editor, preview, state);
    else renderer.renderAnnotationLayer(editor, state);
  }

  return {
    cancel,
    discard,
    handleCanvasKeyDown,
    hasDrawing: () => Boolean(state.drawing),
    renderLayer,
  };
}

function showAnnotations(editor) {
  return editor.annotationVisible ? editor : { ...editor, annotationVisible: true };
}
