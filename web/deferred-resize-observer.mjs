export function createDeferredResizeObserver({
  onResize,
  requestFrame,
  cancelFrame,
  ResizeObserverClass = globalThis.ResizeObserver,
}) {
  let observer = null;
  let observedTarget = null;
  let frameId = null;

  const flush = () => {
    frameId = null;
    onResize();
  };

  return {
    observe(target) {
      if (!target || target === observedTarget) return;
      this.disconnect();
      observedTarget = target;
      observer = new ResizeObserverClass(() => {
        if (frameId === null) frameId = requestFrame(flush);
      });
      observer.observe(target);
    },

    disconnect() {
      observer?.disconnect();
      observer = null;
      observedTarget = null;
      if (frameId !== null) cancelFrame(frameId);
      frameId = null;
    },
  };
}
