import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createImagegenServer } from "../mcp/create-server.mjs";
import { resolveImageConfigBinding } from "../mcp/config-resolution.mjs";
import { createProjectContext } from "../mcp/project-context.mjs";
import { createReleaseBundle, RELEASE_IDENTITY_PLACEHOLDER } from "../mcp/release-identity.mjs";
import { latestCommittedRecordPath } from "./support/fenced-record-fixture.mjs";


const RELEASE_IDENTITY = createReleaseBundle({
  pluginId: "openai-compatible-imagegen",
  pluginVersion: "0.1.0-test",
  serverBuildInputs: [{ path: "mcp/server.mjs", content: "project binding server" }],
  widgetHtml: `<html><head>${RELEASE_IDENTITY_PLACEHOLDER}</head></html>`,
}).releaseIdentity;
const IMAGE_ID = "img_01J00000000000000000000000";
const EDITOR_SESSION_ID = `eds_${"0".repeat(32)}`;
const PROJECT_BINDING_ID_PATTERN = /^pbind_[0-9a-f]{64}$/;
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

const PROJECT_BOUND_TOOL_NAMES = [
  "report_imagegen_host_observation",
  "list_image_models",
  "generate_image",
  "edit_image",
  "batch_images",
  "get_image_batch_manifest",
  "get_image_delivery_receipt",
  "deliver_image",
  "get_image_artifact",
  "read_image_artifact_data",
  "reveal_image_artifact",
  "render_image_results",
  "open_image_editor",
  "save_image_annotations",
  "prepare_image_edit_submission",
  "get_image_editor_session",
  "destroy_image_editor",
  "finalize_image_editor_session",
];


test("path leak assertions detect Windows paths after JSON escaping", () => {
  const windowsRoot = "C:\\Users\\tester\\workspace";
  assert.throws(
    () => assertValuesHidden([{ content: [{ type: "text", text: `failed: ${windowsRoot}` }] }], [windowsRoot]),
    /tool result exposed/,
  );
});


test("explicit project binding IDs restore one project across MCP processes without host metadata", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA }) => {
    const modelServer = createTestServer({ pluginRoot });
    const widgetServer = createTestServer({ pluginRoot });
    try {
      const bound = await modelServer._registeredTools.bind_imagegen_project.handler(
        { projectRoot: projectA },
        { sessionId: "model-transport" },
      );
      assert.match(bound.structuredContent?.projectBindingId, PROJECT_BINDING_ID_PATTERN);

      const catalog = await widgetServer._registeredTools.list_image_models.handler(
        { projectBindingId: bound.structuredContent.projectBindingId },
        { sessionId: "widget-transport" },
      );

      assert.equal(bound.structuredContent.status, "bound");
      assert.deepEqual(catalog.structuredContent, { models: [] });
      assertValuesHidden([bound, catalog], [projectA]);
    } finally {
      await Promise.all([modelServer.close(), widgetServer.close()]);
    }
  });
});


test("all project-bound tools require an explicit project binding ID", async () => {
  await withProjectRoots(async ({ pluginRoot }) => {
    const server = createTestServer({ pluginRoot });
    try {
      assert.equal(Object.keys(server._registeredTools).length, 20);
      for (const name of PROJECT_BOUND_TOOL_NAMES) {
        const schema = server._registeredTools[name]?.inputSchema;
        assert.notEqual(schema, undefined, `${name} input schema missing`);
        assert.notEqual(schema.shape.projectBindingId, undefined, `${name} projectBindingId missing`);
        assert.equal(schema.shape.projectBindingId.isOptional(), false, `${name} projectBindingId must be required`);
      }
      assert.equal(server._registeredTools.inspect_imagegen_runtime.inputSchema.shape.projectBindingId.isOptional(), true);
      assert.equal(server._registeredTools.bind_imagegen_project.inputSchema.shape.projectBindingId.isOptional(), true);
    } finally {
      await server.close();
    }
  });
});


test("runtime diagnostics distinguish no binding ID from an unknown explicit binding ID", async () => {
  await withProjectRoots(async ({ pluginRoot }) => {
    const server = createTestServer({ pluginRoot });
    try {
      const unbound = await server._registeredTools.inspect_imagegen_runtime.handler({});
      assert.equal(unbound.isError, undefined);
      assert.equal(unbound.structuredContent.runtime.projectRootSource, "unbound");

      const unknown = await server._registeredTools.inspect_imagegen_runtime.handler({
        projectBindingId: `pbind_${"f".repeat(64)}`,
      });
      assertStableError(unknown, "project_binding_required");
    } finally {
      await server.close();
    }
  });
});


test("binding rejects malformed explicit project binding IDs", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA }) => {
    const server = createTestServer({ pluginRoot });
    try {
      for (const projectBindingId of ["pbind_1234", `pbind_${"A".repeat(64)}`, "legacy-session"]) {
        const result = await server._registeredTools.bind_imagegen_project.handler({ projectRoot: projectA, projectBindingId });
        assertStableError(result, "project_binding_invalid");
      }
    } finally {
      await server.close();
    }
  });
});


test("different explicit binding IDs isolate projects in one MCP process", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA, projectB }) => {
    const reads = [];
    const server = createTestServer({
      pluginRoot,
      readArtifact: async (imageId, context) => {
        reads.push(context.projectRoot);
        return { metadata: artifact(imageId), data: PNG_BASE64 };
      },
    });
    try {
      const boundA = await server._registeredTools.bind_imagegen_project.handler({ projectRoot: projectA });
      const boundB = await server._registeredTools.bind_imagegen_project.handler({ projectRoot: projectB });
      const artifactA = await server._registeredTools.get_image_artifact.handler(
        { projectBindingId: boundA.structuredContent.projectBindingId, imageId: IMAGE_ID },
      );
      const artifactB = await server._registeredTools.get_image_artifact.handler(
        { projectBindingId: boundB.structuredContent.projectBindingId, imageId: IMAGE_ID },
      );

      assert.equal(boundA.structuredContent.status, "bound");
      assert.equal(boundB.structuredContent.status, "bound");
      assert.equal(artifactA.isError, undefined);
      assert.equal(artifactB.isError, undefined);
      assert.deepEqual(reads, [path.resolve(projectA), path.resolve(projectB)]);
      assertValuesHidden([boundA, boundB, artifactA, artifactB], [projectA, projectB]);
    } finally {
      await server.close();
    }
  });
});


test("project binding rejects legacy flat project config before accepting the project", async () => {
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
      );

      assertStableError(result, "project_config_forbidden", [projectA, configPath]);
    } finally {
      await server.close();
    }
  });
});


test("project binding rejects invalid user provider fields without running a task", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA, userHome }) => {
    let taskCalls = 0;
    const configPath = userConfigPath(userHome);
    const cases = [
      { base_url: "/" },
      { base_url: "\u0085" },
      { url_download: [] },
      { url_download: { proxy_mode: "automatic" } },
      { user_agent: "invalid\r\nheader" },
      { user_agent: "\ufeff\r\nheader" },
    ];

    for (const providerOverrides of cases) {
      await writeUserConfig(userHome, providerOverrides);
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
        );

        assertStableError(result, "image_config_invalid", [projectA, configPath]);
      } finally {
        await server.close();
      }
    }
    assert.equal(taskCalls, 0);
  });
});


test("explicit project binding is idempotent when callers reuse its ID", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA, userHome }) => {
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
      const first = await bind({ projectRoot: projectA });
      const projectBindingId = first.structuredContent.projectBindingId;
      const second = await bind({ projectRoot: path.join(projectA, "."), projectBindingId });
      const catalog = await listModels({ projectBindingId });

      assert.deepEqual(first.structuredContent, { status: "bound", projectBindingId });
      assert.deepEqual(second.structuredContent, { status: "already_bound", projectBindingId });
      assert.deepEqual(catalog.structuredContent, { models: [] });
      assert.equal(taskCalls.length, 1);
      assert.equal(taskCalls[0].context.projectRoot, path.resolve(projectA));
      assert.equal(taskCalls[0].context.artifactRoot, path.join(path.resolve(projectA), "output", "imagegen"));
      assert.equal(taskCalls[0].context.userConfigPath, userConfigPath(userHome));
      assert.equal(taskCalls[0].context.projectConfigPath, projectConfigPath(projectA));
      assert.match(taskCalls[0].context.userConfigSha256, /^[a-f0-9]{64}$/);
      assert.match(taskCalls[0].context.projectConfigSha256, /^[a-f0-9]{64}$/);
      assert.match(taskCalls[0].context.effectiveConfigSha256, /^[a-f0-9]{64}$/);
      assert.equal(taskCalls[0].context.activeProfile, "primary/gpt-image-2");
      assert.deepEqual(taskCalls[0].context.runtimeDefaults, { timeout_seconds: 600, concurrency: 3 });
      assert.equal(JSON.parse(taskCalls[0].context.effectiveConfigJson).config_version, 1);
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
    const configPath = projectConfigPath(projectA);
    try {
      const first = await bind({ projectRoot: projectA });
      const projectBindingId = first.structuredContent.projectBindingId;
      await writeProjectConfig(projectA, { storage: { output_directory: "changed-output" } });

      const result = await listModels({ projectBindingId });

      assertStableError(result, "image_config_changed", [projectA, configPath]);
      assert.equal(taskCalls, 0);

      const rebound = await bind({ projectRoot: projectA, projectBindingId });
      const recovered = await listModels({ projectBindingId });
      assert.deepEqual(rebound.structuredContent, { status: "rebound", projectBindingId });
      assert.equal(rebound.content?.[0]?.text, "已更新当前图片项目的配置绑定。");
      assert.deepEqual(recovered.structuredContent, { models: [] });
      assert.equal(taskCalls, 1);
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
    try {
      const first = await bind({ projectRoot: projectA });
      const projectBindingId = first.structuredContent.projectBindingId;

      const conflict = await bind({ projectRoot: projectB, projectBindingId });
      assertStableError(conflict, "project_binding_conflict", [projectA, projectB]);

      const resultA = await readArtifact({ projectBindingId, imageId: IMAGE_ID });
      const resultB = await readArtifact({ projectBindingId, imageId: IMAGE_ID });
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
    const movedProject = path.join(root, "workspace-a-original");
    try {
      const bound = await bind({ projectRoot: projectA });
      const projectBindingId = bound.structuredContent.projectBindingId;
      await rename(projectA, movedProject);
      await symlink(projectB, projectA, process.platform === "win32" ? "junction" : "dir");

      const artifactResult = await getArtifact({ projectBindingId, imageId: IMAGE_ID });
      const renderResult = await renderResults({ projectBindingId, imageIds: [IMAGE_ID] });
      const diagnosticResult = await inspectRuntime({ projectBindingId });

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
    try {
      const bound = await bind({ projectRoot: projectA });
      const projectBindingId = bound.structuredContent.projectBindingId;
      for (const candidate of [missingRoot, fileRoot, linkedRoot, pluginRoot, "relative-project"] ) {
        const result = await bind({ projectRoot: candidate, projectBindingId });
        assertStableError(result, "project_binding_conflict", [candidate]);
      }
    } finally {
      await server.close();
    }
  });
});


test("editor state is isolated between explicit project bindings across MCP processes", async () => {
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
    try {
      const boundA = await bindA({ projectRoot: projectA });
      const boundB = await bindB({ projectRoot: projectB });
      const projectBindingIdA = boundA.structuredContent.projectBindingId;
      const projectBindingIdB = boundB.structuredContent.projectBindingId;
      const openedA = await openEditorA({ projectBindingId: projectBindingIdA, imageId: IMAGE_ID });
      const openedB = await openEditorB({ projectBindingId: projectBindingIdB, imageId: IMAGE_ID });
      const sessionA = openedA.structuredContent.editorSession.id;
      const sessionB = openedB.structuredContent.editorSession.id;

      const foreignRead = await getEditorB({ projectBindingId: projectBindingIdB, editorSessionId: sessionA });
      assertStableError(foreignRead, "editor_session_not_found");
      const foreignDestroy = await serverB._registeredTools.destroy_image_editor.handler(
        { projectBindingId: projectBindingIdB, editorSessionId: sessionA },
      );
      assert.equal(foreignDestroy.structuredContent.editorSession.status, "released");
      const foreignFinalize = await finalizeEditorB({ projectBindingId: projectBindingIdB, editorSessionId: sessionA });
      assert.equal(foreignFinalize.structuredContent.editorSession.status, "released");

      const stillActiveA = await getEditorA({ projectBindingId: projectBindingIdA, editorSessionId: sessionA });
      assert.equal(stillActiveA.structuredContent.editorSession.status, "active");
      await destroyEditorA({ projectBindingId: projectBindingIdA, editorSessionId: sessionA });

      const projectAArtifact = await getArtifactA({ projectBindingId: projectBindingIdA, imageId: IMAGE_ID });
      const projectBArtifact = await getArtifactB({ projectBindingId: projectBindingIdB, imageId: IMAGE_ID });
      const stillActiveB = await getEditorB({ projectBindingId: projectBindingIdB, editorSessionId: sessionB });
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
    const unknownProjectBindingId = `pbind_${"e".repeat(64)}`;
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
        const result = await server._registeredTools[name].handler({
          projectBindingId: unknownProjectBindingId,
          ...arguments_,
        });
        assertStableError(result, "project_binding_required");
      }
      assert.equal(dependencyCalls, 0);
    } finally {
      await server.close();
    }
  });
});


test("explicit project bindings persist when the server restarts", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA }) => {
    const firstServer = createTestServer({ pluginRoot });
    const bound = await firstServer._registeredTools.bind_imagegen_project.handler({ projectRoot: projectA });
    const projectBindingId = bound.structuredContent.projectBindingId;
    await firstServer.close();

    const restartedServer = createTestServer({ pluginRoot });
    try {
      const result = await restartedServer._registeredTools.list_image_models.handler({ projectBindingId });
      assert.deepEqual(result.structuredContent, { models: [] });
      assertValuesHidden([result], [projectA]);
    } finally {
      await restartedServer.close();
    }
  });
});


test("project bindings reject a record with a mismatched binding hash", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA, userHome }) => {
    const server = createTestServer({ pluginRoot });
    try {
      const bound = await server._registeredTools.bind_imagegen_project.handler({ projectRoot: projectA });
      const projectBindingId = bound.structuredContent.projectBindingId;
      const bindingsRoot = path.join(
        userHome,
        ".codex",
        "openai-compatible-imagegen",
        "state",
        "project-bindings",
      );
      const [bindingDirectory] = await readdir(bindingsRoot);
      assert.match(bindingDirectory, /^[0-9a-f]{64}$/);
      assert.notEqual(bindingDirectory, projectBindingId);
      const recordPath = await latestCommittedRecordPath(
        path.join(bindingsRoot, bindingDirectory, "binding.json"),
      );
      const recordText = await readFile(recordPath, "utf8");
      assert.equal(recordText.includes(projectBindingId), false);
      const record = JSON.parse(recordText);
      record.bindingHash = record.bindingHash === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
      await writeFile(recordPath, `${JSON.stringify(record)}\n`);

      const result = await server._registeredTools.list_image_models.handler({ projectBindingId });
      assertStableError(result, "project_binding_state_invalid", [projectA]);
    } finally {
      await server.close();
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
        const result = await bind({ projectRoot });
        assertStableError(result, code, [projectRoot]);
      }
    } finally {
      await server.close();
    }
  });
});


test("runtime diagnostics report an unbound root and then an explicit project binding", async () => {
  await withProjectRoots(async ({ pluginRoot, projectA }) => {
    const server = createTestServer({ pluginRoot });
    try {
      const before = await server._registeredTools.inspect_imagegen_runtime.handler({});
      assert.equal(before.structuredContent.runtime.projectRootFingerprint, null);
      assert.equal(before.structuredContent.runtime.projectRootRelationToPlugin, null);
      assert.equal(before.structuredContent.runtime.projectRootSource, "unbound");

      const bound = await server._registeredTools.bind_imagegen_project.handler({ projectRoot: projectA });
      const after = await server._registeredTools.inspect_imagegen_runtime.handler({
        projectBindingId: bound.structuredContent.projectBindingId,
      });
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
      stateRoot: path.join(userHome, ".codex", "openai-compatible-imagegen", "state"),
      resolveConfigBinding: async ({ projectRoot }) => await resolveImageConfigBinding({ projectRoot, userHome }),
    }),
    runTask,
    readArtifact,
    readAnnotation,
    saveAnnotations,
  });
}


async function withProjectRoots(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-project-binding-"));
  const pluginRoot = path.join(root, "plugin-cache", "openai-compatible-imagegen");
  const projectA = path.join(root, "workspace-a");
  const projectB = path.join(root, "workspace-b");
  const userHome = path.join(root, "test-home");
  await Promise.all([
    mkdir(pluginRoot, { recursive: true }),
    mkdir(projectA),
    mkdir(projectB),
    mkdir(userHome),
  ]);
  await Promise.all([
    writeUserConfig(userHome),
    writeProjectConfig(projectA),
    writeProjectConfig(projectB),
  ]);
  try {
    await callback({ root, pluginRoot, projectA, projectB, userHome });
  } finally {
    await rm(root, { recursive: true });
  }
}


function projectConfigPath(projectRoot) {
  return path.join(projectRoot, ".codex", "openai-compatible-imagegen", "config.json");
}


function userConfigPath(userHome) {
  return path.join(userHome, ".codex", "openai-compatible-imagegen", "config.json");
}


async function writeProjectConfig(projectRoot, extra = {}) {
  const configPath = projectConfigPath(projectRoot);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    config_version: 1,
    ...extra,
  }));
}


async function writeUserConfig(userHome, providerOverrides = {}) {
  const configPath = userConfigPath(userHome);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    config_version: 1,
    active_profile: "primary/gpt-image-2",
    providers: {
      primary: {
        protocol: "openai-compatible",
        base_url: "https://example.test/v1",
        api_key_env: "IMAGE_API_KEY",
        ...providerOverrides,
      },
    },
    models: {
      "primary/gpt-image-2": {
        provider: "primary",
        model: "gpt-image-2",
        capabilities: { generate: true, edit: true, mask: true, multi_reference: true },
      },
    },
    defaults: { size: "1024x1024", quality: "medium", output_format: "png" },
    postprocess: { enabled: true },
    transparency: { default_route: "chroma-matting", prompt_only_allow: [], llm_assisted: { enabled: false } },
    storage: { output_directory: "output/imagegen" },
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
