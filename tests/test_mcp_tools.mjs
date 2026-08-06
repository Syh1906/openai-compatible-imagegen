import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createImagegenServer } from "../mcp/create-server.mjs";
import { readImageArtifact } from "../mcp/artifact-repository.mjs";
import { runImageTask } from "../mcp/image-runtime.mjs";
import { createReleaseBundle, RELEASE_IDENTITY_PLACEHOLDER } from "../mcp/release-identity.mjs";


const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL1WQAAAABJRU5ErkJggg==";
const TEST_RELEASE_IDENTITY = createReleaseBundle({
  pluginId: "openai-compatible-imagegen-v2",
  pluginVersion: "0.1.0-test",
  serverBuildInputs: [{ path: "test-server.mjs", content: "test server" }],
  widgetHtml: `<html><head>${RELEASE_IDENTITY_PLACEHOLDER}</head></html>`,
}).releaseIdentity;
const RESULT_WIDGET_URI = TEST_RELEASE_IDENTITY.resourceUris.result;
const EDITOR_WIDGET_URI = TEST_RELEASE_IDENTITY.resourceUris.editor;

function artifact(id, parentIds = []) {
  return {
    id,
    parentIds,
    childIds: [],
    mimeType: "image/png",
    width: 1,
    height: 1,
    provider: "primary",
    model: "gpt-image-2",
    operation: parentIds.length ? "edit" : "generate",
    prompt: "test prompt",
    parameters: {},
    annotationId: null,
    createdAt: "2026-08-06T00:00:00.000Z",
  };
}

function assertToolErrorCode(result, code, message = "") {
  assert.equal(result.isError, true, message);
  assert.equal(result.structuredContent, undefined, message);
  assert.match(result.content?.[0]?.text ?? "", new RegExp(`^${code}:`), message);
}

async function withClient(dependencies, callback) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-mcp-context-"));
  const pluginRoot = path.join(fixtureRoot, "plugin-cache");
  const projectRoot = path.join(fixtureRoot, "workspace");
  await Promise.all([mkdir(pluginRoot), mkdir(projectRoot)]);
  const server = createImagegenServer({
    releaseIdentity: TEST_RELEASE_IDENTITY,
    launchContext: {
      cwd: pluginRoot,
      pluginRoot,
    },
    readWidgetHtml: async () => "<html>editor</html>",
    ...dependencies,
  });
  const client = new Client({ name: "mcp-contract-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const requestMeta = {};
    const originalCallTool = client.callTool.bind(client);
    await client.listTools();
    const binding = await originalCallTool({
      name: "bind_imagegen_project",
      arguments: { projectRoot },
      _meta: requestMeta,
    });
    assert.deepEqual(binding.structuredContent, { status: "bound" });
    client.callTool = async (request, ...rest) => await originalCallTool(
      { ...request, _meta: request._meta ?? requestMeta },
      ...rest,
    );
    await callback(client);
  } finally {
    await client.close();
    await server.close();
    await rm(fixtureRoot, { recursive: true });
  }
}

test("widget resources read the current bundle for each request", async () => {
  let widgetHtml = "<html>first</html>";
  await withClient(
    {
      readWidgetHtml: async () => widgetHtml,
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async () => {
        throw new Error("not used");
      },
    },
    async (client) => {
      const first = await client.readResource({ uri: RESULT_WIDGET_URI });
      widgetHtml = "<html>second</html>";
      const second = await client.readResource({ uri: RESULT_WIDGET_URI });
      assert.equal(first.contents[0].text, "<html>first</html>");
      assert.equal(second.contents[0].text, "<html>second</html>");
      assert.deepEqual(first.contents[0]._meta.ui.csp.resourceDomains, ["data:", "blob:"]);
      assert.deepEqual(first.contents[0]._meta["openai/widgetCSP"].resource_domains, ["data:", "blob:"]);
    },
  );
});

test("app-only image data tool returns binary data by stable image ID", async () => {
  const current = artifact("img_01J00000000000000000000000");
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "read_image_artifact_data",
        arguments: { imageId: current.id },
      });

      assert.deepEqual(result.structuredContent, {
        id: current.id,
        mimeType: "image/png",
      });
      assert.deepEqual(result._meta.widgetData, {
        id: current.id,
        mimeType: "image/png",
        dataBase64: PNG_BASE64,
      });
      assert.equal(result.content.some((item) => item.type === "image"), false);
    },
  );
});

test("only the result renderer and focused editor bind app resources", async () => {
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async () => {
        throw new Error("not used");
      },
    },
    async (client) => {
      const { tools } = await client.listTools();
      const generateTool = tools.find((tool) => tool.name === "generate_image");
      const editTool = tools.find((tool) => tool.name === "edit_image");
      const artifactTool = tools.find((tool) => tool.name === "get_image_artifact");
      const renderTool = tools.find((tool) => tool.name === "render_image_results");
      const resultUri = renderTool._meta.ui.resourceUri;
      const editorUri = tools.find((tool) => tool.name === "open_image_editor")._meta.ui.resourceUri;
      const sessionStateTool = tools.find((tool) => tool.name === "get_image_editor_session");
      const finalizeSessionTool = tools.find((tool) => tool.name === "finalize_image_editor_session");
      const annotationTool = tools.find((tool) => tool.name === "save_image_annotations");
      const imageDataTool = tools.find((tool) => tool.name === "read_image_artifact_data");
      const modelTool = tools.find((tool) => tool.name === "list_image_models");

      assert.equal(generateTool._meta?.ui?.resourceUri, undefined);
      assert.equal(editTool._meta?.ui?.resourceUri, undefined);
      assert.equal(artifactTool._meta?.ui?.resourceUri, undefined);
      assert.equal(resultUri, RESULT_WIDGET_URI);
      assert.notEqual(resultUri, editorUri);
      assert.deepEqual(tools.find((tool) => tool.name === "open_image_editor")._meta.ui.visibility, ["app"]);
      assert.deepEqual(sessionStateTool._meta.ui.visibility, ["app"]);
      assert.deepEqual(finalizeSessionTool._meta.ui.visibility, ["app"]);
      assert.deepEqual(annotationTool._meta.ui.visibility, ["app"]);
      assert.deepEqual(imageDataTool._meta.ui.visibility, ["app"]);
      assert.equal(imageDataTool._meta["openai/widgetAccessible"], true);
      assert.deepEqual(imageDataTool.outputSchema.required.sort(), ["id", "mimeType"]);
      assert.equal(imageDataTool.outputSchema.properties.dataBase64, undefined);
      assert.notEqual(annotationTool, undefined);
      assert.notEqual(modelTool, undefined);

      const { resources } = await client.listResources();
      assert.deepEqual(
        resources.map((resource) => resource.uri).sort(),
        [resultUri, editorUri].sort(),
      );
    },
  );
});

test("all product tools declare precise structured output schemas", async () => {
  await withClient(
    {
      runTask: async () => ({ ok: true, models: [] }),
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
      saveAnnotations: async () => ({
        id: "ann_01J00000000000000000000000",
        imageId: "img_01J00000000000000000000000",
        itemCount: 1,
        previewMimeType: "image/svg+xml",
        hasMask: false,
        maskMimeType: null,
      }),
    },
    async (client) => {
      const { tools } = await client.listTools();
      const schemas = new Map(tools.map((tool) => [tool.name, tool.outputSchema]));
      const productTools = [
        "bind_imagegen_project",
        "list_image_models",
        "generate_image",
        "edit_image",
        "get_image_artifact",
        "read_image_artifact_data",
        "render_image_results",
        "open_image_editor",
        "save_image_annotations",
        "get_image_editor_session",
        "destroy_image_editor",
        "finalize_image_editor_session",
      ];

      for (const name of productTools) {
        assert.notEqual(schemas.get(name), undefined, `${name} outputSchema missing`);
        assert.equal(schemas.get(name).additionalProperties, false, `${name} outputSchema must be strict`);
      }

      assert.deepEqual(schemas.get("bind_imagegen_project").required, ["status"]);

      assert.deepEqual(schemas.get("list_image_models").required, ["models"]);
      assert.deepEqual(schemas.get("list_image_models").properties.models.items.required.sort(), ["capabilities", "id", "model", "provider"]);
      assert.equal(schemas.get("list_image_models").properties.models.items.additionalProperties, false);

      for (const name of ["generate_image", "edit_image"]) {
        assert.deepEqual(schemas.get(name).required, ["artifacts"]);
        assert.equal(schemas.get(name).properties.artifacts.items.additionalProperties, false);
        assert.deepEqual(schemas.get(name).properties.artifacts.items.required.sort(), [
          "annotationId",
          "childIds",
          "createdAt",
          "height",
          "id",
          "mimeType",
          "model",
          "operation",
          "parameters",
          "parentIds",
          "prompt",
          "provider",
          "width",
        ]);
      }

      assert.deepEqual(schemas.get("get_image_artifact").required.sort(), ["artifact", "canvasStatus"]);
      assert.deepEqual(schemas.get("render_image_results").required.sort(), ["artifacts", "imageIds"]);
      assert.deepEqual(schemas.get("render_image_results").properties.artifacts.items.required.sort(), [
        "annotationId",
        "canvasStatus",
        "childIds",
        "createdAt",
        "height",
        "id",
        "mimeType",
        "model",
        "operation",
        "parameters",
        "parentIds",
        "prompt",
        "provider",
        "width",
      ]);

      assert.deepEqual(schemas.get("open_image_editor").required.sort(), ["artifact", "editorSession"]);
      assert.deepEqual(schemas.get("open_image_editor").properties.editorSession.required.sort(), ["id", "imageId", "status"]);
      assert.equal(schemas.get("open_image_editor").properties.editorSession.additionalProperties, false);
      assert.deepEqual(schemas.get("save_image_annotations").required, ["annotation"]);
      assert.equal(schemas.get("save_image_annotations").properties.annotation.additionalProperties, false);
      assert.deepEqual(schemas.get("save_image_annotations").properties.annotation.required.sort(), [
        "hasMask",
        "id",
        "imageId",
        "itemCount",
        "maskMimeType",
        "previewMimeType",
      ]);

      for (const name of ["get_image_editor_session", "destroy_image_editor", "finalize_image_editor_session"]) {
        assert.deepEqual(schemas.get(name).required, ["editorSession"]);
        assert.deepEqual(schemas.get(name).properties.editorSession.required, ["id", "status"]);
      }
    },
  );
});

test("generate_image returns each candidate as image content and safe metadata", async () => {
  const artifacts = [artifact("img_01J00000000000000000000000"), artifact("img_01J00000000000000000000001")];
  const calls = [];
  await withClient(
    {
      runTask: async (task) => {
        calls.push(task);
        return { ok: true, artifacts };
      },
      readArtifact: async (id) => ({ metadata: artifacts.find((item) => item.id === id), data: PNG_BASE64 }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "generate_image",
        arguments: { prompt: "two candidates", count: 2 },
      });

      assert.equal(result.isError, undefined);
      assert.equal(result.content.filter((item) => item.type === "image").length, 2);
      assert.deepEqual(result.structuredContent.artifacts, artifacts);
      assert.equal(result._meta?.ui?.resourceUri, undefined);
      assert.deepEqual(result._meta.imageIds, artifacts.map((item) => item.id));
      assert.equal(JSON.stringify(result).includes("runtime-secret"), false);
    },
  );
  assert.equal(calls[0].operation, "generate");
  assert.equal(calls[0].modelProfileId, "primary/gpt-image-2");
  assert.equal(calls[0].output.count, 2);
});

test("edit_image binds the parent artifact and returns a child image", async () => {
  const parentId = "img_01J00000000000000000000000";
  const child = artifact("img_01J00000000000000000000001", [parentId]);
  let captured;
  await withClient(
    {
      runTask: async (task) => {
        captured = task;
        return { ok: true, artifacts: [child] };
      },
      readArtifact: async () => ({ metadata: child, data: PNG_BASE64 }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "edit_image",
        arguments: { parentImageId: parentId, prompt: "change the color" },
      });
      assert.equal(result.content.filter((item) => item.type === "image").length, 1);
      assert.deepEqual(result.structuredContent.artifact, child);
      assert.deepEqual(result.structuredContent.artifacts[0].parentIds, [parentId]);
      assert.equal(result._meta?.ui?.resourceUri, undefined);
      assert.equal(result._meta.imageId, child.id);
      assert.deepEqual(result._meta.imageIds, [child.id]);
    },
  );
  assert.equal(captured.operation, "edit");
  assert.deepEqual(captured.inputArtifactIds, [parentId]);
});

test("edit_image resolves a saved mask annotation into the runtime task", async () => {
  const parentId = "img_01J00000000000000000000000";
  const annotationId = "ann_01J00000000000000000000000";
  const child = artifact("img_01J00000000000000000000001", [parentId]);
  const maskPath = "F:/private/imagegen/annotations/mask.png";
  let captured;
  let requestedAnnotationId;
  await withClient(
    {
      runTask: async (task) => {
        captured = task;
        return { ok: true, artifacts: [child] };
      },
      readArtifact: async () => ({ metadata: child, data: PNG_BASE64 }),
      readAnnotation: async (id) => {
        requestedAnnotationId = id;
        return { id, imageId: parentId, maskPath };
      },
    },
    async (client) => {
      const result = await client.callTool({
        name: "edit_image",
        arguments: { parentImageId: parentId, annotationId, prompt: "replace the marked region" },
      });
      assert.equal(result.isError, undefined);
      assert.equal(JSON.stringify(result).includes(maskPath), false);
    },
  );
  assert.equal(requestedAnnotationId, annotationId);
  assert.equal(captured.annotationId, annotationId);
  assert.equal(captured.mask, maskPath);
});

test("edit_image rejects an annotation that belongs to another parent", async () => {
  const parentId = "img_01J00000000000000000000000";
  let runtimeCalls = 0;
  await withClient(
    {
      runTask: async () => {
        runtimeCalls += 1;
        return { ok: true, artifacts: [] };
      },
      readArtifact: async () => {
        throw new Error("not used");
      },
      readAnnotation: async (id) => ({ id, imageId: "img_01J00000000000000000000002", maskPath: null }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "edit_image",
        arguments: {
          parentImageId: parentId,
          annotationId: "ann_01J00000000000000000000000",
          prompt: "replace the marked region",
        },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /annotation_image_mismatch/);
    },
  );
  assert.equal(runtimeCalls, 0);
});

test("get_image_artifact returns image bytes without an absolute path", async () => {
  const current = artifact("img_01J00000000000000000000000");
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async () => ({ metadata: current, data: PNG_BASE64 }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "get_image_artifact",
        arguments: { imageId: current.id },
      });
      assert.equal(result.content[0].type, "image");
      assert.deepEqual(result.structuredContent.artifact, current);
      assert.equal(result.structuredContent.canvasStatus, "available");
      assert.equal(result._meta?.ui?.resourceUri, undefined);
      assert.equal(JSON.stringify(result).includes(":\\"), false);
    },
  );
});

test("render_image_results returns ordered image content to its single result widget", async () => {
  const imageIds = [
    "img_01J00000000000000000000000",
    "img_01J00000000000000000000001",
  ];
  const artifacts = imageIds.map((imageId) => ({ ...artifact(imageId), canvasStatus: "available" }));
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async (imageId) => ({
        metadata: artifact(imageId),
        data: PNG_BASE64,
      }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "render_image_results",
        arguments: { imageIds },
      });

      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent.imageIds, imageIds);
      assert.deepEqual(result.structuredContent.artifacts, artifacts);
      assert.deepEqual(result._meta.imageIds, imageIds);
      assert.equal(result._meta.ui.resourceUri, RESULT_WIDGET_URI);
      assert.equal(result._meta.imageArtifacts, undefined);
      assert.deepEqual(
        result.content.filter((item) => item.type === "image").map((item) => item.data),
        [PNG_BASE64, PNG_BASE64],
      );
    },
  );
});

test("editor sessions can be opened, inspected, and destroyed", async () => {
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "open_image_editor",
        arguments: { imageId: "img_01J00000000000000000000000" },
      });
      assert.equal(result._meta.ui.resourceUri, EDITOR_WIDGET_URI);
      assert.equal(result.structuredContent.editorSession.imageId, "img_01J00000000000000000000000");
      assert.equal(result.structuredContent.editorSession.status, "active");
      assert.equal(result.structuredContent.artifact.id, "img_01J00000000000000000000000");
      assert.match(result.structuredContent.editorSession.id, /^eds_/);

      const editorSessionId = result.structuredContent.editorSession.id;
      const active = await client.callTool({
        name: "get_image_editor_session",
        arguments: { editorSessionId },
      });
      assert.equal(active.structuredContent.editorSession.status, "active");

      const duplicate = await client.callTool({
        name: "open_image_editor",
        arguments: { imageId: "img_01J00000000000000000000000" },
      });
      const duplicateSessionId = duplicate.structuredContent.editorSession.id;
      assert.notEqual(duplicateSessionId, editorSessionId);

      const destroyed = await client.callTool({
        name: "destroy_image_editor",
        arguments: { editorSessionId },
      });
      assert.equal(destroyed.structuredContent.editorSession.status, "destroyed");

      const duplicateAfterDestroy = await client.callTool({
        name: "get_image_editor_session",
        arguments: { editorSessionId: duplicateSessionId },
      });
      assert.equal(duplicateAfterDestroy.structuredContent.editorSession.status, "destroyed");

      const afterDestroy = await client.callTool({
        name: "get_image_editor_session",
        arguments: { editorSessionId },
      });
      assert.equal(afterDestroy.structuredContent.editorSession.status, "destroyed");

      const artifactAfterDestroy = await client.callTool({
        name: "get_image_artifact",
        arguments: { imageId: "img_01J00000000000000000000000" },
      });
      assert.equal(artifactAfterDestroy.structuredContent.canvasStatus, "destroyed");

      const reopened = await client.callTool({
        name: "open_image_editor",
        arguments: { imageId: "img_01J00000000000000000000000" },
      });
      assert.equal(reopened.isError, true);
      assertToolErrorCode(reopened, "image_canvas_destroyed");
    },
  );
});

test("destroy_image_editor remains idempotent after the session was released", async () => {
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
    },
    async (client) => {
      const opened = await client.callTool({
        name: "open_image_editor",
        arguments: { imageId: "img_01J00000000000000000000000" },
      });
      const editorSessionId = opened.structuredContent.editorSession.id;
      await client.callTool({
        name: "destroy_image_editor",
        arguments: { editorSessionId },
      });
      await client.callTool({
        name: "finalize_image_editor_session",
        arguments: { editorSessionId },
      });

      const repeated = await client.callTool({
        name: "destroy_image_editor",
        arguments: { editorSessionId },
      });

      assert.notEqual(repeated.isError, true);
      assert.equal(repeated.structuredContent.editorSession.id, editorSessionId);
      assert.equal(repeated.structuredContent.editorSession.status, "released");
    },
  );
});

test("missing editor sessions return a stable error outside success structured content", async () => {
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "get_image_editor_session",
        arguments: { editorSessionId: "eds_00000000000000000000000000000000" },
      });

      assert.equal(result.isError, true);
      assertToolErrorCode(result, "editor_session_not_found");
      assert.match(result.content[0].text, /画布会话不存在/);
    },
  );
});

test("open_image_editor rejects an artifact that does not exist", async () => {
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async () => {
        throw new Error("artifact not found");
      },
    },
    async (client) => {
      const result = await client.callTool({
        name: "open_image_editor",
        arguments: { imageId: "img_01J00000000000000000000000" },
      });
      assert.equal(result.isError, true);
      assertToolErrorCode(result, "artifact_not_found");
      assert.match(result.content[0].text, /未找到指定图片产物/);
    },
  );
});

test("filesystem errors return a safe summary without absolute paths", async () => {
  const leakedPath = "F:/private/imagegen/output/image.png";
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async () => {
        throw new Error(`EACCES: ${leakedPath}`);
      },
    },
    async (client) => {
      const result = await client.callTool({
        name: "open_image_editor",
        arguments: { imageId: "img_01J00000000000000000000000" },
      });
      assert.equal(result.isError, true);
      assertToolErrorCode(result, "artifact_not_found");
      assert.equal(result.content[0].text.includes(leakedPath), false);
    },
  );
});

test("product tool errors never expose provider text or local paths", async () => {
  const imageId = "img_01J00000000000000000000000";
  const annotationId = "ann_01J00000000000000000000000";
  const secret = "provider-secret-token";
  const windowsPath = "F:/private/imagegen/output/image.png";
  const posixPath = "/home/alice/private/image.png";
  const unsafeError = () => new Error(`EPERM: ${windowsPath}; ${posixPath}; ${secret}`);
  const cases = [
    {
      name: "list_image_models",
      arguments: {},
      expectedCode: "image_task_failed",
      dependencies: { runTask: async () => { throw unsafeError(); } },
    },
    {
      name: "generate_image",
      arguments: { prompt: "test" },
      expectedCode: "image_task_failed",
      dependencies: { runTask: async () => { throw unsafeError(); } },
    },
    {
      name: "edit_image",
      arguments: { parentImageId: imageId, annotationId, prompt: "test" },
      expectedCode: "annotation_not_found",
      dependencies: {
        runTask: async () => { throw new Error("not used"); },
        readAnnotation: async () => { throw unsafeError(); },
      },
    },
    {
      name: "get_image_artifact",
      arguments: { imageId },
      expectedCode: "image_task_failed",
      dependencies: {},
    },
    {
      name: "read_image_artifact_data",
      arguments: { imageId },
      expectedCode: "artifact_read_failed",
      dependencies: {},
    },
    {
      name: "render_image_results",
      arguments: { imageIds: [imageId] },
      expectedCode: "artifact_read_failed",
      dependencies: {},
    },
    {
      name: "open_image_editor",
      arguments: { imageId },
      expectedCode: "artifact_not_found",
      dependencies: {},
    },
    {
      name: "save_image_annotations",
      arguments: {
        imageId,
        items: [{ id: "note-1", type: "text", x: 0.5, y: 0.5, text: "test" }],
      },
      expectedCode: "annotation_save_failed",
      dependencies: {
        readArtifact: async () => ({ metadata: artifact(imageId), data: PNG_BASE64 }),
        saveAnnotations: async () => { throw unsafeError(); },
      },
    },
  ];

  for (const testCase of cases) {
    await withClient(
      {
        runTask: async () => { throw new Error("not used"); },
        readArtifact: async () => { throw unsafeError(); },
        ...testCase.dependencies,
      },
      async (client) => {
        const result = await client.callTool({ name: testCase.name, arguments: testCase.arguments });
        assert.equal(result.isError, true, testCase.name);
        assertToolErrorCode(result, testCase.expectedCode, testCase.name);
        const serialized = JSON.stringify(result);
        for (const privateValue of [secret, windowsPath, posixPath]) {
          assert.equal(serialized.includes(privateValue), false, `${testCase.name} exposed ${privateValue}`);
        }
      },
    );
  }
});

test("tool errors preserve supported runtime codes with fixed safe summaries", async () => {
  const privateMessage = "provider rejected sk-private at F:/private/config.json";
  await withClient(
    {
      runTask: async () => ({
        ok: false,
        error: { code: "unsupported_capability", message: privateMessage },
      }),
      readArtifact: async () => { throw new Error("not used"); },
    },
    async (client) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "test" } });
      assert.equal(result.isError, true);
      assertToolErrorCode(result, "unsupported_capability");
      assert.equal(JSON.stringify(result).includes(privateMessage), false);
      assert.equal(JSON.stringify(result).includes("sk-private"), false);
    },
  );

  const configError = new Error("unsafe local configuration detail");
  configError.code = "v2_config_missing";
  await withClient(
    {
      runTask: async () => { throw configError; },
      readArtifact: async () => { throw new Error("not used"); },
    },
    async (client) => {
      const result = await client.callTool({ name: "list_image_models", arguments: {} });
      assertToolErrorCode(result, "v2_config_missing");
      assert.equal(JSON.stringify(result).includes(configError.message), false);
    },
  );
});

test("finalize_image_editor_session is idempotent", async () => {
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
    },
    async (client) => {
      const opened = await client.callTool({
        name: "open_image_editor",
        arguments: { imageId: "img_01J00000000000000000000000" },
      });
      const editorSessionId = opened.structuredContent.editorSession.id;
      const first = await client.callTool({ name: "finalize_image_editor_session", arguments: { editorSessionId } });
      const second = await client.callTool({ name: "finalize_image_editor_session", arguments: { editorSessionId } });

      assert.equal(first.structuredContent.editorSession.status, "released");
      assert.equal(second.structuredContent.editorSession.status, "released");
      assert.equal(second.structuredContent.editorSession.id, editorSessionId);
    },
  );
});

test("list_image_models returns only safe configured model capabilities", async () => {
  const models = [{
    id: "primary/gpt-image-2",
    provider: "primary",
    model: "gpt-image-2",
    capabilities: { generate: true, edit: true, mask: true },
  }];
  await withClient(
    {
      runTask: async (task) => task.operation === "list_models" ? { ok: true, models } : { ok: false },
      readArtifact: async () => {
        throw new Error("not used");
      },
    },
    async (client) => {
      const result = await client.callTool({ name: "list_image_models", arguments: {} });
      assert.deepEqual(result.structuredContent.models, models);
      assert.equal(JSON.stringify(result).includes("api_key"), false);
      assert.equal(JSON.stringify(result).includes("base_url"), false);
    },
  );
});

test("save_image_annotations stores multiple independent annotations together", async () => {
  const imageId = "img_01J00000000000000000000000";
  const items = [
    { id: "mark-1", type: "arrow", from: { x: 0.8, y: 0.2 }, to: { x: 0.5, y: 0.4 }, text: "Move this lower", color: "#2563eb", strokeWidth: 3 },
    { id: "mark-2", type: "text", x: 0.1, y: 0.2, text: "Use a warmer color", color: "#111827", strokeWidth: 5 },
  ];
  let captured;
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
      saveAnnotations: async (request) => {
        captured = request;
        return {
          id: "ann_01J00000000000000000000000",
          imageId,
          itemCount: items.length,
          previewMimeType: "image/svg+xml",
          hasMask: false,
          maskMimeType: null,
        };
      },
    },
    async (client) => {
      const result = await client.callTool({
        name: "save_image_annotations",
        arguments: { imageId, items },
      });
      assert.deepEqual(captured, { imageId, items });
      assert.equal(result.structuredContent.annotation.id, "ann_01J00000000000000000000000");
      assert.equal(result.structuredContent.annotation.itemCount, 2);
    },
  );
});

test("runtime failure is returned as an MCP error without switching route", async () => {
  let calls = 0;
  await withClient(
    {
      runTask: async () => {
        calls += 1;
        return { ok: false, error: { code: "image_task_failed", message: "provider rejected request" } };
      },
      readArtifact: async () => {
        throw new Error("not used");
      },
    },
    async (client) => {
      const result = await client.callTool({
        name: "generate_image",
        arguments: { prompt: "one attempt" },
      });
      assert.equal(result.isError, true);
      assertToolErrorCode(result, "image_task_failed");
      assert.match(result.content[0].text, /图片任务执行失败/);
      assert.equal(result.content[0].text.includes("provider rejected request"), false);
    },
  );
  assert.equal(calls, 1);
});

test("missing artifact errors do not expose the project path", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-mcp-"));
  try {
    await assert.rejects(
      readImageArtifact("img_01J00000000000000000000000", { projectRoot }),
      (error) => {
        assert.equal(error.message.includes(projectRoot), false);
        return true;
      },
    );
  } finally {
    await rm(projectRoot, { recursive: true });
  }
});

test("Node bridge runs the Python generate and edit path end to end", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-runtime-"));
  const requests = [];
  const api = createServer((request, response) => {
    let body = Buffer.alloc(0);
    request.on("data", (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    request.on("end", () => {
      requests.push({ url: request.url, headers: request.headers, body });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
    });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  try {
    const address = api.address();
    const configPath = path.join(projectRoot, "auth.json");
    await writeFile(
      configPath,
      JSON.stringify({
        providers: {
          primary: {
            protocol: "openai-compatible",
            base_url: `http://127.0.0.1:${address.port}/v1`,
            api_key: "integration-secret",
            user_agent: "Imagegen-Integration/1.0",
          },
        },
        models: {
          "primary/gpt-image-2": {
            model: "gpt-image-2",
            capabilities: { generate: true, edit: true, transparent_background: true },
          },
        },
        defaults: { output_format: "png" },
      }),
    );
    const output = { size: "1024x1024", quality: "high", format: "png", count: 1, background: "opaque" };
    const generated = await runImageTask(
      {
        operation: "generate",
        modelProfileId: "primary/gpt-image-2",
        prompt: "integration candidate",
        inputArtifactIds: [],
        annotationId: null,
        output,
      },
      { projectRoot, configPath },
    );
    assert.equal(generated.ok, true);
    const parentId = generated.artifacts[0].id;

    const edited = await runImageTask(
      {
        operation: "edit",
        modelProfileId: "primary/gpt-image-2",
        prompt: "保持极简白色构图并调整中央区域",
        inputArtifactIds: [parentId],
        annotationId: null,
        output,
      },
      { projectRoot, configPath },
    );
    assert.equal(edited.ok, true);
    assert.deepEqual(edited.artifacts[0].parentIds, [parentId]);
    assert.deepEqual(
      requests.map((request) => request.url),
      ["/v1/images/generations", "/v1/images/edits"],
    );
    assert.equal(requests.every((request) => request.headers["user-agent"] === "Imagegen-Integration/1.0"), true);
    assert.equal(requests.every((request) => request.headers.authorization === "Bearer integration-secret"), true);
    assert.equal(requests[1].body.includes(Buffer.from("保持极简白色构图并调整中央区域", "utf8")), true);
  } finally {
    await new Promise((resolve) => api.close(resolve));
    await rm(projectRoot, { recursive: true });
  }
});
