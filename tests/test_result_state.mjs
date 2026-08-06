import assert from "node:assert/strict";
import test from "node:test";

import { artifactLineage, extractResultArtifacts, hydrateResultArtifacts } from "../web/result-state.mjs";


const firstId = "img_01J00000000000000000000000";
const secondId = "img_01J00000000000000000000001";

test("tool results expose artifact metadata without payload bytes", () => {
  const artifacts = extractResultArtifacts({
    content: [
      { type: "image", mimeType: "image/png", data: "first-image" },
      { type: "image", mimeType: "image/png", data: "second-image" },
      { type: "text", text: "已创建 2 张图片。" },
    ],
    structuredContent: {
      artifacts: [
        { id: firstId, mimeType: "image/png", width: 1024, height: 1024, parentIds: [], childIds: [] },
        { id: secondId, mimeType: "image/png", width: 1024, height: 1024, parentIds: [], childIds: [] },
      ],
    },
    _meta: { imageIds: [firstId, secondId] },
  });

  assert.deepEqual(artifacts.map((item) => ({ id: item.id, hasData: "data" in item })), [
    { id: firstId, hasData: false },
    { id: secondId, hasData: false },
  ]);
});

test("artifact hydration reads each binary through the app-only MCP tool", async () => {
  const toolCalls = [];
  const artifacts = [firstId, secondId].map((id) => ({
    id,
    mimeType: "image/png",
  }));
  const hydrated = await hydrateResultArtifacts({
    getHostCapabilities: () => ({ serverTools: {} }),
    callServerTool: async (request) => {
      toolCalls.push(request);
      return {
        structuredContent: {
          id: request.arguments.imageId,
          mimeType: "image/png",
        },
        _meta: {
          widgetData: {
            id: request.arguments.imageId,
            mimeType: "image/png",
            dataBase64: `${request.arguments.imageId}-bytes`,
          },
        },
      };
    },
  }, artifacts);

  assert.deepEqual(toolCalls, artifacts.map((item) => ({
    name: "read_image_artifact_data",
    arguments: { imageId: item.id },
  })));
  assert.deepEqual(hydrated.map((item) => item.data), artifacts.map((item) => `${item.id}-bytes`));
});

test("artifact hydration calls the MCP tool when the host omits optional capability metadata", async () => {
  const toolCalls = [];
  const artifacts = [{ id: firstId, mimeType: "image/png" }];

  const hydrated = await hydrateResultArtifacts({
    getHostCapabilities: () => ({}),
    callServerTool: async (request) => {
      toolCalls.push(request);
      return {
        structuredContent: {
          id: request.arguments.imageId,
          mimeType: "image/png",
        },
        _meta: {
          widgetData: {
            id: request.arguments.imageId,
            mimeType: "image/png",
            dataBase64: "image-bytes",
          },
        },
      };
    },
  }, artifacts);

  assert.deepEqual(toolCalls, [{
    name: "read_image_artifact_data",
    arguments: { imageId: firstId },
  }]);
  assert.equal(hydrated[0].data, "image-bytes");
});

test("artifact hydration identifies a rejected tools/call request", async () => {
  await assert.rejects(
    hydrateResultArtifacts({
      callServerTool: async () => {
        throw new Error("request rejected");
      },
    }, [{ id: firstId }]),
    (error) => error?.code === "artifact_tool_call_failed",
  );
});

test("artifact hydration identifies an invalid private image payload", async () => {
  await assert.rejects(
    hydrateResultArtifacts({
      callServerTool: async () => ({
        structuredContent: { id: firstId, mimeType: "image/png" },
        _meta: { widgetData: { id: firstId, mimeType: "image/png" } },
      }),
    }, [{ id: firstId }]),
    (error) => error?.code === "artifact_payload_invalid",
  );
});

test("artifact lineage uses the real repository parentIds and childIds contract", () => {
  assert.deepEqual(
    artifactLineage({ id: firstId, parentIds: [secondId], childIds: [secondId] }),
    {
      parent: { id: secondId },
      children: [{ id: secondId }],
    },
  );
});
