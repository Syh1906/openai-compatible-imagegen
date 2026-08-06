import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createImagegenServer } from "../mcp/create-server.mjs";
import { createReleaseBundle, RELEASE_IDENTITY_PLACEHOLDER } from "../mcp/release-identity.mjs";


const RELEASE_IDENTITY = createReleaseBundle({
  pluginId: "openai-compatible-imagegen-v2",
  pluginVersion: "0.1.0-test",
  serverBuildInputs: [{ path: "mcp/server.mjs", content: "project binding server" }],
  widgetHtml: `<html><head>${RELEASE_IDENTITY_PLACEHOLDER}</head></html>`,
}).releaseIdentity;
const IMAGE_ID = "img_01J00000000000000000000000";
const EDITOR_SESSION_ID = `eds_${"0".repeat(32)}`;
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL1WQAAAABJRU5ErkJggg==";
const HOST_OBSERVATIONS = [
  {
    source: "ui/notifications/tool-result",
    fields: [],
    errorCodes: [],
    truncated: false,
  },
  {
    source: "tools/call",
    fields: [],
    errorCodes: [],
    truncated: false,
  },
];


test("project binding requires the OpenAI conversation identity", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA }) => {
    const server = createTestServer({ pluginRoot });
    try {
      const handler = server._registeredTools.bind_imagegen_project?.handler;
      assert.equal(typeof handler, "function");

      const result = await handler(
        { projectRoot: projectA },
        { sessionId: "transport-session", _meta: {} },
      );

      assertStableError(result, "session_identity_unavailable", ["transport-session", projectA]);
    } finally {
      await server.close();
    }
  });
});


test("project binding is idempotent across transports in one OpenAI conversation", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA }) => {
    const taskCalls = [];
    const server = createTestServer({
      pluginRoot,
      runTask: async (task, context) => {
        taskCalls.push({ task, context });
        return { ok: true, models: [] };
      },
    });
    const bind = server._registeredTools.bind_imagegen_project.handler;
    const listModels = server._registeredTools.list_image_models.handler;
    const sessionMeta = { "openai/session": "conversation-a" };
    try {
      const first = await bind(
        { projectRoot: projectA },
        { sessionId: "widget-transport", _meta: sessionMeta },
      );
      const second = await bind(
        { projectRoot: path.join(projectA, ".") },
        { sessionId: "model-transport", _meta: sessionMeta },
      );
      const catalog = await listModels({}, {
        sessionId: "another-transport",
        _meta: sessionMeta,
      });

      assert.deepEqual(first.structuredContent, { status: "bound" });
      assert.deepEqual(second.structuredContent, { status: "already_bound" });
      assert.deepEqual(catalog.structuredContent, { models: [] });
      assert.equal(taskCalls.length, 1);
      assert.equal(taskCalls[0].context.projectRoot, path.resolve(projectA));
      assert.equal(taskCalls[0].context.artifactRoot, path.join(path.resolve(projectA), "output", "imagegen"));
      assert.match(taskCalls[0].context.bindingKey, /^[a-f0-9]{64}$/);
      assertValuesHidden([first, second, catalog], [projectA, "conversation-a"]);
    } finally {
      await server.close();
    }
  });
});


test("project bindings reject conflicts and isolate projects by OpenAI conversation", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA, projectB }) => {
    const reads = [];
    const server = createTestServer({
      pluginRoot,
      readArtifact: async (imageId, context) => {
        reads.push({ imageId, projectRoot: context.projectRoot });
        return { metadata: artifact(imageId), data: PNG_BASE64 };
      },
    });
    const bind = server._registeredTools.bind_imagegen_project.handler;
    const readArtifact = server._registeredTools.get_image_artifact.handler;
    const sessionA = { "openai/session": "conversation-a" };
    const sessionB = { "openai/session": "conversation-b" };
    try {
      await bind({ projectRoot: projectA }, { _meta: sessionA });
      await bind({ projectRoot: projectB }, { _meta: sessionB });

      const conflict = await bind({ projectRoot: projectB }, { _meta: sessionA });
      assertStableError(conflict, "project_binding_conflict", [projectA, projectB, "conversation-a"]);

      const resultA = await readArtifact({ imageId: IMAGE_ID }, { _meta: sessionA });
      const resultB = await readArtifact({ imageId: IMAGE_ID }, { _meta: sessionB });
      assert.equal(resultA.isError, undefined);
      assert.equal(resultB.isError, undefined);
      assert.deepEqual(reads, [
        { imageId: IMAGE_ID, projectRoot: path.resolve(projectA) },
        { imageId: IMAGE_ID, projectRoot: path.resolve(projectB) },
      ]);
      assertValuesHidden([resultA, resultB], [projectA, projectB, "conversation-a", "conversation-b"]);
    } finally {
      await server.close();
    }
  });
});


test("bound projects fail closed when the root is replaced with a linked directory", async () => {
  await withProjectRoots(async ({ root, pluginRoot, projectA, projectB }) => {
    let reads = 0;
    const server = createTestServer({
      pluginRoot,
      readArtifact: async (imageId) => {
        reads += 1;
        return { metadata: artifact(imageId), data: PNG_BASE64 };
      },
    });
    const bind = server._registeredTools.bind_imagegen_project.handler;
    const getArtifact = server._registeredTools.get_image_artifact.handler;
    const renderResults = server._registeredTools.render_image_results.handler;
    const inspectRuntime = server._registeredTools.inspect_imagegen_runtime.handler;
    const extra = { _meta: { "openai/session": "replaced-root-conversation" } };
    const movedProject = path.join(root, "workspace-a-original");
    try {
      await bind({ projectRoot: projectA }, extra);
      await rename(projectA, movedProject);
      await symlink(projectB, projectA, process.platform === "win32" ? "junction" : "dir");

      const artifactResult = await getArtifact({ imageId: IMAGE_ID }, extra);
      const renderResult = await renderResults({ imageIds: [IMAGE_ID] }, extra);
      const diagnosticResult = await inspectRuntime({}, extra);

      assertStableError(artifactResult, "project_root_invalid", [projectA, projectB]);
      assertStableError(renderResult, "project_root_invalid", [projectA, projectB]);
      assertStableError(diagnosticResult, "project_root_invalid", [projectA, projectB]);
      assert.equal(reads, 0);
    } finally {
      await server.close();
    }
  });
});


test("project binding conflicts do not probe a second candidate root", async () => {
  await withProjectRoots(async ({ root, pluginRoot, projectA, projectB }) => {
    const missingRoot = path.join(root, "missing-project");
    const fileRoot = path.join(root, "project-file.txt");
    const linkedRoot = path.join(root, "linked-project");
    await writeFile(fileRoot, "not a directory");
    await symlink(projectB, linkedRoot, process.platform === "win32" ? "junction" : "dir");

    const server = createTestServer({ pluginRoot });
    const bind = server._registeredTools.bind_imagegen_project.handler;
    const extra = { _meta: { "openai/session": "conflict-conversation" } };
    try {
      await bind({ projectRoot: projectA }, extra);
      for (const candidate of [missingRoot, fileRoot, linkedRoot, pluginRoot, "relative-project"] ) {
        const result = await bind({ projectRoot: candidate }, extra);
        assertStableError(result, "project_binding_conflict", [candidate, "conflict-conversation"]);
      }
    } finally {
      await server.close();
    }
  });
});


test("editor state is isolated by project binding", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA, projectB }) => {
    const server = createTestServer({ pluginRoot });
    const bind = server._registeredTools.bind_imagegen_project.handler;
    const openEditor = server._registeredTools.open_image_editor.handler;
    const getEditor = server._registeredTools.get_image_editor_session.handler;
    const destroyEditor = server._registeredTools.destroy_image_editor.handler;
    const finalizeEditor = server._registeredTools.finalize_image_editor_session.handler;
    const getArtifact = server._registeredTools.get_image_artifact.handler;
    const extraA = { _meta: { "openai/session": "editor-conversation-a" } };
    const extraB = { _meta: { "openai/session": "editor-conversation-b" } };
    try {
      await bind({ projectRoot: projectA }, extraA);
      await bind({ projectRoot: projectB }, extraB);
      const openedA = await openEditor({ imageId: IMAGE_ID }, extraA);
      const openedB = await openEditor({ imageId: IMAGE_ID }, extraB);
      const sessionA = openedA.structuredContent.editorSession.id;
      const sessionB = openedB.structuredContent.editorSession.id;

      const foreignRead = await getEditor({ editorSessionId: sessionA }, extraB);
      assertStableError(foreignRead, "editor_session_not_found", ["editor-conversation-a"]);
      const foreignDestroy = await destroyEditor({ editorSessionId: sessionA }, extraB);
      assert.equal(foreignDestroy.structuredContent.editorSession.status, "released");
      const foreignFinalize = await finalizeEditor({ editorSessionId: sessionA }, extraB);
      assert.equal(foreignFinalize.structuredContent.editorSession.status, "released");

      const stillActiveA = await getEditor({ editorSessionId: sessionA }, extraA);
      assert.equal(stillActiveA.structuredContent.editorSession.status, "active");
      await destroyEditor({ editorSessionId: sessionA }, extraA);

      const projectAArtifact = await getArtifact({ imageId: IMAGE_ID }, extraA);
      const projectBArtifact = await getArtifact({ imageId: IMAGE_ID }, extraB);
      const stillActiveB = await getEditor({ editorSessionId: sessionB }, extraB);
      assert.equal(projectAArtifact.structuredContent.canvasStatus, "destroyed");
      assert.equal(projectBArtifact.structuredContent.canvasStatus, "available");
      assert.equal(stillActiveB.structuredContent.editorSession.status, "active");
      assertValuesHidden(
        [foreignRead, foreignDestroy, foreignFinalize, projectAArtifact, projectBArtifact],
        [projectA, projectB, "editor-conversation-a", "editor-conversation-b"],
      );
    } finally {
      await server.close();
    }
  });
});


test("all business and app-only tools fail closed before project binding", async () => {
  await withProjectRoots(async ({ pluginRoot }) => {
    let dependencyCalls = 0;
    const unavailable = async () => {
      dependencyCalls += 1;
      throw new Error("dependency must not run");
    };
    const server = createTestServer({
      pluginRoot,
      runTask: unavailable,
      readArtifact: unavailable,
      readAnnotation: unavailable,
      saveAnnotations: unavailable,
    });
    const extra = { _meta: { "openai/session": "unbound-conversation" } };
    const calls = [
      ["list_image_models", {}],
      ["generate_image", { prompt: "test" }],
      ["edit_image", { parentImageId: IMAGE_ID, prompt: "test" }],
      ["get_image_artifact", { imageId: IMAGE_ID }],
      ["read_image_artifact_data", { imageId: IMAGE_ID }],
      ["render_image_results", { imageIds: [IMAGE_ID] }],
      ["report_imagegen_host_observation", {
        releaseFingerprint: RELEASE_IDENTITY.fingerprint,
        observations: HOST_OBSERVATIONS,
      }],
      ["open_image_editor", { imageId: IMAGE_ID }],
      ["save_image_annotations", {
        imageId: IMAGE_ID,
        items: [{ id: "rect", type: "rectangle", x: 0.1, y: 0.1, width: 0.5, height: 0.5 }],
      }],
      ["get_image_editor_session", { editorSessionId: EDITOR_SESSION_ID }],
      ["destroy_image_editor", { editorSessionId: EDITOR_SESSION_ID }],
      ["finalize_image_editor_session", { editorSessionId: EDITOR_SESSION_ID }],
    ];
    try {
      for (const [name, arguments_] of calls) {
        const result = await server._registeredTools[name].handler(arguments_, extra);
        assertStableError(result, "project_binding_required", ["unbound-conversation"]);
      }
      assert.equal(dependencyCalls, 0);
    } finally {
      await server.close();
    }
  });
});


test("transport session IDs never substitute for the OpenAI conversation identity", async () => {
  await withProjectRoots(async ({ pluginRoot }) => {
    const server = createTestServer({ pluginRoot });
    try {
      const result = await server._registeredTools.list_image_models.handler(
        {},
        { sessionId: "transport-only-session" },
      );
      assertStableError(result, "session_identity_unavailable", ["transport-only-session"]);
    } finally {
      await server.close();
    }
  });
});


test("project bindings are process-local and disappear when the server restarts", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA }) => {
    const session = { _meta: { "openai/session": "restart-conversation" } };
    const firstServer = createTestServer({ pluginRoot });
    await firstServer._registeredTools.bind_imagegen_project.handler({ projectRoot: projectA }, session);
    await firstServer.close();

    const restartedServer = createTestServer({ pluginRoot });
    try {
      const result = await restartedServer._registeredTools.list_image_models.handler({}, session);
      assertStableError(result, "project_binding_required", [projectA, "restart-conversation"]);
    } finally {
      await restartedServer.close();
    }
  });
});


test("project binding rejects invalid, linked, and plugin-owned roots without disclosure", async () => {
  await withProjectRoots(async ({ root, pluginRoot, projectA }) => {
    const missingRoot = path.join(root, "missing-project");
    const fileRoot = path.join(root, "project-file.txt");
    const linkedRoot = path.join(root, "linked-project");
    const pluginChild = path.join(pluginRoot, "nested-project");
    await writeFile(fileRoot, "not a directory");
    await mkdir(pluginChild);
    await symlink(projectA, linkedRoot, process.platform === "win32" ? "junction" : "dir");

    const server = createTestServer({ pluginRoot });
    const bind = server._registeredTools.bind_imagegen_project.handler;
    const cases = [
      ["relative-project", "project_root_invalid"],
      [missingRoot, "project_root_invalid"],
      [fileRoot, "project_root_invalid"],
      [linkedRoot, "project_root_invalid"],
      [pluginRoot, "project_root_is_plugin_root"],
      [pluginChild, "project_root_is_plugin_root"],
    ];
    try {
      for (const [projectRoot, code] of cases) {
        const sessionId = `invalid-${cases.indexOf(cases.find((item) => item[0] === projectRoot))}`;
        const result = await bind(
          { projectRoot },
          { _meta: { "openai/session": sessionId } },
        );
        assertStableError(result, code, [projectRoot, sessionId]);
      }
    } finally {
      await server.close();
    }
  });
});


test("runtime diagnostics report an unbound root and then the explicit session binding", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA }) => {
    const server = createTestServer({ pluginRoot });
    const extra = { _meta: { "openai/session": "diagnostic-conversation" } };
    try {
      const before = await server._registeredTools.inspect_imagegen_runtime.handler({}, extra);
      assert.equal(before.structuredContent.runtime.projectRootFingerprint, null);
      assert.equal(before.structuredContent.runtime.projectRootRelationToPlugin, null);
      assert.equal(before.structuredContent.runtime.projectRootSource, "unbound");

      await server._registeredTools.bind_imagegen_project.handler({ projectRoot: projectA }, extra);
      const after = await server._registeredTools.inspect_imagegen_runtime.handler({}, extra);
      assert.match(after.structuredContent.runtime.projectRootFingerprint, /^[a-f0-9]{20}$/);
      assert.equal(after.structuredContent.runtime.projectRootRelationToPlugin, "outside");
      assert.equal(after.structuredContent.runtime.projectRootSource, "explicit_tool");
      assertValuesHidden([before, after], [projectA, "diagnostic-conversation"]);
    } finally {
      await server.close();
    }
  });
});


function createTestServer({
  pluginRoot,
  runTask = async () => ({ ok: true, models: [] }),
  readArtifact = async (imageId) => ({ metadata: artifact(imageId), data: PNG_BASE64 }),
  readAnnotation = async () => ({ id: "ann_01J00000000000000000000000", imageId: IMAGE_ID, maskPath: null }),
  saveAnnotations = async () => ({
    id: "ann_01J00000000000000000000000",
    imageId: IMAGE_ID,
    itemCount: 1,
    previewMimeType: "image/svg+xml",
    hasMask: false,
    maskMimeType: null,
  }),
} = {}) {
  return createImagegenServer({
    releaseIdentity: RELEASE_IDENTITY,
    launchContext: {
      cwd: pluginRoot,
      pluginRoot,
    },
    readWidgetHtml: async () => "<html></html>",
    runTask,
    readArtifact,
    readAnnotation,
    saveAnnotations,
  });
}


async function withProjectRoots(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-project-binding-"));
  const pluginRoot = path.join(root, "plugin-cache", "openai-compatible-imagegen-v2");
  const projectA = path.join(root, "workspace-a");
  const projectB = path.join(root, "workspace-b");
  await Promise.all([
    mkdir(pluginRoot, { recursive: true }),
    mkdir(projectA),
    mkdir(projectB),
  ]);
  try {
    await callback({ root, pluginRoot, projectA, projectB });
  } finally {
    await rm(root, { recursive: true });
  }
}


function artifact(id) {
  return {
    id,
    parentIds: [],
    childIds: [],
    mimeType: "image/png",
    width: 1,
    height: 1,
    provider: "primary",
    model: "gpt-image-2",
    operation: "generate",
    prompt: "test prompt",
    parameters: {},
    annotationId: null,
    createdAt: "2026-08-06T00:00:00.000Z",
  };
}


function assertStableError(result, code, hiddenValues = []) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.match(result.content?.[0]?.text ?? "", new RegExp(`^${code}:`));
  assertValuesHidden([result], hiddenValues);
}


function assertValuesHidden(results, hiddenValues) {
  const serialized = JSON.stringify(results);
  for (const value of hiddenValues) {
    assert.equal(serialized.includes(value), false, `tool result exposed ${value}`);
  }
}
