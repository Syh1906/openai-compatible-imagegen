import assert from "node:assert/strict";
import test from "node:test";

import { createEditorSessionController } from "../web/editor-session-controller.mjs";


test("an active editor session saves one host-handoff draft through the App-only tool", async () => {
  const calls = [];
  const controller = createEditorSessionController({
    app: {
      async callServerTool(request) {
        calls.push(request);
        return {
          structuredContent: {
            editorSession: {
              id: "eds_00000000000000000000000000000001",
              imageId: "img_01J00000000000000000000000",
              status: "active",
            },
          },
        };
      },
    },
    setIntervalFn: null,
    clearIntervalFn: null,
  });
  controller.adopt({
    id: "eds_00000000000000000000000000000001",
    imageId: "img_01J00000000000000000000000",
    status: "active",
  });
  const draft = { annotations: [], prompt: "保留未发送的修改草稿" };

  assert.equal(await controller.saveDraft(draft), true);
  assert.deepEqual(calls, [{
    name: "save_image_editor_draft",
    arguments: {
      editorSessionId: "eds_00000000000000000000000000000001",
      draft,
    },
  }]);
});
