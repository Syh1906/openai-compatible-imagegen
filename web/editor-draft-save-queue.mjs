export function createEditorDraftSaveQueue({
  save,
  onError = () => {},
  delayMs = 400,
  setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
}) {
  let currentKey = null;
  let latestDraft = null;
  let dirty = false;
  let timer = null;
  let inFlight = null;

  function clearTimer() {
    if (timer !== null && clearTimeoutFn) clearTimeoutFn(timer);
    timer = null;
  }

  function schedule() {
    clearTimer();
    if (inFlight || !setTimeoutFn) return;
    timer = setTimeoutFn(() => {
      timer = null;
      void startDrain().catch(onError);
    }, delayMs);
  }

  function startDrain() {
    if (inFlight) return inFlight;
    clearTimer();
    let failed = false;
    inFlight = (async () => {
      while (dirty) {
        dirty = false;
        const snapshot = structuredClone(latestDraft);
        try {
          await save(snapshot);
        } catch (error) {
          dirty = true;
          failed = true;
          throw error;
        }
      }
    })().finally(() => {
      inFlight = null;
      if (dirty && !failed) schedule();
    });
    return inFlight;
  }

  return {
    track(draft) {
      const snapshot = structuredClone(draft);
      const key = JSON.stringify(snapshot);
      latestDraft = snapshot;
      if (currentKey === null) {
        currentKey = key;
        return false;
      }
      if (key === currentKey) return false;
      currentKey = key;
      dirty = true;
      schedule();
      return true;
    },

    flush() {
      clearTimer();
      return dirty ? startDrain() : (inFlight || Promise.resolve());
    },

    discard() {
      clearTimer();
      dirty = false;
      currentKey = null;
      latestDraft = null;
    },

    whenIdle() {
      return inFlight || Promise.resolve();
    },
  };
}
