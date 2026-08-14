import assert from "node:assert/strict";
import test from "node:test";

import { extractImageResultEnvelopeIds } from "../mcp/result-envelope.mjs";
import { artifactLineage, extractResultArtifacts, extractResultImageIds, hydrateResultArtifacts, mergeLineageRecords } from "../web/result-state.mjs";


const firstId = "img_01J00000000000000000000000";
const secondId = "img_01J00000000000000000000001";

test("result envelopes provide ordered image IDs through the standard text content channel", () => {
  const result = {
    content: [{ type: "text", text: `IMAGEGEN_RESULT_V1:${JSON.stringify({ imageIds: [firstId, secondId] })}` }],
  };
  assert.deepEqual(extractImageResultEnvelopeIds(result), [firstId, secondId]);
  assert.deepEqual(extractResultImageIds(result), [firstId, secondId]);
});

test("result envelope parsing rejects missing, unknown, malformed, and duplicate IDs", () => {
  const cases = [
    {},
    { content: [{ type: "text", text: "IMAGEGEN_RESULT_V2:{\"imageIds\":[]}" }] },
    { content: [{ type: "text", text: "IMAGEGEN_RESULT_V1:not-json" }] },
    { content: [{ type: "text", text: `IMAGEGEN_RESULT_V1:${JSON.stringify({ imageIds: ["not-an-image-id"] })}` }] },
    { content: [{ type: "text", text: `IMAGEGEN_RESULT_V1:${JSON.stringify({ imageIds: [firstId, firstId] })}` }] },
  ];
  for (const result of cases) {
    assert.deepEqual(extractImageResultEnvelopeIds(result), []);
    assert.deepEqual(extractResultImageIds(result), []);
  }
});

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

test("lineage merging preserves established version order while the current version changes", () => {
  const root = { id: "root-image", role: "parent", data: "root-data" };
  const green = { id: "green-image", role: "current", data: "green-data" };
  const childA = { id: "child-a", role: "child", data: "child-a-data" };
  const childB = { id: "child-b", role: "child", data: "child-b-data" };
  const expectedOrder = [root.id, green.id, childA.id, childB.id];
  let lineage = mergeLineageRecords([], [root, green, childA, childB], green.id);

  for (const [currentId, localLineage] of [
    [childA.id, [green, childA]],
    [childB.id, [green, childB]],
    [green.id, [root, green]],
    [childA.id, [green, childA]],
    [root.id, [root]],
  ]) {
    lineage = mergeLineageRecords(lineage, localLineage, currentId);
    assert.deepEqual(lineage.map((item) => item.id), expectedOrder);
    assert.deepEqual(lineage.filter((item) => item.role === "current").map((item) => item.id), [currentId]);
  }
});

test("the first complete lineage replaces a current-image-only placeholder order", () => {
  const currentId = "green-image";
  const merged = mergeLineageRecords(
    [{ id: currentId, role: "current", loadState: "loading" }],
    [
      { id: "root-image", role: "parent", data: "root-data" },
      { id: currentId, role: "current", data: "green-data" },
      { id: "child-a", role: "child", data: "child-a-data" },
      { id: "child-b", role: "child", data: "child-b-data" },
    ],
    currentId,
  );

  assert.deepEqual(merged.map((item) => item.id), ["root-image", currentId, "child-a", "child-b"]);
});
