import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createImagegenServer } from "../mcp/create-server.mjs";
import { resolveV2StorageBinding } from "../mcp/config-resolution.mjs";
import { createProjectContext } from "../mcp/project-context.mjs";
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


test("path leak assertions detect Windows paths after JSON escaping", () => {
  const windowsRoot = "C:\\Users\\tester\\workspace";
  assert.throws(
    () => assertValuesHidden([{ content: [{ type: "text", text: `failed: ${windowsRoot}` }] }], [windowsRoot]),
    /tool result exposed/,
  );
});


test("project binding works without host conversation metadata", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA }) => {
    const server = createTestServer({ pluginRoot });
    try {
      const handler = server._registeredTools.bind_imagegen_project?.handler;
      assert.equal(typeof handler, "function");

      const result = await handler(
        { projectRoot: projectA },
        { sessionId: "transport-session", _meta: {} },
      );

      assert.deepEqual(result.structuredContent, { status: "bound" });
      assertValuesHidden([result], [projectA]);
    } finally {
      await server.close();
    }
  });
});


test("project binding rejects V1 flat config before accepting the project", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA }) => {
    const configPath = projectConfigPath(projectA);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      api_key_env: "IMAGE_API_KEY",
      base_url: "https://example.test/v1",
      model: "gpt-image-2",
    }));
    const server = createTestServer({ pluginRoot });
    try {
      const result = await server._registeredTools.bind_imagegen_project.handler(
        { projectRoot: projectA },
        { sessionId: "v1-config-transport", _meta: {} },
      );

      assertStableError(result, "v2_config_invalid", [projectA, configPath]);
    } finally {
      await server.close();
    }
  });
});


test("project binding rejects Python-invalid V2 provider fields without running a task", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA }) => {
    let taskCalls = 0;
    const configPath = projectConfigPath(projectA);
    const cases = [
      { base_url: "/" },
      { base_url: "\u0085" },
      { url_download: [] },
      { url_download: { proxy_mode: "automatic" } },
      { url_download: { proxy_mode: null } },
      { user_agent: "invalid\r\nheader" },
      { user_agent: "\ufeff\r\nheader" },
    ];

    for (const providerOverrides of cases) {
      await writeProjectConfig(projectA, {
        providers: {
          primary: {
            protocol: "openai-compatible",
            base_url: "https://example.test/v1",
            api_key_env: "IMAGE_API_KEY",
            ...providerOverrides,
          },
        },
      });
      const server = createTestServer({
        pluginRoot,
        runTask: async () => {
          taskCalls += 1;
          return { ok: true, models: [] };
        },
      });
      try {
        const result = await server._registeredTools.bind_imagegen_project.handler(
          { projectRoot: projectA },
          { sessionId: "invalid-provider-transport", _meta: {} },
        );

        assertStableError(result, "v2_config_invalid", [projectA, configPath]);
      } finally {
        await server.close();
      }
    }
    assert.equal(taskCalls, 0);
  });
});


test("project binding is idempotent across callers in one MCP process", async () => {
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
    try {
      const first = await bind(
        { projectRoot: projectA },
        { sessionId: "widget-transport", _meta: {} },
      );
      const second = await bind(
        { projectRoot: path.join(projectA, ".") },
        { sessionId: "model-transport", _meta: {} },
      );
      const catalog = await listModels({}, {
        sessionId: "another-transport",
        _meta: {},
      });

      assert.deepEqual(first.structuredContent, { status: "bound" });
      assert.deepEqual(second.structuredContent, { status: "already_bound" });
      assert.deepEqual(catalog.structuredContent, { models: [] });
      assert.equal(taskCalls.length, 1);
      assert.equal(taskCalls[0].context.projectRoot, path.resolve(projectA));
      assert.equal(taskCalls[0].context.artifactRoot, path.join(path.resolve(projectA), "output", "imagegen"));
      assert.equal(taskCalls[0].context.configPath, path.join(path.resolve(projectA), ".codex", "openai-compatible-imagegen-v2", "config.json"));
      assert.match(taskCalls[0].context.configSha256, /^[a-f0-9]{64}$/);
      assert.match(taskCalls[0].context.bindingKey, /^[a-f0-9]{64}$/);
      assertValuesHidden([first, second, catalog], [projectA]);
    } finally {
      await server.close();
    }
  });
});


test("project binding freezes the selected config and rejects later changes", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA }) => {
    let taskCalls = 0;
    const server = createTestServer({
      pluginRoot,
      runTask: async () => {
        taskCalls += 1;
        return { ok: true, models: [] };
      },
    });
    const bind = server._registeredTools.bind_imagegen_project.handler;
    const listModels = server._registeredTools.list_image_models.handler;
    const extra = { sessionId: "changed-config-transport", _meta: {} };
    const configPath = projectConfigPath(projectA);
    try {
      await bind({ projectRoot: projectA }, extra);
      await writeProjectConfig(projectA, { storage: { output_directory: "changed-output" } });

      const result = await listModels({}, extra);

      assertStableError(result, "v2_config_changed", [projectA, configPath]);
      assert.equal(taskCalls, 0);
    } finally {
      await server.close();
    }
  });
});


test("project binding rejects a second root and keeps the active root", async () => {
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
    const callerA = { sessionId: "caller-a", _meta: {} };
    const callerB = { sessionId: "caller-b", _meta: {} };
    try {
      await bind({ projectRoot: projectA }, callerA);

      const conflict = await bind({ projectRoot: projectB }, callerB);
      assertStableError(conflict, "project_binding_conflict", [projectA, projectB]);

      const resultA = await readArtifact({ imageId: IMAGE_ID }, callerA);
      const resultB = await readArtifact({ imageId: IMAGE_ID }, callerB);
      assert.equal(resultA.isError, undefined);
      assert.equal(resultB.isError, undefined);
      assert.deepEqual(reads, [
        { imageId: IMAGE_ID, projectRoot: path.resolve(projectA) },
        { imageId: IMAGE_ID, projectRoot: path.resolve(projectA) },
      ]);
      assertValuesHidden([resultA, resultB], [projectA, projectB]);
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
    const extra = { sessionId: "replaced-root-transport", _meta: {} };
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
    const extra = { sessionId: "conflict-transport", _meta: {} };
    try {
      await bind({ projectRoot: projectA }, extra);
      for (const candidate of [missingRoot, fileRoot, linkedRoot, pluginRoot, "relative-project"] ) {
        const result = await bind({ projectRoot: candidate }, extra);
        assertStableError(result, "project_binding_conflict", [candidate]);
      }
    } finally {
      await server.close();
    }
  });
});


test("editor state is isolated between MCP processes", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA, projectB }) => {
    const serverA = createTestServer({ pluginRoot });
    const serverB = createTestServer({ pluginRoot });
    const bindA = serverA._registeredTools.bind_imagegen_project.handler;
    const bindB = serverB._registeredTools.bind_imagegen_project.handler;
    const openEditorA = serverA._registeredTools.open_image_editor.handler;
    const openEditorB = serverB._registeredTools.open_image_editor.handler;
    const getEditorA = serverA._registeredTools.get_image_editor_session.handler;
    const getEditorB = serverB._registeredTools.get_image_editor_session.handler;
    const destroyEditorA = serverA._registeredTools.destroy_image_editor.handler;
    const finalizeEditorB = serverB._registeredTools.finalize_image_editor_session.handler;
    const getArtifactA = serverA._registeredTools.get_image_artifact.handler;
    const getArtifactB = serverB._registeredTools.get_image_artifact.handler;
    const callerA = { sessionId: "editor-transport-a", _meta: {} };
    const callerB = { sessionId: "editor-transport-b", _meta: {} };
    try {
      await bindA({ projectRoot: projectA }, callerA);
      await bindB({ projectRoot: projectB }, callerB);
      const openedA = await openEditorA({ imageId: IMAGE_ID }, callerA);
      const openedB = await openEditorB({ imageId: IMAGE_ID }, callerB);
      const sessionA = openedA.structuredContent.editorSession.id;
      const sessionB = openedB.structuredContent.editorSession.id;

      const foreignRead = await getEditorB({ editorSessionId: sessionA }, callerB);
      assertStableError(foreignRead, "editor_session_not_found");
      const foreignDestroy = await serverB._registeredTools.destroy_image_editor.handler(
        { editorSessionId: sessionA },
        callerB,
      );
      assert.equal(foreignDestroy.structuredContent.editorSession.status, "released");
      const foreignFinalize = await finalizeEditorB({ editorSessionId: sessionA }, callerB);
      assert.equal(foreignFinalize.structuredContent.editorSession.status, "released");

      const stillActiveA = await getEditorA({ editorSessionId: sessionA }, callerA);
      assert.equal(stillActiveA.structuredContent.editorSession.status, "active");
      await destroyEditorA({ editorSessionId: sessionA }, callerA);

      const projectAArtifact = await getArtifactA({ imageId: IMAGE_ID }, callerA);
      const projectBArtifact = await getArtifactB({ imageId: IMAGE_ID }, callerB);
      const stillActiveB = await getEditorB({ editorSessionId: sessionB }, callerB);
      assert.equal(projectAArtifact.structuredContent.canvasStatus, "destroyed");
      assert.equal(projectBArtifact.structuredContent.canvasStatus, "available");
      assert.equal(stillActiveB.structuredContent.editorSession.status, "active");
      assertValuesHidden(
        [foreignRead, foreignDestroy, foreignFinalize, projectAArtifact, projectBArtifact],
        [projectA, projectB],
      );
    } finally {
      await Promise.all([serverA.close(), serverB.close()]);
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
    const extra = { sessionId: "unbound-transport", _meta: {} };
    const calls = [
      ["list_image_models", {}],
      ["batch_images", {
        items: [{ requestId: "generate-a", operation: "generate", prompt: "test" }],
      }],
      ["generate_image", { prompt: "test" }],
      ["edit_image", { parentImageId: IMAGE_ID, prompt: "test" }],
      ["deliver_image", { imageId: IMAGE_ID, delivery: { qa: true } }],
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
        assertStableError(result, "project_binding_required");
      }
      assert.equal(dependencyCalls, 0);
    } finally {
      await server.close();
    }
  });
});


test("transport metadata never selects a project root", async () => {
  await withProjectRoots(async ({ pluginRoot }) => {
    const server = createTestServer({ pluginRoot });
    try {
      const result = await server._registeredTools.list_image_models.handler(
        {},
        { sessionId: "transport-only-session" },
      );
      assertStableError(result, "project_binding_required");
    } finally {
      await server.close();
    }
  });
});


test("project bindings are process-local and disappear when the server restarts", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA }) => {
    const caller = { sessionId: "restart-transport", _meta: {} };
    const firstServer = createTestServer({ pluginRoot });
    await firstServer._registeredTools.bind_imagegen_project.handler({ projectRoot: projectA }, caller);
    await firstServer.close();

    const restartedServer = createTestServer({ pluginRoot });
    try {
      const result = await restartedServer._registeredTools.list_image_models.handler({}, caller);
      assertStableError(result, "project_binding_required");
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
        const caller = { sessionId: `invalid-${cases.indexOf(cases.find((item) => item[0] === projectRoot))}`, _meta: {} };
        const result = await bind(
          { projectRoot },
          caller,
        );
        assertStableError(result, code, [projectRoot]);
      }
    } finally {
      await server.close();
    }
  });
});


test("runtime diagnostics report an unbound root and then the explicit process binding", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA }) => {
    const server = createTestServer({ pluginRoot });
    const extra = { sessionId: "diagnostic-transport", _meta: {} };
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
      assertValuesHidden([before, after], [projectA]);
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
    maskPolicy: null,
  }),
} = {}) {
  const userHome = path.join(path.dirname(path.dirname(pluginRoot)), "test-home");
  return createImagegenServer({
    releaseIdentity: RELEASE_IDENTITY,
    launchContext: {
      cwd: pluginRoot,
      pluginRoot,
    },
    readWidgetHtml: async () => "<html></html>",
    projectContext: createProjectContext({
      pluginRoot,
      resolveStorageBinding: async ({ projectRoot }) => await resolveV2StorageBinding({ projectRoot, userHome }),
    }),
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
  await Promise.all([writeProjectConfig(projectA), writeProjectConfig(projectB)]);
  try {
    await callback({ root, pluginRoot, projectA, projectB });
  } finally {
    await rm(root, { recursive: true });
  }
}


function projectConfigPath(projectRoot) {
  return path.join(projectRoot, ".codex", "openai-compatible-imagegen-v2", "config.json");
}


async function writeProjectConfig(projectRoot, extra = {}) {
  const configPath = projectConfigPath(projectRoot);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    providers: {
      primary: {
        protocol: "openai-compatible",
        base_url: "https://example.test/v1",
        api_key_env: "IMAGE_API_KEY",
      },
    },
    models: {
      "primary/gpt-image-2": {
        provider: "primary",
        model: "gpt-image-2",
        capabilities: { generate: true, edit: true, mask: true },
      },
    },
    ...extra,
  }));
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
  const resultStrings = collectStringValues(results).map(normalizeStringForComparison);
  for (const value of hiddenValues) {
    const normalizedValue = normalizeStringForComparison(value);
    assert.equal(
      resultStrings.some((candidate) => candidate.includes(normalizedValue)),
      false,
      `tool result exposed ${value}`,
    );
  }
}


function collectStringValues(value, result = []) {
  if (typeof value === "string") {
    result.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, result);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      result.push(key);
      collectStringValues(item, result);
    }
  }
  return result;
}


function normalizeStringForComparison(value) {
  const normalized = String(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
