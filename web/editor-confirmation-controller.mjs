export function createEditorConfirmationController({
  root,
  dialogSelector,
  triggerSelector,
  cancelSelector,
  render,
  focusLastWhenMissing = false,
}) {
  let open = false;
  let trigger = null;

  function openDialog(event) {
    trigger = event?.currentTarget?.closest?.(triggerSelector)
      || event?.target?.closest?.(triggerSelector)
      || root.querySelector(triggerSelector);
    open = true;
    render();
    root.querySelector(cancelSelector)?.focus();
  }

  function close({ renderNow = true, restoreFocus = true, clearTrigger = true } = {}) {
    open = false;
    if (renderNow) render();
    if (restoreFocus) restoreTriggerFocus();
    else if (clearTrigger) trigger = null;
  }

  function restoreTriggerFocus() {
    const target = trigger?.isConnected
      ? trigger
      : root.querySelector(triggerSelector);
    trigger = null;
    target?.focus();
  }

  function moveFocus(direction) {
    const dialog = root.querySelector(dialogSelector);
    const controls = [...(dialog?.querySelectorAll?.("button:not(:disabled)") || [])];
    if (!controls.length) return;
    const current = controls.indexOf(root.ownerDocument?.activeElement || globalThis.document?.activeElement);
    const next = current < 0
      ? (focusLastWhenMissing && direction < 0 ? controls.length - 1 : 0)
      : (current + direction + controls.length) % controls.length;
    controls[next].focus();
  }

  function handleKeyDown(event) {
    if (!open) return false;
    if (event.key === "Escape") close();
    else if (event.key === "Tab") moveFocus(event.shiftKey ? -1 : 1);
    if (event.key === "Escape" || event.key === "Tab") event.preventDefault?.();
    return true;
  }

  return {
    close,
    handleKeyDown,
    isOpen: () => open,
    open: openDialog,
    restoreTriggerFocus,
  };
}
