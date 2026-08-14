import { updateAnnotation } from "./editor-state.mjs";


export function createCanvasTextEditingController({ root, getEditor, setEditor, render, renderLayer, clearStatus, onStart, commitHistory, isActive = () => true }) {
  let cleanup = () => {};
  let editingBefore = null;

  function bind() {
    cleanup();
    root.addEventListener("input", handleInput);
    root.addEventListener("keydown", handleKeyDown);
    root.addEventListener("focusout", handleFocusOut);
    cleanup = () => {
      root.removeEventListener("input", handleInput);
      root.removeEventListener("keydown", handleKeyDown);
      root.removeEventListener("focusout", handleFocusOut);
    };
  }

  function start(id) {
    const editor = getEditor();
    const selected = editor.annotations.find((item) => item.id === id && item.type === "text");
    if (!selected) return;
    if (editor.editingTextAnnotationId === id) return;
    if (editor.editingTextAnnotationId) finish({ renderNow: false });
    const current = getEditor();
    editingBefore = { ...current, editingTextAnnotationId: null };
    setEditor({ ...current, selectedAnnotationId: id, editingTextAnnotationId: id });
    onStart();
    render();
    const field = root.querySelector(`[data-canvas-text-editor="${id}"]`);
    field?.focus({ preventScroll: true });
    field?.select();
  }

  function finish({ renderNow = true } = {}) {
    const editor = getEditor();
    if (!editor.editingTextAnnotationId) return;
    const before = editingBefore;
    const id = editor.editingTextAnnotationId;
    editingBefore = null;
    setEditor({ ...editor, editingTextAnnotationId: null });
    if (before && annotationText(before, id) !== annotationText(editor, id)) commitHistory(before);
    if (renderNow) render();
  }

  function handleInput(event) {
    const field = event.target.closest("[data-canvas-text-editor]");
    if (!field) return;
    const id = field.dataset.canvasTextEditor;
    setEditor(updateAnnotation(getEditor(), id, { text: field.value }));
    clearStatus();
    const sideField = [...root.querySelectorAll("[data-annotation-text]")].find((item) => item.dataset.annotationText === id);
    if (sideField) sideField.value = field.value;
    const count = sideField?.closest("[data-annotation-id]")?.querySelector("[data-annotation-count]");
    if (count) count.textContent = `${field.value.length}/600`;
  }

  function handleKeyDown(event) {
    if (!event.target.closest("[data-canvas-text-editor]") || !["Enter", "Escape"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    finish();
  }

  function handleFocusOut(event) {
    if (!event.target.closest("[data-canvas-text-editor]")) return;
    finish({ renderNow: false });
    queueMicrotask(() => {
      if (isActive() && !getEditor().editingTextAnnotationId) renderLayer();
    });
  }

  return { bind, start, finish, dispose: () => { editingBefore = null; cleanup(); } };
}

function annotationText(editor, id) {
  return editor.annotations.find((item) => item.id === id)?.text || "";
}
