import assert from "node:assert/strict";
import test from "node:test";

import { createFrameCoalescer } from "../../web/frame-coalescer.mjs";


test("frame coalescer batches pointer samples into one scheduled update", () => {
  const scheduled = [];
  const flushed = [];
  const coalescer = createFrameCoalescer({
    requestFrame(callback) {
      scheduled.push(callback);
      return scheduled.length;
    },
    cancelFrame() {},
    onFrame(samples) {
      flushed.push(samples);
    },
  });

  coalescer.push({ x: 1 });
  coalescer.push({ x: 2 });
  coalescer.push({ x: 3 });
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  assert.deepEqual(flushed, [[{ x: 1 }, { x: 2 }, { x: 3 }]]);
});

test("flushNow commits pending samples once and cancel discards them", () => {
  const cancelled = [];
  const flushed = [];
  const coalescer = createFrameCoalescer({
    requestFrame() { return 9; },
    cancelFrame(id) { cancelled.push(id); },
    onFrame(samples) { flushed.push(samples); },
  });

  coalescer.push("first");
  coalescer.flushNow();
  coalescer.push("discarded");
  coalescer.cancel();
  assert.deepEqual(cancelled, [9, 9]);
  assert.deepEqual(flushed, [["first"]]);
});
