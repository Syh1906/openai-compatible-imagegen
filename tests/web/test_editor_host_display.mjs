import assert from "node:assert/strict";
import test from "node:test";

import { createHostDisplayModeController } from "../../web/editor-host-display.mjs";

test("host display context updates role and modes only when values change", () => {
  const state = {
    role: "result",
    displayMode: "inline",
    availableModes: [],
  };
  const controller = createHostDisplayModeController({
    app: {},
    getRole: () => state.role,
    setRole: (value) => { state.role = value; },
    getDisplayMode: () => state.displayMode,
    setDisplayMode: (value) => { state.displayMode = value; },
    getHostReady: () => false,
    getAvailableModes: () => state.availableModes,
    setAvailableModes: (value) => { state.availableModes = value; },
    setStatus: () => {},
    render: () => {},
  });

  assert.equal(controller.applyContext({
    toolInfo: { tool: { name: "open_image_editor" } },
    displayMode: "fullscreen",
    availableDisplayModes: ["inline", "fullscreen"],
  }, { initializeRole: true }), true);
  assert.deepEqual(state, {
    role: "editor",
    displayMode: "fullscreen",
    availableModes: ["inline", "fullscreen"],
  });

  const existingModes = state.availableModes;
  assert.equal(controller.applyContext({
    displayMode: "fullscreen",
    availableDisplayModes: ["inline", "fullscreen"],
  }), false);
  assert.equal(state.availableModes, existingModes);
});

test("a confirmed host context releases the request and ignores a late reply", async () => {
  for (const lateFailure of [false, true]) {
    let resolveReply;
    let rejectReply;
    let displayMode = "inline";
    let status = "";
    const controller = createHostDisplayModeController({
      app: { requestDisplayMode: () => new Promise((resolve, reject) => {
        resolveReply = resolve;
        rejectReply = reject;
      }) },
      getRole: () => "result",
      setRole: () => {},
      getDisplayMode: () => displayMode,
      setDisplayMode: (value) => { displayMode = value; },
      getHostReady: () => true,
      getAvailableModes: () => ["inline", "fullscreen"],
      setAvailableModes: () => {},
      setStatus: (value) => { status = value; },
      render: () => {},
    });
    const opening = controller.request("fullscreen");
    assert.equal(controller.consumeRequestedContext("fullscreen"), true);
    controller.applyContext({ displayMode: "fullscreen" });
    assert.equal(await opening, true);
    controller.applyContext({ displayMode: "inline" });
    if (lateFailure) rejectReply(new Error("late transport failure"));
    else resolveReply({ mode: "fullscreen" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(displayMode, "inline");
    assert.equal(status, "");
  }
});
