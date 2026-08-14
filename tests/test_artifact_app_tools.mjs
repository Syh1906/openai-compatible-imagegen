import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createImagegenServer } from "../mcp/create-server.mjs";
import { createReleaseBundle, RELEASE_IDENTITY_PLACEHOLDER } from "../mcp/release-identity.mjs";


const IMAGE_ID = "img_01J00000000000000000000000";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL1WQAAAABJRU5ErkJggg==";
const TEST_RELEASE_IDENTITY = createReleaseBundle({
  pluginId: "openai-compatible-imagegen-v2",
  pluginVersion: "0.1.0-test",
  serverBuildInputs: [{ path: "test-server.mjs", content: "test server" }],
  widgetHtml: `<html><head>${RELEASE_IDENTITY_PLACEHOLDER}</head></html>`,
}).releaseIdentity;

test("app-only image data tool returns binary data by stable image ID", async () => {
  await withClient({}, async (client) => {
    const result = await client.callTool({
      name: "read_image_artifact_data",
      arguments: { imageId: IMAGE_ID },
    });

    assert.deepEqual(result.structuredContent, { id: IMAGE_ID, mimeType: "image/png" });
    assert.deepEqual(result._meta.widgetData, {
      id: IMAGE_ID,
      mimeType: "image/png",
      dataBase64: PNG_BASE64,
    });
    assert.equal(result.content.some((item) => item.type === "image"), false);
  });
});

test("app-only reveal tool confirms an artifact by stable image ID without returning a local path", async () => {
  let revealRequest = null;
  await withClient(
    {
      revealArtifact: async (imageId, context) => {
        revealRequest = { imageId, context };
        return { status: "revealed", imageId };
      },
    },
    async (client) => {
      const result = await client.callTool({
        name: "reveal_image_artifact",
        arguments: { imageId: IMAGE_ID },
      });

      assert.deepEqual(result.structuredContent, { status: "revealed", imageId: IMAGE_ID });
      assert.equal(result.content?.[0]?.text, `已在文件夹中显示图片 ${IMAGE_ID}。`);
      assert.equal(JSON.stringify(result).includes("workspace"), false);
      assert.equal(revealRequest.imageId, IMAGE_ID);
      assert.equal(typeof revealRequest.context.artifactRoot, "string");

      const { tools } = await client.listTools();
      const tool = tools.find((item) => item.name === "reveal_image_artifact");
      assert.deepEqual(tool._meta.ui.visibility, ["app"]);
      assert.equal(tool._meta.ui.resourceUri, undefined);
      assert.equal(tool._meta["openai/widgetAccessible"], true);
      assert.deepEqual(tool.inputSchema.required, ["imageId"]);
      assert.deepEqual(tool.outputSchema.required.sort(), ["imageId", "status"]);
      assert.deepEqual(tool.annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
    },
  );
});

test("reveal tool returns a stable error without leaking launcher details", async () => {
  await withClient(
    {
      revealArtifact: async () => {
        throw new Error("explorer failed at C:/Users/private/image.png");
      },
    },
    async (client) => {
      const result = await client.callTool({
        name: "reveal_image_artifact",
        arguments: { imageId: IMAGE_ID },
      });
      assert.equal(result.isError, true);
      assert.match(result.content?.[0]?.text ?? "", /^artifact_reveal_failed:/);
      assert.equal(JSON.stringify(result).includes("C:/Users/private"), false);
    },
  );
});

test("tool catalog exposes exactly ten model tools and eight app-only tools", async () => {
  await withClient({}, async (client) => {
    const { tools } = await client.listTools();
    const appOnlyTools = tools
      .filter((tool) => tool._meta?.ui?.visibility?.includes("app"))
      .map((tool) => tool.name)
      .sort();
    const modelTools = tools
      .filter((tool) => !tool._meta?.ui?.visibility?.includes("app"))
      .map((tool) => tool.name)
      .sort();

    assert.deepEqual(modelTools, [
      "batch_images",
      "bind_imagegen_project",
      "deliver_image",
      "destroy_image_editor",
      "edit_image",
      "generate_image",
      "get_image_artifact",
      "inspect_imagegen_runtime",
      "list_image_models",
      "render_image_results",
    ]);
    assert.deepEqual(appOnlyTools, [
      "finalize_image_editor_session",
      "get_image_editor_session",
      "open_image_editor",
      "prepare_image_edit_submission",
      "read_image_artifact_data",
      "report_imagegen_host_observation",
      "reveal_image_artifact",
      "save_image_annotations",
    ]);
    assert.equal(tools.length, 18);
  });
});

async function withClient(dependencies, callback) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-app-tools-"));
  const pluginRoot = path.join(fixtureRoot, "plugin-cache");
  const projectRoot = path.join(fixtureRoot, "workspace");
  await Promise.all([mkdir(pluginRoot), mkdir(projectRoot)]);
  const server = createImagegenServer({
    releaseIdentity: TEST_RELEASE_IDENTITY,
    launchContext: { cwd: pluginRoot, pluginRoot },
    readWidgetHtml: async () => "<html>editor</html>",
    runTask: async () => { throw new Error("not used"); },
    readArtifact: async (imageId) => ({ metadata: artifact(imageId), data: PNG_BASE64 }),
    revealArtifact: async (imageId) => ({ status: "revealed", imageId }),
    deleteAnnotation: async () => {},
    ...dependencies,
  });
  const client = new Client({ name: "artifact-app-tool-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const originalCallTool = client.callTool.bind(client);
    const requestMeta = {};
    await client.listTools();
    await originalCallTool({
      name: "bind_imagegen_project",
      arguments: { projectRoot },
      _meta: requestMeta,
    });
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
