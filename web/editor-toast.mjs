export function createEditorToast({ root, window, isActive, onFallback, localize = (value) => value }) {
  let dismissalTimer = null;

  function show(message) {
    const element = root.querySelector("[data-toast]");
    if (!element) {
      onFallback(message);
      return;
    }
    element.textContent = localize(message);
    element.classList.add("visible");
    if (dismissalTimer !== null) window.clearTimeout(dismissalTimer);
    dismissalTimer = window.setTimeout(() => {
      dismissalTimer = null;
      if (isActive()) element.classList.remove("visible");
    }, 2800);
  }

  function dispose() {
    if (dismissalTimer !== null) window.clearTimeout(dismissalTimer);
    dismissalTimer = null;
  }

  return { show, dispose };
}
