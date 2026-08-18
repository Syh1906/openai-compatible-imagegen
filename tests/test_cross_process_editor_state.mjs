import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createImagegenServer } from "../mcp/create-server.mjs";
import { createFileEditorStateRegistry } from "../mcp/file-editor-state-registry.mjs";
import { createProjectContext } from "../mcp/project-context.mjs";
import { createReleaseBundle, RELEASE_IDENTITY_PLACEHOLDER } from "../mcp/release-identity.mjs";


const IMAGE_ID = "img_01J00000000000000000000000";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL1WQAAAABJRU5ErkJggg==";


test("one explicit project binding shares editor state across MCP server instances", async () => {
  const fixture = await createFixture();
  const serverA = fixture.createServer();
  const serverB = fixture.createServer();
  const serverC = fixture.createServer();
  try {
    const bound = await serverA._registeredTools.bind_imagegen_project.handler({ projectRoot: fixture.projectRoot });
    const isolatedBinding = await serverA._registeredTools.bind_imagegen_project.handler({ projectRoot: fixture.projectRoot });
    const projectBindingId = bound.structuredContent.projectBindingId;
    const otherProjectBindingId = isolatedBinding.structuredContent.projectBindingId;
    const opened = await serverA._registeredTools.open_image_editor.handler({ projectBindingId, imageId: IMAGE_ID });
    const duplicate = await serverA._registeredTools.open_image_editor.handler({ projectBindingId, imageId: IMAGE_ID });
    const editorSessionId = opened.structuredContent.editorSession.id;
    const duplicateSessionId = duplicate.structuredContent.editorSession.id;

    const active = await serverB._registeredTools.get_image_editor_session.handler({ projectBindingId, editorSessionId });
    assert.equal(active.structuredContent.editorSession.status, "active");
    const foreign = await serverB._registeredTools.get_image_editor_session.handler({ projectBindingId: otherProjectBindingId, editorSessionId });
    assertToolErrorCode(foreign, "editor_session_not_found");

    const destroyed = await serverB._registeredTools.destroy_image_editor.handler({ projectBindingId, editorSessionId });
    assert.equal(destroyed.structuredContent.editorSession.status, "destroyed");
    const destroyedFromC = await serverC._registeredTools.get_image_editor_session.handler({ projectBindingId, editorSessionId });
    const duplicateFromC = await serverC._registeredTools.get_image_editor_session.handler({ projectBindingId, editorSessionId: duplicateSessionId });
    assert.equal(destroyedFromC.structuredContent.editorSession.status, "destroyed");
    assert.equal(duplicateFromC.structuredContent.editorSession.status, "destroyed");

    for (const name of ["get_image_artifact", "read_image_artifact_data"]) {
      const result = await serverC._registeredTools[name].handler({ projectBindingId, imageId: IMAGE_ID });
      assert.equal(result.structuredContent.canvasStatus, "destroyed", name);
    }
    const rendered = await serverC._registeredTools.render_image_results.handler({ projectBindingId, imageIds: [IMAGE_ID] });
    assert.equal(rendered.structuredContent.artifacts[0].canvasStatus, "destroyed");

    const reopened = await serverC._registeredTools.open_image_editor.handler({ projectBindingId, imageId: IMAGE_ID });
    assertToolErrorCode(reopened, "image_canvas_destroyed");
    const isolated = await serverC._registeredTools.open_image_editor.handler({ projectBindingId: otherProjectBindingId, imageId: IMAGE_ID });
    assert.equal(isolated.structuredContent.editorSession.status, "active");

    const finalized = await serverC._registeredTools.finalize_image_editor_session.handler({ projectBindingId, editorSessionId });
    assert.equal(finalized.structuredContent.editorSession.status, "released");
    const released = await serverA._registeredTools.get_image_editor_session.handler({ projectBindingId, editorSessionId });
    assertToolErrorCode(released, "editor_session_not_found");
  } finally {
    await Promise.all([serverA.close(), serverB.close(), serverC.close()]);
    await rm(fixture.root, { recursive: true });
  }
});


async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-cross-process-editor-"));
  const pluginRoot = path.join(root, "plugin");
  const projectRoot = path.join(root, "project");
  const artifactRoot = path.join(projectRoot, "output", "imagegen");
  const stateRoot = path.join(root, "user-state");
  await mkdir(pluginRoot);
  await mkdir(artifactRoot, { recursive: true });
  const releaseIdentity = createReleaseBundle({
    pluginId: "openai-compatible-imagegen",
    pluginVersion: "0.1.0-editor-state-test",
    serverBuildInputs: [{ path: "mcp/server.mjs", content: "editor state" }],
    widgetHtml: `<html><head>${RELEASE_IDENTITY_PLACEHOLDER}</head></html>`,
  }).releaseIdentity;
  const createServer = () => createImagegenServer({
    releaseIdentity,
    launchContext: { cwd: pluginRoot, pluginRoot },
    projectContext: createProjectContext({
      pluginRoot,
      stateRoot,
      resolveConfigBinding: async () => configBinding({ projectRoot, artifactRoot, stateRoot }),
      verifyConfigBinding: async () => {},
    }),
    editorState: createFileEditorStateRegistry(),
    readWidgetHtml: async () => "<html></html>",
    runTask: async () => { throw new Error("not used"); },
    readArtifact: async (imageId) => ({ metadata: artifact(imageId), data: PNG_BASE64 }),
    readAnnotation: async () => { throw new Error("not used"); },
    saveAnnotations: async () => { throw new Error("not used"); },
    deleteAnnotation: async () => { throw new Error("not used"); },
  });
  return { root, projectRoot, createServer };
}


function configBinding({ projectRoot, artifactRoot, stateRoot }) {
  return Object.freeze({
    userConfigPath: path.join(stateRoot, "config.json"),
    userConfigSha256: "1".repeat(64),
    projectConfigPath: path.join(projectRoot, ".codex", "openai-compatible-imagegen", "config.json"),
    projectConfigSha256: null,
    effectiveConfigJson: "{}",
    effectiveConfigSha256: "2".repeat(64),
    activeProfile: "primary/gpt-image-2",
    runtimeDefaults: Object.freeze({ timeout_seconds: 600, concurrency: 3 }),
    artifactRoot,
  });
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
    prompt: "fixture",
    parameters: {},
    annotationId: null,
    createdAt: "2026-08-15T00:00:00.000Z",
  };
}


function assertToolErrorCode(result, code) {
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, new RegExp(`^${code}:`));
}
