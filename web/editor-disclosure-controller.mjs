export function createEditorDisclosureController({ root, wrapSelector, triggerSelector }) {
  let hovered = false;
  let focused = false;
  let pinned = false;
  let dismissed = false;

  function isOpen() {
    return pinned || (!dismissed && (hovered || focused));
  }

  function sync() {
    const wrap = root.querySelector(wrapSelector);
    const trigger = root.querySelector(triggerSelector);
    if (!wrap || !trigger) return;
    const open = isOpen();
    wrap.dataset.open = String(open);
    trigger.setAttribute("aria-expanded", String(open));
    root.querySelector(`#${trigger.getAttribute("aria-controls")}`)?.setAttribute("aria-hidden", String(!open));
  }

  function close() {
    if (!isOpen()) return false;
    pinned = false;
    dismissed = true;
    sync();
    return true;
  }

  function bind(signal) {
    const wrap = root.querySelector(wrapSelector);
    const trigger = root.querySelector(triggerSelector);
    hovered = false;
    focused = trigger === root.ownerDocument.activeElement;
    pinned = false;
    dismissed = false;
    sync();
    wrap?.addEventListener("mouseenter", () => { hovered = true; dismissed = false; sync(); }, { signal });
    wrap?.addEventListener("mouseleave", () => { hovered = false; if (!pinned) sync(); }, { signal });
    trigger?.addEventListener("focus", () => { focused = true; dismissed = false; sync(); }, { signal });
    trigger?.addEventListener("blur", () => { focused = false; if (!pinned) sync(); }, { signal });
    trigger?.addEventListener("click", (event) => {
      event.stopPropagation();
      if (pinned) {
        pinned = false;
        dismissed = true;
      } else {
        pinned = true;
        dismissed = false;
      }
      sync();
    }, { signal });
    wrap?.addEventListener("focusout", (event) => {
      if (!wrap.contains(event.relatedTarget)) {
        focused = false;
        pinned = false;
        dismissed = false;
        sync();
      }
    }, { signal });
  }

  return { bind, close };
}
