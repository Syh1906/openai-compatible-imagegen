import assert from "node:assert/strict";
import test from "node:test";

import { createEditorDraftSaveQueue } from "../../web/editor-draft-save-queue.mjs";

test("draft save queue debounces changes and saves only the latest snapshot", async () => {
  const timers = new Map();
  const saves = [];
  let nextTimerId = 1;
  const queue = createEditorDraftSaveQueue({
    save: async (draft) => { saves.push(structuredClone(draft)); },
    delayMs: 400,
    setTimeoutFn: (callback) => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeoutFn: (id) => timers.delete(id),
  });

  queue.track({ annotations: [], prompt: "" });
  queue.track({ annotations: [], prompt: "第一版" });
  queue.track({ annotations: [], prompt: "第二版" });

  assert.equal(saves.length, 0);
  assert.equal(timers.size, 1);
  const callback = [...timers.values()][0];
  timers.clear();
  callback();
  await queue.whenIdle();

  assert.deepEqual(saves, [{ annotations: [], prompt: "第二版" }]);
});

test("flush bypasses a pending debounce timer", async () => {
  const saves = [];
  let timerCleared = false;
  const queue = createEditorDraftSaveQueue({
    save: async (draft) => { saves.push(structuredClone(draft)); },
    setTimeoutFn: () => 17,
    clearTimeoutFn: (id) => { timerCleared = id === 17; },
  });

  queue.track({ annotations: [], prompt: "" });
  queue.track({ annotations: [], prompt: "尚未到防抖时间" });
  await queue.flush();

  assert.equal(timerCleared, true);
  assert.deepEqual(saves, [{ annotations: [], prompt: "尚未到防抖时间" }]);
});

test("a change during an in-flight save is serialized after the older snapshot", async () => {
  const saves = [];
  let releaseFirstSave;
  const firstSave = new Promise((resolve) => { releaseFirstSave = resolve; });
  const queue = createEditorDraftSaveQueue({
    save: async (draft) => {
      saves.push(structuredClone(draft));
      if (saves.length === 1) await firstSave;
    },
    setTimeoutFn: () => 23,
    clearTimeoutFn: () => {},
  });

  queue.track({ annotations: [], prompt: "" });
  queue.track({ annotations: [], prompt: "第一版" });
  const flushing = queue.flush();
  await Promise.resolve();
  queue.track({ annotations: [{ id: "rectangle_1" }], prompt: "第二版" });
  releaseFirstSave();
  await flushing;

  assert.deepEqual(saves, [
    { annotations: [], prompt: "第一版" },
    { annotations: [{ id: "rectangle_1" }], prompt: "第二版" },
  ]);
});

test("discard cancels a debounced snapshot before an explicit canvas destroy", async () => {
  const saves = [];
  let timerCleared = false;
  const queue = createEditorDraftSaveQueue({
    save: async (draft) => { saves.push(structuredClone(draft)); },
    setTimeoutFn: () => 41,
    clearTimeoutFn: (id) => { timerCleared = id === 41; },
  });

  queue.track({ annotations: [], prompt: "" });
  queue.track({ annotations: [], prompt: "即将销毁" });
  queue.discard();
  await queue.whenIdle();

  assert.equal(timerCleared, true);
  assert.deepEqual(saves, []);
});
