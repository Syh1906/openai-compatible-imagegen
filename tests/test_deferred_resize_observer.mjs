import assert from "node:assert/strict";
import test from "node:test";

import { createDeferredResizeObserver } from "../web/deferred-resize-observer.mjs";


test("resize delivery schedules one deferred geometry update", () => {
  const frames = [];
  const cancelled = [];
  const observed = [];
  let resizeCallback = null;
  let updates = 0;
  class TestResizeObserver {
    constructor(callback) {
      resizeCallback = callback;
    }
    observe(target) {
      observed.push(target);
    }
    disconnect() {}
  }
  const coordinator = createDeferredResizeObserver({
    ResizeObserverClass: TestResizeObserver,
    requestFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame(id) {
      cancelled.push(id);
    },
    onResize() {
      updates += 1;
    },
  });
  const target = {};

  coordinator.observe(target);
  resizeCallback();
  resizeCallback();
  assert.deepEqual(observed, [target]);
  assert.equal(updates, 0);
  assert.equal(frames.length, 1);

  frames[0]();
  assert.equal(updates, 1);
  coordinator.disconnect();
  assert.deepEqual(cancelled, []);
});

test("disconnect cancels a pending geometry update", () => {
  let resizeCallback = null;
  const cancelled = [];
  class TestResizeObserver {
    constructor(callback) {
      resizeCallback = callback;
    }
    observe() {}
    disconnect() {}
  }
  const coordinator = createDeferredResizeObserver({
    ResizeObserverClass: TestResizeObserver,
    requestFrame() { return 17; },
    cancelFrame(id) { cancelled.push(id); },
    onResize() {},
  });

  coordinator.observe({});
  resizeCallback();
  coordinator.disconnect();
  assert.deepEqual(cancelled, [17]);
});
