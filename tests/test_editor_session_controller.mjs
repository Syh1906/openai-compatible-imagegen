import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createImagegenServer } from "../mcp/create-server.mjs";
import { createReleaseBundle, RELEASE_IDENTITY_PLACEHOLDER } from "../mcp/release-identity.mjs";
import {
  createFixtureProjectContext,
  FIXTURE_PROJECT_BINDING_ID,
} from "./fixture-project-context.js";
import {
  EDITOR_SESSION_SETTLED_TOMBSTONE_LIMIT,
  createEditorSessionController,
} from "../web/editor-session-controller.mjs";


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

test("concurrent opens that return the same session id do not release the adopted session", async () => {
  const openResolvers = [];
  const calls = [];
  const controller = createEditorSessionController({
    app: {
      callServerTool: async (request) => {
        calls.push(request);
        if (request.name === "open_image_editor") {
          return await new Promise((resolve) => { openResolvers.push(resolve); });
        }
        if (request.name === "finalize_image_editor_session") {
          return { structuredContent: { editorSession: { status: "released" } } };
        }
        throw new Error(`unexpected tool: ${request.name}`);
      },
    },
  });

  const first = controller.ensure(IMAGE_ID);
  const second = controller.ensure(IMAGE_ID);
  await new Promise((resolve) => setImmediate(resolve));
  const sessionResult = {
    structuredContent: {
      editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "active" },
    },
  };
  openResolvers[0](sessionResult);
  assert.equal((await first).opened, true);
  openResolvers[1](sessionResult);
  await second;

  assert.equal(controller.id, SESSION_ID);
  assert.equal(controller.imageId, IMAGE_ID);
  assert.equal(calls.filter(({ name }) => name === "finalize_image_editor_session").length, 0);
});

test("a late same-id open keeps an already settled finalize in bounded history", async () => {
  const openResolvers = [];
  let finalizeCount = 0;
  const controller = createEditorSessionController({
    app: {
      callServerTool: async ({ name }) => {
        if (name === "open_image_editor") {
          return await new Promise((resolve) => { openResolvers.push(resolve); });
        }
        if (name === "finalize_image_editor_session") {
          finalizeCount += 1;
          return { structuredContent: { editorSession: { status: "released" } } };
        }
        throw new Error(`unexpected tool: ${name}`);
      },
    },
  });
  const sessionResult = {
    structuredContent: {
      editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "active" },
    },
  };

  const first = controller.ensure(IMAGE_ID);
  const second = controller.ensure(IMAGE_ID);
  await new Promise((resolve) => setImmediate(resolve));
  openResolvers[0](sessionResult);
  assert.equal((await first).opened, true);
  assert.equal(await controller.finalize(), true);
  openResolvers[1](sessionResult);
  assert.equal((await second).opened, false);
  assert.equal(finalizeCount, 1);

  for (let index = 1; index <= EDITOR_SESSION_SETTLED_TOMBSTONE_LIMIT + 1; index += 1) {
    const id = `eds_${index.toString(16).padStart(32, "0")}`;
    assert.equal(controller.adopt({ id, imageId: IMAGE_ID, status: "active" }), true);
  }
  assert.equal(controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" }), true);
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
          content: [{ type: "text", text: "editor_session_not_found: 画布会话不存在或已经释放。" }],
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
  assert.equal(controller.imageId, IMAGE_ID);

  const result = await controller.ensure(nextImageId);

  assert.equal(result.opened, true);
  assert.equal(controller.id, nextSessionId);
  assert.equal(controller.imageId, nextImageId);
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
  let controller;
  controller = createEditorSessionController({ app, onDestroyed: async () => { await controller.finalize(); } });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  const destroyed = await controller.destroy();

  assert.equal(destroyed, true);
  assert.deepEqual(calls, ["destroy_image_editor", "finalize_image_editor_session"]);
  assert.equal(controller.id, "");
});

test("a new session gets its own destroyed lifecycle transition", async () => {
  const nextSessionId = "eds_01J00000000000000000000001";
  const nextImageId = "img_01J00000000000000000000001";
  const calls = [];
  let destroyedCount = 0;
  const app = {
    async callServerTool(request) {
      calls.push(request);
      if (request.name === "destroy_image_editor") {
        const activeSessionId = request.arguments.editorSessionId;
        return {
          structuredContent: {
            editorSession: {
              id: activeSessionId,
              imageId: activeSessionId === SESSION_ID ? IMAGE_ID : nextImageId,
              status: "destroyed",
            },
          },
        };
      }
      if (request.name === "finalize_image_editor_session") {
        return { structuredContent: { editorSession: { status: "released" } } };
      }
      throw new Error(`unexpected tool: ${request.name}`);
    },
  };
  let controller;
  controller = createEditorSessionController({
    app,
    onDestroyed: async () => {
      destroyedCount += 1;
      await controller.finalize();
    },
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  await controller.destroy();
  controller.adopt({ id: nextSessionId, imageId: nextImageId, status: "active" });
  await controller.destroy();

  assert.equal(destroyedCount, 2);
  assert.deepEqual(
    calls.map(({ name }) => name),
    [
      "destroy_image_editor",
      "finalize_image_editor_session",
      "destroy_image_editor",
      "finalize_image_editor_session",
    ],
  );
  assert.equal(controller.id, "");
});

test("a late destroyed status from an old session cannot tear down a newly adopted session", async () => {
  const nextSessionId = "eds_01J00000000000000000000001";
  const nextImageId = "img_01J00000000000000000000001";
  let resolveStatus;
  let destroyedCount = 0;
  const statusResult = new Promise((resolve) => { resolveStatus = resolve; });
  const controller = createEditorSessionController({
    app: {
      callServerTool: async ({ name }) => {
        assert.equal(name, "get_image_editor_session");
        return await statusResult;
      },
    },
    onDestroyed: async () => { destroyedCount += 1; },
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  const checking = controller.checkStatus();
  controller.adopt({ id: nextSessionId, imageId: nextImageId, status: "active" });
  resolveStatus({
    structuredContent: {
      editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "destroyed" },
    },
  });

  assert.equal(await checking, null);
  assert.equal(destroyedCount, 0);
  assert.equal(controller.id, nextSessionId);
  assert.equal(controller.imageId, nextImageId);
});

test("a late destroy acknowledgement from an old session cannot tear down a newly adopted session", async () => {
  const nextSessionId = "eds_01J00000000000000000000001";
  const nextImageId = "img_01J00000000000000000000001";
  let resolveDestroy;
  let destroyedCount = 0;
  const destroyResult = new Promise((resolve) => { resolveDestroy = resolve; });
  const controller = createEditorSessionController({
    app: {
      callServerTool: async ({ name }) => {
        assert.equal(name, "destroy_image_editor");
        return await destroyResult;
      },
    },
    onDestroyed: async () => { destroyedCount += 1; },
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  const destroying = controller.destroy();
  controller.adopt({ id: nextSessionId, imageId: nextImageId, status: "active" });
  resolveDestroy({
    structuredContent: {
      editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "destroyed" },
    },
  });

  assert.equal(await destroying, false);
  assert.equal(destroyedCount, 0);
  assert.equal(controller.id, nextSessionId);
  assert.equal(controller.imageId, nextImageId);
});

test("a late ensure status response cannot finalize or replace a newly adopted session", async () => {
  const nextSessionId = "eds_01J00000000000000000000001";
  const nextImageId = "img_01J00000000000000000000001";
  const requestedImageId = "img_01J00000000000000000000002";
  let resolveStatus;
  const calls = [];
  const statusResult = new Promise((resolve) => { resolveStatus = resolve; });
  const controller = createEditorSessionController({
    app: {
      callServerTool: async (request) => {
        calls.push(request);
        if (request.name === "get_image_editor_session") return await statusResult;
        if (request.name === "finalize_image_editor_session") {
          return { structuredContent: { editorSession: { status: "released" } } };
        }
        if (request.name === "open_image_editor") {
          return {
            structuredContent: {
              editorSession: { id: "eds_01J00000000000000000000002", imageId: requestedImageId, status: "active" },
            },
          };
        }
        throw new Error(`unexpected tool: ${request.name}`);
      },
    },
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  const ensuring = controller.ensure(requestedImageId);
  controller.adopt({ id: nextSessionId, imageId: nextImageId, status: "active" });
  resolveStatus({
    structuredContent: {
      editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "active" },
    },
  });

  await ensuring;
  assert.equal(controller.id, nextSessionId);
  assert.equal(controller.imageId, nextImageId);
  assert.deepEqual(calls.map(({ name }) => name), ["get_image_editor_session"]);
});

test("a late missing-session ensure response cannot clear a newly adopted session", async () => {
  const nextSessionId = "eds_01J00000000000000000000001";
  const nextImageId = "img_01J00000000000000000000001";
  let resolveStatus;
  const calls = [];
  const statusResult = new Promise((resolve) => { resolveStatus = resolve; });
  const controller = createEditorSessionController({
    app: {
      callServerTool: async (request) => {
        calls.push(request);
        if (request.name === "get_image_editor_session") return await statusResult;
        throw new Error(`unexpected tool: ${request.name}`);
      },
    },
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  const ensuring = controller.ensure("img_01J00000000000000000000002");
  controller.adopt({ id: nextSessionId, imageId: nextImageId, status: "active" });
  resolveStatus({
    isError: true,
    content: [{ type: "text", text: "editor_session_not_found: 画布会话不存在或已经释放。" }],
  });

  await ensuring;
  assert.equal(controller.id, nextSessionId);
  assert.equal(controller.imageId, nextImageId);
  assert.deepEqual(calls.map(({ name }) => name), ["get_image_editor_session"]);
});

test("concurrent destroyed observations share one transition until its callback settles", async () => {
  let releaseDestroyed;
  let destroyedStarted;
  let destroyedCount = 0;
  const destroyedPending = new Promise((resolve) => { releaseDestroyed = resolve; });
  const destroyedStartedPromise = new Promise((resolve) => { destroyedStarted = resolve; });
  const controller = createEditorSessionController({
    app: {
      callServerTool: async ({ name }) => {
        assert.equal(name, "get_image_editor_session");
        return {
          structuredContent: {
            editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "destroyed" },
          },
        };
      },
    },
    onDestroyed: async () => {
      destroyedCount += 1;
      destroyedStarted();
      await destroyedPending;
    },
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  const first = controller.checkStatus();
  await destroyedStartedPromise;
  const second = controller.checkStatus();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(destroyedCount, 1);

  releaseDestroyed();
  assert.equal(await first, "destroyed");
  assert.equal(await second, "destroyed");
  assert.equal(destroyedCount, 1);
});

test("a destroyed callback finalizes only the session that triggered it", async () => {
  const nextSessionId = "eds_01J00000000000000000000001";
  const nextImageId = "img_01J00000000000000000000001";
  let continueDestroyed;
  let destroyedStarted;
  const continueDestroyedPromise = new Promise((resolve) => { continueDestroyed = resolve; });
  const destroyedStartedPromise = new Promise((resolve) => { destroyedStarted = resolve; });
  const calls = [];
  let callbackContext = null;
  const controller = createEditorSessionController({
    app: {
      callServerTool: async (request) => {
        calls.push(request);
        if (request.name === "get_image_editor_session") {
          return {
            structuredContent: {
              editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "destroyed" },
            },
          };
        }
        if (request.name === "finalize_image_editor_session") {
          return { structuredContent: { editorSession: { status: "released" } } };
        }
        throw new Error(`unexpected tool: ${request.name}`);
      },
    },
    onDestroyed: async (context) => {
      callbackContext = context;
      destroyedStarted();
      await continueDestroyedPromise;
      await context.finalize();
    },
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  const checking = controller.checkStatus();
  await destroyedStartedPromise;
  controller.adopt({ id: nextSessionId, imageId: nextImageId, status: "active" });
  continueDestroyed();

  assert.equal(await checking, "destroyed");
  assert.equal(callbackContext.sessionId, SESSION_ID);
  assert.equal(callbackContext.imageId, IMAGE_ID);
  assert.equal(calls.at(-1).name, "finalize_image_editor_session");
  assert.equal(calls.at(-1).arguments.editorSessionId, SESSION_ID);
  assert.equal(controller.id, nextSessionId);
  assert.equal(controller.imageId, nextImageId);
});

test("a second destroyed response joins the same callback after scoped finalize", async () => {
  let resolveFirstStatus;
  let resolveSecondStatus;
  let finalized;
  let finishDestroyed;
  let statusCallCount = 0;
  let destroyedCount = 0;
  let finalizeCount = 0;
  const firstStatus = new Promise((resolve) => { resolveFirstStatus = resolve; });
  const secondStatus = new Promise((resolve) => { resolveSecondStatus = resolve; });
  const finalizedPromise = new Promise((resolve) => { finalized = resolve; });
  const finishDestroyedPromise = new Promise((resolve) => { finishDestroyed = resolve; });
  const controller = createEditorSessionController({
    app: {
      callServerTool: async ({ name }) => {
        if (name === "get_image_editor_session") {
          statusCallCount += 1;
          return await (statusCallCount === 1 ? firstStatus : secondStatus);
        }
        if (name === "finalize_image_editor_session") {
          finalizeCount += 1;
          return { structuredContent: { editorSession: { status: "released" } } };
        }
        throw new Error(`unexpected tool: ${name}`);
      },
    },
    onDestroyed: async (context) => {
      destroyedCount += 1;
      await context.finalize();
      finalized();
      await finishDestroyedPromise;
    },
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  const first = controller.checkStatus();
  const second = controller.checkStatus();
  resolveFirstStatus({
    structuredContent: {
      editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "destroyed" },
    },
  });
  await finalizedPromise;
  resolveSecondStatus({
    structuredContent: {
      editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "destroyed" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(destroyedCount, 1);
  assert.equal(finalizeCount, 1);
  finishDestroyed();
  assert.equal(await first, "destroyed");
  assert.equal(await second, "destroyed");
  assert.equal(destroyedCount, 1);
  assert.equal(finalizeCount, 1);
});

for (const finalizeFails of [false, true]) {
  test(`a terminal session cannot be revived after finalize ${finalizeFails ? "fails" : "succeeds"}`, async () => {
    let destroyedCount = 0;
    let finalizeCount = 0;
    const controller = createEditorSessionController({
      app: {
        callServerTool: async ({ name }) => {
          if (name === "get_image_editor_session") {
            return {
              structuredContent: {
                editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "destroyed" },
              },
            };
          }
          if (name === "finalize_image_editor_session") {
            finalizeCount += 1;
            return finalizeFails
              ? { isError: true, content: [{ type: "text", text: "editor_session_release_failed" }] }
              : { structuredContent: { editorSession: { status: "released" } } };
          }
          throw new Error(`unexpected tool: ${name}`);
        },
      },
      onDestroyed: async (context) => {
        destroyedCount += 1;
        try { await context.finalize(); } catch {}
      },
    });
    controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

    assert.equal(await controller.checkStatus(), "destroyed");
    controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });
    controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "destroyed" });
    controller.start("destroyed");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(destroyedCount, 1);
    assert.equal(finalizeCount, 1);
  });
}

test("a failed terminal cleanup is not requested from the server twice", async () => {
  let finalizeCount = 0;
  const controller = createEditorSessionController({
    app: {
      callServerTool: async ({ name }) => {
        if (name === "get_image_editor_session") {
          return {
            structuredContent: {
              editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "destroyed" },
            },
          };
        }
        if (name === "finalize_image_editor_session") {
          finalizeCount += 1;
          return { isError: true, content: [{ type: "text", text: "editor_session_release_failed" }] };
        }
        throw new Error(`unexpected tool: ${name}`);
      },
    },
    onDestroyed: async (context) => {
      try { await context.finalize(); } catch {}
    },
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  assert.equal(await controller.checkStatus(), "destroyed");
  await assert.rejects(controller.finalize(), /editor session release failed/);

  assert.equal(finalizeCount, 1);
});

test("destroy does not report a missing stale session as a destroyed image", async () => {
  const calls = [];
  const app = {
    async callServerTool(request) {
      calls.push(request.name);
      return {
        isError: true,
        content: [{ type: "text", text: "editor_session_not_found: 画布会话不存在或已经释放。" }],
      };
    },
  };
  const controller = createEditorSessionController({ app });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  const destroyed = await controller.destroy();

  assert.equal(destroyed, false);
  assert.deepEqual(calls, ["destroy_image_editor"]);
  assert.equal(controller.id, "");
});

test("destroy does not report an already released session as a destroyed image", async () => {
  const calls = [];
  const app = {
    async callServerTool(request) {
      calls.push(request.name);
      return {
        structuredContent: {
          editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "released" },
        },
      };
    },
  };
  const controller = createEditorSessionController({ app });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  const destroyed = await controller.destroy();

  assert.equal(destroyed, false);
  assert.deepEqual(calls, ["destroy_image_editor"]);
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
          content: [{ type: "text", text: "editor_session_not_found: 画布会话不存在或已经释放。" }],
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

test("status polling continues after rebuilding a stale session", async () => {
  const nextSessionId = "eds_01J00000000000000000000001";
  const calls = [];
  let getCalls = 0;
  let scheduledCheck = null;
  let destroyedCount = 0;
  const app = {
    async callServerTool(request) {
      calls.push(request.name);
      if (request.name === "get_image_editor_session") {
        getCalls += 1;
        if (getCalls === 1) {
          return {
            isError: true,
            content: [{ type: "text", text: "editor_session_not_found: 画布会话不存在或已经释放。" }],
          };
        }
        return {
          structuredContent: {
            editorSession: {
              id: nextSessionId,
              imageId: IMAGE_ID,
              status: "destroyed",
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
  const controller = createEditorSessionController({
    app,
    onDestroyed: async () => { destroyedCount += 1; },
    setIntervalFn: (callback) => {
      scheduledCheck = callback;
      return 1;
    },
    clearIntervalFn: () => { scheduledCheck = null; },
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  controller.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.id, nextSessionId);
  assert.equal(typeof scheduledCheck, "function");
  await scheduledCheck();
  assert.equal(destroyedCount, 1);
  assert.equal(scheduledCheck, null);
  assert.deepEqual(calls, [
    "get_image_editor_session",
    "open_image_editor",
    "get_image_editor_session",
  ]);
});

test("stopped status polling ignores a late destroyed response", async () => {
  let resolveStatus;
  let destroyedCount = 0;
  let errorCount = 0;
  const statusResult = new Promise((resolve) => { resolveStatus = resolve; });
  const controller = createEditorSessionController({
    app: {
      callServerTool: async ({ name }) => {
        assert.equal(name, "get_image_editor_session");
        return await statusResult;
      },
    },
    onDestroyed: async () => { destroyedCount += 1; },
    onError: () => { errorCount += 1; },
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  controller.start();
  controller.stop();
  resolveStatus({
    structuredContent: {
      editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "destroyed" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(destroyedCount, 0);
  assert.equal(errorCount, 0);
});

test("stopped status polling ignores a late status error", async () => {
  let rejectStatus;
  let destroyedCount = 0;
  let errorCount = 0;
  const statusResult = new Promise((resolve, reject) => { rejectStatus = reject; });
  const controller = createEditorSessionController({
    app: {
      callServerTool: async ({ name }) => {
        assert.equal(name, "get_image_editor_session");
        return await statusResult;
      },
    },
    onDestroyed: async () => { destroyedCount += 1; },
    onError: () => { errorCount += 1; },
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  controller.start();
  controller.stop();
  rejectStatus(new Error("late status failure"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(destroyedCount, 0);
  assert.equal(errorCount, 0);
});

test("a late polling error from an old session cannot stop the newly adopted session", async () => {
  const nextSessionId = "eds_01J00000000000000000000001";
  const nextImageId = "img_01J00000000000000000000001";
  let rejectOldStatus;
  let scheduledCheck = null;
  let errorCount = 0;
  const statusCalls = [];
  const oldStatus = new Promise((_resolve, reject) => { rejectOldStatus = reject; });
  const controller = createEditorSessionController({
    app: {
      callServerTool: async ({ name, arguments: toolArguments }) => {
        assert.equal(name, "get_image_editor_session");
        statusCalls.push(toolArguments.editorSessionId);
        if (toolArguments.editorSessionId === SESSION_ID) return await oldStatus;
        return {
          structuredContent: {
            editorSession: { id: nextSessionId, imageId: nextImageId, status: "active" },
          },
        };
      },
    },
    onError: () => { errorCount += 1; },
    setIntervalFn: (callback) => { scheduledCheck = callback; return 1; },
    clearIntervalFn: () => { scheduledCheck = null; },
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });
  controller.start();
  await new Promise((resolve) => setImmediate(resolve));

  controller.adopt({ id: nextSessionId, imageId: nextImageId, status: "active" });
  rejectOldStatus(new Error("old session status failed late"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(errorCount, 0);
  assert.equal(typeof scheduledCheck, "function");
  await scheduledCheck();
  assert.deepEqual(statusCalls, [SESSION_ID, nextSessionId]);
  assert.equal(controller.id, nextSessionId);
});

test("a hanging polling request from an old session does not block the newly adopted session", async () => {
  const nextSessionId = "eds_01J00000000000000000000001";
  const nextImageId = "img_01J00000000000000000000001";
  let resolveOldStatus;
  let scheduledCheck = null;
  const statusCalls = [];
  const oldStatus = new Promise((resolve) => { resolveOldStatus = resolve; });
  const controller = createEditorSessionController({
    app: {
      callServerTool: async ({ name, arguments: toolArguments }) => {
        assert.equal(name, "get_image_editor_session");
        statusCalls.push(toolArguments.editorSessionId);
        if (toolArguments.editorSessionId === SESSION_ID) return await oldStatus;
        return {
          structuredContent: {
            editorSession: { id: nextSessionId, imageId: nextImageId, status: "active" },
          },
        };
      },
    },
    setIntervalFn: (callback) => { scheduledCheck = callback; return 1; },
    clearIntervalFn: () => { scheduledCheck = null; },
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });
  controller.start();
  await new Promise((resolve) => setImmediate(resolve));

  controller.adopt({ id: nextSessionId, imageId: nextImageId, status: "active" });
  await scheduledCheck();

  assert.deepEqual(statusCalls, [SESSION_ID, nextSessionId]);
  assert.equal(controller.id, nextSessionId);
  resolveOldStatus({
    structuredContent: {
      editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "active" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
});

test("a late recovery open from an old polling request cannot stop the newly adopted session", async () => {
  const nextSessionId = "eds_01J00000000000000000000001";
  const nextImageId = "img_01J00000000000000000000001";
  const replacementSessionId = "eds_01J00000000000000000000002";
  let resolveReplacement;
  let replacementStarted;
  let scheduledCheck = null;
  let errorCount = 0;
  const calls = [];
  const replacement = new Promise((resolve) => { resolveReplacement = resolve; });
  const replacementStartedPromise = new Promise((resolve) => { replacementStarted = resolve; });
  const controller = createEditorSessionController({
    app: {
      callServerTool: async (request) => {
        calls.push(request);
        if (request.name === "get_image_editor_session") {
          if (request.arguments.editorSessionId === SESSION_ID) {
            return {
              isError: true,
              content: [{ type: "text", text: "editor_session_not_found: 画布会话不存在或已经释放。" }],
            };
          }
          return {
            structuredContent: {
              editorSession: { id: nextSessionId, imageId: nextImageId, status: "active" },
            },
          };
        }
        if (request.name === "open_image_editor") {
          replacementStarted();
          return await replacement;
        }
        if (request.name === "finalize_image_editor_session") {
          return { structuredContent: { editorSession: { status: "released" } } };
        }
        throw new Error(`unexpected tool: ${request.name}`);
      },
    },
    onError: () => { errorCount += 1; },
    setIntervalFn: (callback) => { scheduledCheck = callback; return 1; },
    clearIntervalFn: () => { scheduledCheck = null; },
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });
  controller.start();
  await replacementStartedPromise;

  controller.adopt({ id: nextSessionId, imageId: nextImageId, status: "active" });
  resolveReplacement({
    structuredContent: {
      editorSession: { id: replacementSessionId, imageId: IMAGE_ID, status: "active" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(errorCount, 0);
  assert.equal(typeof scheduledCheck, "function");
  await scheduledCheck();
  assert.equal(controller.id, nextSessionId);
  assert.deepEqual(
    calls.filter(({ name }) => name === "get_image_editor_session").map(({ arguments: value }) => value.editorSessionId),
    [SESSION_ID, nextSessionId],
  );
});

test("a destroyed polling transition reports its callback failure exactly once", async () => {
  let scheduledCheck = null;
  const errors = [];
  const failure = new Error("destroyed transition failed");
  const controller = createEditorSessionController({
    app: {
      callServerTool: async ({ name }) => {
        assert.equal(name, "get_image_editor_session");
        return {
          structuredContent: {
            editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "destroyed" },
          },
        };
      },
    },
    onDestroyed: async () => { throw failure; },
    onError: (error) => { errors.push(error); },
    setIntervalFn: (callback) => { scheduledCheck = callback; return 1; },
    clearIntervalFn: () => { scheduledCheck = null; },
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  controller.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(errors, [failure]);
  assert.equal(scheduledCheck, null);
  assert.equal(controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "destroyed" }), false);
  controller.start("destroyed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [failure]);
});

test("a stale ordinary polling error cannot hide the current destroyed transition failure", async () => {
  let rejectOldStatus;
  let rejectDestroyed;
  let destroyedStarted;
  let statusCallCount = 0;
  const oldStatus = new Promise((_resolve, reject) => {
    rejectOldStatus = reject;
  });
  const destroyedPending = new Promise((_, reject) => { rejectDestroyed = reject; });
  const destroyedStartedPromise = new Promise((resolve) => { destroyedStarted = resolve; });
  const oldFailure = new Error("late ordinary status failure");
  const destroyedFailure = new Error("destroyed callback failure");
  const errors = [];
  const controller = createEditorSessionController({
    app: {
      callServerTool: async ({ name }) => {
        assert.equal(name, "get_image_editor_session");
        statusCallCount += 1;
        if (statusCallCount === 1) return await oldStatus;
        return {
          structuredContent: {
            editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "destroyed" },
          },
        };
      },
    },
    onDestroyed: async () => {
      destroyedStarted();
      return await destroyedPending;
    },
    onError: (error) => { errors.push(error); },
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  controller.stop();
  controller.start();
  await destroyedStartedPromise;
  rejectOldStatus(oldFailure);
  await new Promise((resolve) => setImmediate(resolve));
  rejectDestroyed(destroyedFailure);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(errors, [destroyedFailure]);
});

test("retired session tombstones keep a fixed recent-history bound", () => {
  const controller = createEditorSessionController({ app: { callServerTool: async () => ({}) } });
  const sessionIds = Array.from(
    { length: EDITOR_SESSION_SETTLED_TOMBSTONE_LIMIT + 2 },
    (_, index) => `eds_${index.toString(16).padStart(32, "0")}`,
  );

  for (const [index, id] of sessionIds.entries()) {
    assert.equal(controller.adopt({ id, imageId: IMAGE_ID, status: "active" }), true, `adopt ${index}`);
  }

  assert.equal(controller.adopt({ id: sessionIds.at(-2), imageId: IMAGE_ID, status: "active" }), false);
  assert.equal(controller.adopt({ id: sessionIds[0], imageId: IMAGE_ID, status: "active" }), true);
});

test("a pending destroyed transition remains protected while settled tombstones are trimmed", async () => {
  let releaseDestroyed;
  let destroyedStarted;
  let destroyedCount = 0;
  let finalizeCount = 0;
  const releaseDestroyedPromise = new Promise((resolve) => { releaseDestroyed = resolve; });
  const destroyedStartedPromise = new Promise((resolve) => { destroyedStarted = resolve; });
  const controller = createEditorSessionController({
    app: {
      callServerTool: async ({ name }) => {
        if (name === "get_image_editor_session") {
          return {
            structuredContent: {
              editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "destroyed" },
            },
          };
        }
        if (name === "finalize_image_editor_session") {
          finalizeCount += 1;
          return { structuredContent: { editorSession: { status: "released" } } };
        }
        throw new Error(`unexpected tool: ${name}`);
      },
    },
    onDestroyed: async (context) => {
      destroyedCount += 1;
      destroyedStarted();
      await releaseDestroyedPromise;
      await context.finalize();
    },
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });
  const destroyed = controller.checkStatus();
  await destroyedStartedPromise;

  for (let index = 1; index <= EDITOR_SESSION_SETTLED_TOMBSTONE_LIMIT + 2; index += 1) {
    const id = `eds_${index.toString(16).padStart(32, "0")}`;
    assert.equal(controller.adopt({ id, imageId: IMAGE_ID, status: "active" }), true);
  }

  assert.equal(controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "destroyed" }), false);
  assert.equal(destroyedCount, 1);
  releaseDestroyed();
  assert.equal(await destroyed, "destroyed");
  assert.equal(finalizeCount, 1);
});

test("a pending nonterminal finalize remains protected while settled tombstones are trimmed", async () => {
  let releaseFinalize;
  let finalizeStarted;
  let finalizeCount = 0;
  const releaseFinalizePromise = new Promise((resolve) => { releaseFinalize = resolve; });
  const finalizeStartedPromise = new Promise((resolve) => { finalizeStarted = resolve; });
  const controller = createEditorSessionController({
    app: {
      callServerTool: async ({ name }) => {
        assert.equal(name, "finalize_image_editor_session");
        finalizeCount += 1;
        finalizeStarted();
        await releaseFinalizePromise;
        return { structuredContent: { editorSession: { status: "released" } } };
      },
    },
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });
  const finalizing = controller.finalize();
  await finalizeStartedPromise;

  for (let index = 1; index <= EDITOR_SESSION_SETTLED_TOMBSTONE_LIMIT + 2; index += 1) {
    const id = `eds_${index.toString(16).padStart(32, "0")}`;
    assert.equal(controller.adopt({ id, imageId: IMAGE_ID, status: "active" }), true);
  }

  assert.equal(controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" }), false);
  releaseFinalize();
  assert.equal(await finalizing, true);
  assert.equal(finalizeCount, 1);
});

test("a stopped pending ensure releases its late server session without adopting it", async () => {
  let resolveOpen;
  const calls = [];
  const openResult = new Promise((resolve) => { resolveOpen = resolve; });
  const controller = createEditorSessionController({
    app: {
      callServerTool: async (request) => {
        calls.push(request);
        if (request.name === "open_image_editor") return await openResult;
        if (request.name === "finalize_image_editor_session") {
          return {
            structuredContent: {
              editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "released" },
            },
          };
        }
        throw new Error(`unexpected tool: ${request.name}`);
      },
    },
  });

  const ensuring = controller.ensure(IMAGE_ID);
  controller.stop();
  resolveOpen({
    structuredContent: {
      editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "active" },
    },
  });

  const result = await ensuring;
  assert.equal(result.opened, false);
  assert.equal(controller.id, "");
  assert.deepEqual(calls.map(({ name }) => name), [
    "open_image_editor",
    "finalize_image_editor_session",
  ]);
  assert.equal(calls[1].arguments.editorSessionId, SESSION_ID);
});

test("a failed late-session cleanup rejects the pending ensure without retrying", async () => {
  let resolveOpen;
  let finalizeCount = 0;
  const openResult = new Promise((resolve) => { resolveOpen = resolve; });
  const controller = createEditorSessionController({
    app: {
      callServerTool: async ({ name }) => {
        if (name === "open_image_editor") return await openResult;
        if (name === "finalize_image_editor_session") {
          finalizeCount += 1;
          return { isError: true, content: [{ type: "text", text: "editor_session_release_failed" }] };
        }
        throw new Error(`unexpected tool: ${name}`);
      },
    },
  });

  const ensuring = controller.ensure(IMAGE_ID);
  controller.stop();
  resolveOpen({
    structuredContent: {
      editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "active" },
    },
  });

  await assert.rejects(ensuring, /editor session release failed/);
  assert.equal(finalizeCount, 1);
  assert.equal(controller.id, "");
});

test("a late-open cleanup remains protected while settled tombstones are trimmed", async () => {
  let resolveOpen;
  let releaseFinalize;
  let finalizeStarted;
  let finalizeCount = 0;
  const openResult = new Promise((resolve) => { resolveOpen = resolve; });
  const releaseFinalizePromise = new Promise((resolve) => { releaseFinalize = resolve; });
  const finalizeStartedPromise = new Promise((resolve) => { finalizeStarted = resolve; });
  const controller = createEditorSessionController({
    app: {
      callServerTool: async ({ name }) => {
        if (name === "open_image_editor") return await openResult;
        if (name === "finalize_image_editor_session") {
          finalizeCount += 1;
          finalizeStarted();
          await releaseFinalizePromise;
          return { structuredContent: { editorSession: { status: "released" } } };
        }
        throw new Error(`unexpected tool: ${name}`);
      },
    },
  });

  const ensuring = controller.ensure(IMAGE_ID);
  controller.stop();
  resolveOpen({
    structuredContent: {
      editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "active" },
    },
  });
  await finalizeStartedPromise;

  for (let index = 1; index <= EDITOR_SESSION_SETTLED_TOMBSTONE_LIMIT + 2; index += 1) {
    const id = `eds_${index.toString(16).padStart(32, "0")}`;
    assert.equal(controller.adopt({ id, imageId: IMAGE_ID, status: "active" }), true);
  }

  assert.equal(controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" }), false);
  releaseFinalize();
  assert.equal((await ensuring).opened, false);
  assert.equal(finalizeCount, 1);
});

test("a stopped ensure does not open a new image after its previous session finishes finalizing", async () => {
  const nextImageId = "img_01J00000000000000000000001";
  let resolveFinalize;
  let finalizeStarted;
  const finalizePending = new Promise((resolve) => { resolveFinalize = resolve; });
  const finalizeStartedPromise = new Promise((resolve) => { finalizeStarted = resolve; });
  const calls = [];
  const controller = createEditorSessionController({
    app: {
      callServerTool: async (request) => {
        calls.push(request);
        if (request.name === "get_image_editor_session") {
          return {
            structuredContent: {
              editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "active" },
            },
          };
        }
        if (request.name === "finalize_image_editor_session") {
          finalizeStarted();
          return await finalizePending;
        }
        throw new Error(`unexpected tool: ${request.name}`);
      },
    },
  });
  controller.adopt({ id: SESSION_ID, imageId: IMAGE_ID, status: "active" });

  const ensuring = controller.ensure(nextImageId);
  await finalizeStartedPromise;
  controller.stop();
  const duplicateFinalize = controller.finalize();
  resolveFinalize({
    structuredContent: {
      editorSession: { id: SESSION_ID, imageId: IMAGE_ID, status: "released" },
    },
  });

  const [result, finalized] = await Promise.all([ensuring, duplicateFinalize]);
  assert.deepEqual(result, { opened: false, result: null, session: null });
  assert.equal(finalized, true);
  assert.equal(controller.id, "");
  assert.deepEqual(calls.map(({ name }) => name), [
    "get_image_editor_session",
    "finalize_image_editor_session",
  ]);
});

test("session controller rebuilds released sessions from real MCP error results", async () => {
  const pluginRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
  const projectRoot = path.dirname(pluginRoot);
  const metadata = {
    id: IMAGE_ID,
    parentIds: [],
    childIds: [],
    mimeType: "image/png",
    width: 1,
    height: 1,
    provider: "primary",
    model: "gpt-image-2",
    operation: "generate",
    prompt: "session recovery fixture",
    parameters: {},
    annotationId: null,
    createdAt: "2026-08-07T00:00:00.000Z",
  };
  const releaseIdentity = createReleaseBundle({
    pluginId: "openai-compatible-imagegen",
    pluginVersion: "0.1.0-session-test",
    serverBuildInputs: [{ path: "test-server.mjs", content: "test server" }],
    widgetHtml: `<html><head>${RELEASE_IDENTITY_PLACEHOLDER}</head></html>`,
  }).releaseIdentity;
  const server = createImagegenServer({
    releaseIdentity,
    launchContext: { cwd: pluginRoot, pluginRoot },
    projectContext: createFixtureProjectContext({ projectRoot }),
    readWidgetHtml: async () => "<html></html>",
    runTask: async () => ({ ok: false, error: { code: "image_task_failed", message: "not used" } }),
    readArtifact: async () => ({ metadata, data: "" }),
  });
  const client = new Client({ name: "editor-session-controller-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const controller = createEditorSessionController({
    app: {
      callServerTool: async ({ name, arguments: toolArguments }) => await client.callTool({
        name,
        arguments: { projectBindingId: FIXTURE_PROJECT_BINDING_ID, ...toolArguments },
      }),
    },
  });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.callTool({
      name: "bind_imagegen_project",
      arguments: { projectRoot },
    });
    const first = await controller.ensure(IMAGE_ID);
    await client.callTool({
      name: "finalize_image_editor_session",
      arguments: { projectBindingId: FIXTURE_PROJECT_BINDING_ID, editorSessionId: first.session.id },
    });

    const ensured = await controller.ensure(IMAGE_ID);
    assert.equal(ensured.opened, true);
    assert.notEqual(ensured.session.id, first.session.id);

    await client.callTool({
      name: "finalize_image_editor_session",
      arguments: { projectBindingId: FIXTURE_PROJECT_BINDING_ID, editorSessionId: ensured.session.id },
    });
    const status = await controller.checkStatus();
    assert.equal(status, "active");
    assert.notEqual(controller.id, ensured.session.id);
  } finally {
    controller.stop();
    await client.close();
    await server.close();
  }
});
