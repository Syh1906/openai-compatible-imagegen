import assert from "node:assert/strict";
import test from "node:test";

import { createEditorSessionController } from "../web/editor-session-controller.mjs";


const IMAGE_ID = "img_01J00000000000000000000000";
const SESSION_ID = "eds_01J00000000000000000000000";

test("session controller opens once and reuses an active editor session", async () => {
  const calls = [];
  const app = {
    async callServerTool(request) {
      calls.push(request.name);
      if (request.name === "open_image_editor") {
        return { structuredContent: { editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "active" } } };
      }
      if (request.name === "get_image_editor_session") {
        return { structuredContent: { editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "active" } } };
      }
      throw new Error(`unexpected tool: ${request.name}`);
    },
  };
  const controller = createEditorSessionController({ app });

  const first = await controller.ensure(IMAGE_ID);
  const second = await controller.ensure(IMAGE_ID);

  assert.equal(first.opened, true);
  assert.equal(second.opened, false);
  assert.equal(controller.id, SESSION_ID);
  assert.deepEqual(calls, ["open_image_editor", "get_image_editor_session"]);
});

test("session controller replaces a stale server session before opening the image", async () => {
  const nextSessionId = "eds_01J00000000000000000000001";
  const calls = [];
  const app = {
    async callServerTool(request) {
      calls.push(request.name);
      if (request.name === "get_image_editor_session") {
        return {
          isError: true,
          structuredContent: {
            error: {
              code: "editor_session_not_found",
              message: "the editor session was released",
            },
          },
        };
      }
      if (request.name === "open_image_editor") {
        return {
          structuredContent: {
            editorSession: {
              id: nextSessionId,
              imageId: IMAGE_ID,
              status: "active",
            },
          },
        };
      }
      throw new Error(`unexpected tool: ${request.name}`);
    },
  };
  const controller = createEditorSessionController({ app });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  const result = await controller.ensure(IMAGE_ID);

  assert.equal(result.opened, true);
  assert.equal(controller.id, nextSessionId);
  assert.deepEqual(calls, ["get_image_editor_session", "open_image_editor"]);
});

test("session controller releases an active session before opening a different image", async () => {
  const nextImageId = "img_01J00000000000000000000001";
  const nextSessionId = "eds_01J00000000000000000000001";
  const calls = [];
  const app = {
    async callServerTool(request) {
      calls.push({ name: request.name, arguments: request.arguments });
      if (request.name === "get_image_editor_session") {
        return { structuredContent: { editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "active" } } };
      }
      if (request.name === "finalize_image_editor_session") {
        return { structuredContent: { editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "released" } } };
      }
      if (request.name === "open_image_editor") {
        return { structuredContent: { editorSession: { id: nextSessionId, imageId: nextImageId, status: "active" } } };
      }
      throw new Error(`unexpected tool: ${request.name}`);
    },
  };
  const controller = createEditorSessionController({ app });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  const result = await controller.ensure(nextImageId);

  assert.equal(result.opened, true);
  assert.equal(controller.id, nextSessionId);
  assert.deepEqual(calls.map((call) => call.name), [
    "get_image_editor_session",
    "finalize_image_editor_session",
    "open_image_editor",
  ]);
  assert.equal(calls.at(-1).arguments.imageId, nextImageId);
});

test("destroy releases the server session and clears the local session id", async () => {
  const calls = [];
  const app = {
    async callServerTool(request) {
      calls.push(request.name);
      return { structuredContent: { editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "destroyed" } } };
    },
  };
  const controller = createEditorSessionController({ app });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  await controller.destroy();

  assert.deepEqual(calls, ["destroy_image_editor", "finalize_image_editor_session"]);
  assert.equal(controller.id, "");
});

test("a destroyed server session triggers lifecycle teardown exactly once", async () => {
  let destroyedCount = 0;
  const app = {
    async callServerTool(request) {
      assert.equal(request.name, "get_image_editor_session");
      return { structuredContent: { editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "destroyed" } } };
    },
  };
  const controller = createEditorSessionController({
    app,
    onDestroyed: async () => { destroyedCount += 1; },
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  await controller.checkStatus();
  await controller.checkStatus();

  assert.equal(destroyedCount, 1);
});

test("status polling rebuilds a stale session for the currently open image", async () => {
  const nextSessionId = "eds_01J00000000000000000000001";
  const calls = [];
  const app = {
    async callServerTool(request) {
      calls.push(request.name);
      if (request.name === "get_image_editor_session") {
        return {
          isError: true,
          structuredContent: {
            error: {
              code: "editor_session_not_found",
              message: "the editor session was released",
            },
          },
        };
      }
      if (request.name === "open_image_editor") {
        return {
          structuredContent: {
            editorSession: {
              id: nextSessionId,
              imageId: IMAGE_ID,
              status: "active",
            },
          },
        };
      }
      throw new Error(`unexpected tool: ${request.name}`);
    },
  };
  const controller = createEditorSessionController({ app });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  const status = await controller.checkStatus();

  assert.equal(status, "active");
  assert.equal(controller.id, nextSessionId);
  assert.deepEqual(calls, ["get_image_editor_session", "open_image_editor"]);
});
