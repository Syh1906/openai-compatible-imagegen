import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createImagegenServer } from "../mcp/create-server.mjs";
import { createReleaseBundle, RELEASE_IDENTITY_PLACEHOLDER } from "../mcp/release-identity.mjs";


const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL1WQAAAABJRU5ErkJggg==";
const TEST_RELEASE_IDENTITY = createReleaseBundle({
  pluginId: "openai-compatible-imagegen-v2",
  pluginVersion: "0.1.0-test",
  serverBuildInputs: [{ path: "test-server.mjs", content: "test server" }],
  widgetHtml: `<html><head>${RELEASE_IDENTITY_PLACEHOLDER}</head></html>`,
}).releaseIdentity;


test("batch and delivery tools expose precise structured output schemas", async () => {
  await withClient(
    {
      runTask: async () => { throw new Error("not used"); },
      readArtifact: async () => { throw new Error("not used"); },
    },
    async (client) => {
      const { tools } = await client.listTools();
      const schemas = new Map(tools.map((tool) => [tool.name, tool.outputSchema]));

      assert.deepEqual(schemas.get("deliver_image").required.sort(), [
        "artifacts",
        "deliveryReady",
        "sourceArtifactId",
      ]);
      assert.equal(schemas.get("deliver_image").additionalProperties, false);
      assert.notEqual(schemas.get("deliver_image").properties.qa, undefined);
      assert.deepEqual(schemas.get("batch_images").required.sort(), [
        "artifactIds",
        "results",
        "summary",
      ]);
      assert.equal(schemas.get("batch_images").properties.summary.additionalProperties, false);
    },
  );
});


test("deliver_image maps a stable source ID to a local delivery task without presenting images", async () => {
  const sourceId = "img_01J00000000000000000000000";
  const derived = {
    ...artifact("img_01J00000000000000000000001"),
    operation: "derive",
    derivedFrom: sourceId,
    deliveryKind: "exact-size",
  };
  let captured;
  await withClient(
    {
      runTask: async (task) => {
        captured = task;
        return {
          ok: true,
          sourceArtifactId: sourceId,
          deliveryReady: true,
          artifacts: [derived],
          qa: { schema_version: "qa.v1", status: "pass" },
          warnings: [],
        };
      },
      readArtifact: async (id) => ({ metadata: id === derived.id ? derived : artifact(id), data: PNG_BASE64 }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "deliver_image",
        arguments: {
          imageId: sourceId,
          delivery: {
            deliverySize: "4x4",
            fit: "contain",
            resample: "nearest",
            safeMargin: 0,
            qa: true,
          },
        },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent.sourceArtifactId, sourceId);
      assert.equal(result.structuredContent.deliveryReady, true);
      assert.deepEqual(result.structuredContent.artifacts, [derived]);
      assert.deepEqual(result.structuredContent.qa, { schema_version: "qa.v1", status: "pass" });
      assert.equal(result.content.filter((item) => item.type === "image").length, 0);
      assert.equal(JSON.stringify(result).includes("F:/"), false);
      assert.equal(JSON.stringify(result).includes("runtime-secret"), false);
    },
  );
  assert.equal(captured.operation, "deliver");
  assert.deepEqual(captured.inputArtifactIds, [sourceId]);
  assert.deepEqual(captured.delivery, {
    deliverySize: "4x4",
    fit: "contain",
    resample: "nearest",
    safeMargin: 0,
    qa: true,
  });
});


test("batch_images runs heterogeneous tasks with ordered partial results and no presentation", async () => {
  const generated = artifact("img_01J00000000000000000000001");
  const edited = artifact("img_01J00000000000000000000002", [generated.id]);
  const calls = [];
  const privateMessage = "provider secret at C:/Users/private/auth.json";
  await withClient(
    {
      runTask: async (task) => {
        calls.push(task);
        if (task.prompt === "failed task") {
          return { ok: false, error: { code: "unsupported_capability", message: privateMessage } };
        }
        return { ok: true, artifacts: [{ id: task.operation === "generate" ? generated.id : edited.id }] };
      },
      readArtifact: async (id) => ({
        metadata: id === generated.id ? generated : edited,
        data: PNG_BASE64,
      }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "batch_images",
        arguments: {
          concurrency: 2,
          items: [
            { requestId: "generate-a", operation: "generate", prompt: "generated task", quality: "high" },
            {
              requestId: "edit-b",
              operation: "edit",
              parentImageId: generated.id,
              prompt: "edited task",
              format: "png",
            },
            { requestId: "generate-c", operation: "generate", prompt: "failed task" },
          ],
        },
      });

      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent.results.map((item) => item.requestId), [
        "generate-a",
        "edit-b",
        "generate-c",
      ]);
      assert.deepEqual(result.structuredContent.summary, {
        total: 3,
        succeeded: 2,
        failed: 1,
        artifactCount: 2,
      });
      assert.deepEqual(result.structuredContent.artifactIds, [generated.id, edited.id]);
      assert.deepEqual(result.structuredContent.results[2].error, {
        code: "unsupported_capability",
        message: "当前图片模型不支持请求的能力。",
      });
      assert.equal(result.content.filter((item) => item.type === "image").length, 0);
      assert.equal(result._meta?.ui?.resourceUri, undefined);
      assert.deepEqual(result._meta.imageIds, [generated.id, edited.id]);
      assert.equal(JSON.stringify(result).includes(privateMessage), false);
      assert.equal(JSON.stringify(result).includes("C:/Users/private"), false);
    },
  );

  assert.deepEqual(calls[0], {
    operation: "generate",
    modelProfileId: "primary/gpt-image-2",
    prompt: "generated task",
    inputArtifactIds: [],
    annotationId: null,
    output: { quality: "high" },
  });
  assert.deepEqual(calls[1], {
    operation: "edit",
    modelProfileId: "primary/gpt-image-2",
    prompt: "edited task",
    inputArtifactIds: [generated.id],
    annotationId: null,
    output: { format: "png" },
  });
});


test("batch_images rejects an edit while the same image has a pending canvas submission", async () => {
  const parentId = "img_01J00000000000000000000000";
  let runtimeCalls = 0;
  await withClient(
    {
      runTask: async () => {
        runtimeCalls += 1;
        return { ok: true, artifacts: [artifact("img_01J00000000000000000000001", [parentId])] };
      },
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
    },
    async (client) => {
      const prepared = await client.callTool({
        name: "prepare_image_edit_submission",
        arguments: { parentImageId: parentId, items: [], sourcePrompt: "pending canvas edit" },
      });
      assert.equal(prepared.isError, undefined);

      const result = await client.callTool({
        name: "batch_images",
        arguments: {
          items: [{
            requestId: "edit-a",
            operation: "edit",
            parentImageId: parentId,
            prompt: "must not bypass the canvas submission",
          }],
        },
      });

      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent.results[0], {
        requestId: "edit-a",
        operation: "edit",
        ok: false,
        error: {
          code: "missing_edit_submission",
          message: "当前图片存在待发送画布提交，但缺少提交 ID。",
        },
      });
      assert.deepEqual(result.structuredContent.summary, {
        total: 1,
        succeeded: 0,
        failed: 1,
        artifactCount: 0,
      });
      assert.equal(runtimeCalls, 0);
    },
  );
});


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


async function withClient(dependencies, callback) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-mcp-delivery-batch-"));
  const pluginRoot = path.join(fixtureRoot, "plugin-cache");
  const projectRoot = path.join(fixtureRoot, "workspace");
  await Promise.all([mkdir(pluginRoot), mkdir(projectRoot)]);
  const server = createImagegenServer({
    releaseIdentity: TEST_RELEASE_IDENTITY,
    launchContext: { cwd: pluginRoot, pluginRoot },
    readWidgetHtml: async () => "<html>editor</html>",
    deleteAnnotation: async () => {},
    ...dependencies,
  });
  const client = new Client({ name: "mcp-delivery-batch-test", version: "0.1.0" });
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
