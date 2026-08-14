export function bindScopedClicks(root, bindings, signal) {
  for (const { selector, skip, handle } of bindings) {
    root.querySelectorAll(selector).forEach((element) => {
      if (skip?.(element)) return;
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        handle(element, event);
      }, { signal });
    });
  }
}
