import assert from "node:assert/strict";
import test from "node:test";

import { createHostDisplayModeController } from "../web/editor-host-display.mjs";

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
