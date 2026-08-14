export function createFrameCoalescer({ requestFrame, cancelFrame, onFrame }) {
  let frameId = null;
  let samples = [];

  const flush = () => {
    frameId = null;
    if (!samples.length) return;
    const batch = samples;
    samples = [];
    onFrame(batch);
  };

  return {
    push(sample) {
      samples.push(sample);
      if (frameId === null) frameId = requestFrame(flush);
    },

    flushNow() {
      if (frameId !== null) cancelFrame(frameId);
      flush();
    },

    cancel() {
      if (frameId !== null) cancelFrame(frameId);
      frameId = null;
      samples = [];
    },
  };
}
