import assert from "node:assert/strict";
import test from "node:test";

import { createArtifactCandidateLoader } from "../web/artifact-candidate-loader.mjs";
import { createArtifactLoadRegistry } from "../web/artifact-load-registry.mjs";


test("artifact metadata must match the requested image ID", async () => {
  const requestedImageId = "img_01J00000000000000000000040";
  const otherImageId = "img_01J00000000000000000000041";
  const app = {
    async callServerTool({ name }) {
      assert.equal(name, "read_image_artifact_data");
      return {
        content: [],
        structuredContent: {
          artifact: { id: otherImageId, mimeType: "image/png", width: 1, height: 1 },
          canvasStatus: "available",
        },
        _meta: {
          widgetData: { id: requestedImageId, mimeType: "image/png", dataBase64: "bytes" },
        },
      };
    },
  };
  const records = createArtifactLoadRegistry({
    timeoutMs: 1_000,
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
  });
  const loader = createArtifactCandidateLoader({ app, records });

  const { load } = loader.start(requestedImageId);
  await assert.rejects(load, (error) => error?.code === "artifact_payload_invalid");
  assert.equal(records.get(requestedImageId), undefined);
  assert.equal(records.get(otherImageId), undefined);
});
