import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createImagegenServer } from "../mcp/create-server.mjs";
import { createReleaseBundle, RELEASE_IDENTITY_PLACEHOLDER } from "../mcp/release-identity.mjs";
import {
  createFixtureProjectContext,
  FIXTURE_PROJECT_BINDING_ID,
} from "./fixture-project-context.js";


const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL1WQAAAABJRU5ErkJggg==";
const TEST_RELEASE_IDENTITY = createReleaseBundle({
  pluginId: "openai-compatible-imagegen",
  pluginVersion: "0.1.0-test",
  serverBuildInputs: [{ path: "test-server.mjs", content: "test server" }],
  widgetHtml: `<html><head>${RELEASE_IDENTITY_PLACEHOLDER}</head></html>`,
}).releaseIdentity;
const TRANSPARENCY_REQUEST = {
  route: "emissive-alpha",
  options: { black_point: 8, gamma: 1.2 },
};


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
        "manifestReady",
        "results",
        "summary",
      ]);
      assert.equal(schemas.get("batch_images").properties.summary.additionalProperties, false);

      const batchTool = tools.find((tool) => tool.name === "batch_images");
      const batchItemVariants = batchTool.inputSchema.properties.items.items.anyOf
        ?? batchTool.inputSchema.properties.items.items.oneOf;
      const batchResultVariants = batchTool.outputSchema.properties.results.items.anyOf
        ?? batchTool.outputSchema.properties.results.items.oneOf;
      assert.equal(batchTool.inputSchema.properties.items.maxItems, 64);
      assert.equal(batchTool.inputSchema.properties.concurrency.maximum, 8);
      assert.equal(batchItemVariants[0].properties.count.maximum, 16);
      assert.equal(batchItemVariants[1].properties.count.$ref.endsWith("/properties/count"), true);
      assert.equal(batchTool.outputSchema.properties.results.maxItems, 64);
      assert.equal(batchTool.outputSchema.properties.artifactIds.maxItems, 64);
      assert.equal(batchResultVariants[0].properties.artifacts.maxItems, 16);
    },
  );
});


test("batch_images records a stable immutable manifest after item execution", async () => {
  const source = artifact("img_01J00000000000000000000041");
  const batchId = "batch_01J00000000000000000000042";
  let recordTask;
  await withClient(
    {
      runTask: async (task) => {
        if (task.operation === "record_batch") {
          recordTask = task;
          return {
            ok: true,
            manifest: {
              ...task.manifest,
              batchId,
              createdAt: "2026-08-14T08:00:00.000Z",
            },
          };
        }
        return {
          ok: true,
          artifacts: [{ id: source.id }],
          apiDelivery: {
            status: "published",
            requestedCount: 1,
            returnedCount: 1,
            publishedCount: 1,
            items: [{
              responseIndex: 1,
              artifactId: source.id,
              actualFormat: "png",
              width: 1,
              height: 1,
            }],
            issues: [],
          },
        };
      },
      readArtifact: async () => ({ metadata: source, data: PNG_BASE64 }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "batch_images",
        arguments: {
          items: [{
            requestId: "manifest-a",
            operation: "generate",
            prompt: "do not persist this prompt in the manifest",
          }],
        },
      });

      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.manifestReady, true);
      assert.equal(result.structuredContent.batchId, batchId);
      assert.equal(result.structuredContent.manifestCreatedAt, "2026-08-14T08:00:00.000Z");
    },
  );

  assert.deepEqual(recordTask, {
    operation: "record_batch",
    modelProfileId: "primary/gpt-image-2",
    manifest: {
      schemaVersion: "batch-manifest.v1",
      summary: { total: 1, succeeded: 1, failed: 0, artifactCount: 1 },
      results: [{
        requestId: "manifest-a",
        operation: "generate",
        ok: true,
        artifactIds: [source.id],
        apiDelivery: {
          status: "published",
          requestedCount: 1,
          returnedCount: 1,
          publishedCount: 1,
          items: [{
            responseIndex: 1,
            artifactId: source.id,
            actualFormat: "png",
            width: 1,
            height: 1,
          }],
          issues: [],
        },
        deliveryReceiptIds: [],
        deliveryArtifactIds: [],
      }],
    },
  });
  assert.equal(JSON.stringify(recordTask).includes("do not persist this prompt"), false);
});


test("batch manifest keeps published originals when metadata presentation fails", async () => {
  const source = artifact("img_01J00000000000000000000043");
  const batchId = "batch_01J00000000000000000000044";
  let recordedManifest;
  await withClient(
    {
      runTask: async (task) => {
        if (task.operation === "record_batch") {
          recordedManifest = task.manifest;
          return {
            ok: true,
            manifest: {
              ...task.manifest,
              batchId,
              createdAt: "2026-08-14T08:10:00.000Z",
            },
          };
        }
        return {
          ok: true,
          artifacts: [{ id: source.id }],
          apiDelivery: apiDeliveryFor([source.id]),
        };
      },
      readArtifact: async () => { throw new Error("private metadata read failure"); },
    },
    async (client) => {
      const result = await client.callTool({
        name: "batch_images",
        arguments: {
          items: [{
            requestId: "persisted-original",
            operation: "generate",
            prompt: "persist even when presentation fails",
          }],
        },
      });

      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.results[0].ok, false);
      assert.deepEqual(result.structuredContent.artifactIds, [source.id]);
      assert.deepEqual(result.structuredContent.summary, {
        total: 1,
        succeeded: 0,
        failed: 1,
        artifactCount: 1,
      });
      assert.equal(result.structuredContent.manifestReady, true);
    },
  );

  assert.deepEqual(recordedManifest.results[0].artifactIds, [source.id]);
  assert.equal(recordedManifest.results[0].ok, true);
  assert.deepEqual(recordedManifest.summary, {
    total: 1,
    succeeded: 1,
    failed: 0,
    artifactCount: 1,
  });
});


test("batch manifest keeps persisted delivery receipts when derived metadata read fails", async () => {
  const source = artifact("img_01J00000000000000000000045");
  const derivedId = "img_01J00000000000000000000046";
  const receiptId = `delivery_${"d".repeat(64)}`;
  const batchId = "batch_01J00000000000000000000047";
  let recordedManifest;
  await withClient(
    {
      runTask: async (task) => {
        if (task.operation === "record_batch") {
          recordedManifest = task.manifest;
          return {
            ok: true,
            manifest: {
              ...task.manifest,
              batchId,
              createdAt: "2026-08-14T08:20:00.000Z",
            },
          };
        }
        return {
          ok: true,
          artifacts: [{ id: source.id }],
          apiDelivery: apiDeliveryFor([source.id]),
          deliveries: [{
            ok: true,
            sourceArtifactId: source.id,
            deliveryReceiptId: receiptId,
            deliveryReady: true,
            artifacts: [{ id: derivedId }],
          }],
        };
      },
      readArtifact: async (id) => {
        if (id === derivedId) throw new Error("private derived metadata read failure");
        return { metadata: source, data: PNG_BASE64 };
      },
    },
    async (client) => {
      const result = await client.callTool({
        name: "batch_images",
        arguments: {
          items: [{
            requestId: "persisted-receipt",
            operation: "generate",
            prompt: "persist receipt even when presentation fails",
            delivery: { qa: true },
          }],
        },
      });

      assert.equal(result.isError, undefined);
      const delivery = result.structuredContent.results[0].delivery.results[0];
      assert.equal(delivery.deliveryReady, false);
      assert.equal(delivery.deliveryReceiptId, receiptId);
      assert.equal(delivery.error.code, "artifact_read_failed");
      assert.equal(result.structuredContent.manifestReady, true);
    },
  );

  assert.deepEqual(recordedManifest.results[0].deliveryReceiptIds, [receiptId]);
  assert.deepEqual(recordedManifest.results[0].deliveryArtifactIds, [derivedId]);
});


test("batch_images refuses an auditable success without apiDelivery", async () => {
  const source = artifact("img_01J00000000000000000000048");
  let recordCalls = 0;
  let readCalls = 0;
  await withClient(
    {
      runTask: async (task) => {
        if (task.operation === "record_batch") {
          recordCalls += 1;
          throw new Error("an invalid batch must not be recorded");
        }
        return { ok: true, artifacts: [{ id: source.id }] };
      },
      readArtifact: async () => {
        readCalls += 1;
        return { metadata: source, data: PNG_BASE64 };
      },
    },
    async (client) => {
      const result = await client.callTool({
        name: "batch_images",
        arguments: {
          items: [{
            requestId: "missing-api-delivery",
            operation: "generate",
            prompt: "missing API receipt",
          }],
        },
      });

      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.results[0].ok, false);
      assert.equal(result.structuredContent.results[0].error.code, "image_task_failed");
      assert.deepEqual(result.structuredContent.artifactIds, [source.id]);
      assert.equal(result.structuredContent.manifestReady, false);
      assert.equal(recordCalls, 0);
      assert.equal(readCalls, 0);
    },
  );
});


test("get_image_batch_manifest reads a persisted manifest without presenting images", async () => {
  const batchId = "batch_01J00000000000000000000052";
  const sourceId = "img_01J00000000000000000000051";
  const manifest = {
    schemaVersion: "batch-manifest.v1",
    summary: { total: 1, succeeded: 1, failed: 0, artifactCount: 1 },
    results: [{
      requestId: "read-a",
      operation: "generate",
      ok: true,
      artifactIds: [sourceId],
      deliveryReceiptIds: [],
      deliveryArtifactIds: [],
    }],
    batchId,
    createdAt: "2026-08-14T08:30:00.000Z",
  };
  let captured;
  await withClient(
    {
      runTask: async (task) => {
        captured = task;
        return { ok: true, manifest };
      },
      readArtifact: async () => { throw new Error("manifest read must not load image bytes"); },
    },
    async (client) => {
      const result = await client.callTool({
        name: "get_image_batch_manifest",
        arguments: { batchId },
      });

      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, manifest);
      assert.equal(result.content.filter((item) => item.type === "image").length, 0);
    },
  );
  assert.deepEqual(captured, {
    operation: "get_batch_manifest",
    modelProfileId: "primary/gpt-image-2",
    batchId,
  });
});


test("get_image_delivery_receipt reads a persisted QA receipt without presenting images", async () => {
  const receiptId = `delivery_${"c".repeat(64)}`;
  const sourceId = "img_01J00000000000000000000061";
  const derived = {
    ...artifact("img_01J00000000000000000000062"),
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
          deliveryReceiptId: receiptId,
          receipt: {
            sourceArtifactId: sourceId,
            deliveryReady: true,
            artifacts: [derived],
            qa: { schema_version: "qa.v1", status: "pass", privatePath: "C:/private" },
            warnings: [],
            summary: { source: { format: "png", width: 1, height: 1 } },
          },
        };
      },
      readArtifact: async () => ({ metadata: derived, data: PNG_BASE64 }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "get_image_delivery_receipt",
        arguments: { deliveryReceiptId: receiptId },
      });

      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.deliveryReceiptId, receiptId);
      assert.equal(result.structuredContent.sourceArtifactId, sourceId);
      assert.deepEqual(result.structuredContent.artifacts, [derived]);
      assert.deepEqual(result.structuredContent.qa, {
        schema_version: "qa.v1",
        status: "pass",
      });
      assert.equal(result.content.filter((item) => item.type === "image").length, 0);
      assert.equal(JSON.stringify(result).includes("C:/private"), false);
    },
  );
  assert.deepEqual(captured, {
    operation: "get_delivery_receipt",
    modelProfileId: "primary/gpt-image-2",
    deliveryReceiptId: receiptId,
  });
});


test("batch_images accepts 64 tasks at concurrency 8 and marks runtime tasks as batch items", async () => {
  const calls = [];
  let active = 0;
  let peakActive = 0;
  await withClient(
    {
      runTask: async (task) => {
        calls.push(task);
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        const index = Number.parseInt(task.prompt.slice("batch task ".length), 10) + 1;
        const artifactId = batchArtifactId(index);
        return {
          ok: true,
          artifacts: [{ id: artifactId }],
          apiDelivery: apiDeliveryFor([artifactId]),
        };
      },
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "batch_images",
        arguments: {
          concurrency: 8,
          items: Array.from({ length: 64 }, (_, index) => ({
            requestId: `task-${index}`,
            operation: "generate",
            prompt: `batch task ${index}`,
          })),
        },
      });

      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.results.length, 64);
      assert.equal(result.structuredContent.artifactIds.length, 64);
      assert.deepEqual(result.structuredContent.summary, {
        total: 64,
        succeeded: 64,
        failed: 0,
        artifactCount: 64,
      });
    },
  );

  const imageCalls = calls.filter((task) => task.operation !== "record_batch");
  assert.equal(imageCalls.length, 64);
  assert.equal(peakActive, 8);
  assert.equal(imageCalls.every((task) => task.executionMode === "batch-item"), true);
  assert.equal(imageCalls.every((task) => !Object.hasOwn(task.output, "executionMode")), true);
});


test("batch_images rejects 65 tasks and aggregate count 65 before any runtime or repository side effect", async () => {
  const sideEffects = { threadStarts: 0, keyReads: 0, networkRequests: 0, repositoryCalls: 0 };
  await withClient(
    {
      runTask: async () => {
        sideEffects.threadStarts += 1;
        sideEffects.keyReads += 1;
        sideEffects.networkRequests += 1;
        sideEffects.repositoryCalls += 1;
        throw new Error("must not run an oversized batch");
      },
      readArtifact: async () => {
        sideEffects.repositoryCalls += 1;
        throw new Error("must not read an oversized batch");
      },
    },
    async (client, { artifactRoot }) => {
      const repositoryPaths = [artifactRoot, path.join(artifactRoot, "index.json"), path.join(artifactRoot, ".repository.lock"), path.join(artifactRoot, ".submission.lock"), path.join(artifactRoot, "batches")];
      for (const target of repositoryPaths) await assert.rejects(access(target), { code: "ENOENT" });
      const oversizedBatches = [
        Array.from({ length: 65 }, (_, index) => ({
          requestId: `task-limit-${index}`,
          operation: "generate",
          prompt: `oversized task ${index}`,
        })),
        [10, 10, 10, 10, 10, 10, 5].map((count, index) => ({
          requestId: `oversized-${index}`,
          operation: "generate",
          prompt: `oversized task ${index}`,
          count,
        })),
      ];
      for (const items of oversizedBatches) {
        const result = await client.callTool({ name: "batch_images", arguments: { concurrency: 3, items } });
        assert.equal(result.isError, true);
      }
      assert.deepEqual(sideEffects, { threadStarts: 0, keyReads: 0, networkRequests: 0, repositoryCalls: 0 });
      for (const target of repositoryPaths) await assert.rejects(access(target), { code: "ENOENT" });
    },
  );
});


test("deliver_image maps a stable source ID to a local delivery task without presenting images", async () => {
  const sourceId = "img_01J00000000000000000000000";
  const deliveryReceiptId = `delivery_${"b".repeat(64)}`;
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
          deliveryReceiptId,
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
            transparency: TRANSPARENCY_REQUEST,
          },
        },
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent.sourceArtifactId, sourceId);
      assert.equal(result.structuredContent.deliveryReceiptId, deliveryReceiptId);
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
    transparency: TRANSPARENCY_REQUEST,
  });
});


test("deliver_image rejects a delivery result for a different source artifact", async () => {
  const sourceId = "img_01J00000000000000000000003";
  const otherSourceId = "img_01J00000000000000000000004";
  let artifactReads = 0;
  await withClient(
    {
      runTask: async () => ({
        ok: true,
        sourceArtifactId: otherSourceId,
        deliveryReady: true,
        artifacts: [],
      }),
      readArtifact: async () => {
        artifactReads += 1;
        throw new Error("must not read a mismatched delivery result");
      },
    },
    async (client) => {
      const result = await client.callTool({
        name: "deliver_image",
        arguments: { imageId: sourceId, delivery: { qa: true } },
      });

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /^invalid_task:/);
      assert.equal(artifactReads, 0);
    },
  );
});


test("deliver_image sanitizes local delivery reports before returning them", async () => {
  const sourceId = "img_01J00000000000000000000020";
  const privateText = "provider secret at C:/Users/private/auth.json";
  const privateToken = "runtime-secret-without-path";
  const opaqueProbe = "ZXCV-938475";
  const nestedMetricProbe = 987654321;
  await withClient(
    {
      runTask: async () => ({
        ok: true,
        sourceArtifactId: sourceId,
        deliveryReady: false,
        artifacts: [],
        qa: {
          schema_version: "qa.v1",
          status: "fail",
          source: "C:/Users/private/source.png",
          secret: privateText,
          debugMessage: privateToken,
          providerDetail: opaqueProbe,
          artifacts: [{
            file: "C:/Users/private/output.png",
            role: "delivery",
            inspection: {
              path: "C:/Users/private/output.png",
              format: "png",
              width: 1,
              height: 1,
              mode: "rgba",
              has_alpha: false,
              sha256: opaqueProbe,
              nontransparent_pixels: 1,
              alpha_coverage: 1,
              alpha_bbox: [0, 0, 0, 0],
              semi_transparent_ratio: 0,
              alpha_margins: {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
                runtimeSecretWithoutPath: nestedMetricProbe,
              },
              corner_alpha: {
                top_left: 255,
                top_right: 255,
                bottom_left: 255,
                bottom_right: 255,
                runtimeSecretWithoutPath: nestedMetricProbe,
              },
              edge_alpha: {
                pixels: 1,
                nontransparent_pixels: 1,
                partial_alpha_pixels: 0,
                touches_canvas: true,
                runtimeSecretWithoutPath: nestedMetricProbe,
              },
              components: {
                count: 1,
                largest_pixels: 1,
                largest_ratio: 1,
                tiny_count: 1,
                tiny_max_pixels: 16,
                runtimeSecretWithoutPath: nestedMetricProbe,
              },
            },
            checks: [{
              name: "expected_size",
              status: "pass",
              expected: [1, 1],
              actual: [1, 1],
              reason: opaqueProbe,
            }],
          }],
          conditions: [{
            kind: "transparent",
            requested: true,
            status: "fail",
            reason: opaqueProbe,
            evidence: {
              artifacts: 1,
              alpha: [false],
              runtimeSecretWithoutPath: nestedMetricProbe,
            },
          }],
          warnings: [privateText, opaqueProbe],
          errors: [opaqueProbe],
        },
        warnings: [privateText],
        summary: {
          source: { format: "png", width: 1, height: 1 },
          path: "C:/Users/private/result.png",
          note: privateToken,
          transforms: [{
            kind: "exact-size",
            size: [1, 1],
            fit: "contain",
            resample: "nearest",
            safeMargin: 0,
            providerDetail: opaqueProbe,
          }],
        },
      }),
      readArtifact: async () => { throw new Error("not used"); },
    },
    async (client) => {
      const result = await client.callTool({
        name: "deliver_image",
        arguments: { imageId: sourceId, delivery: { qa: true } },
      });

      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent.warnings, [
        "delivery_not_ready: 本地图片交付条件尚未满足。",
      ]);
      assert.equal(result.structuredContent.qa.source, undefined);
      assert.equal(result.structuredContent.qa.secret, undefined);
      assert.equal(result.structuredContent.summary.path, undefined);
      assert.deepEqual(result.structuredContent.qa.artifacts[0], {
        role: "delivery",
        inspection: {
          format: "png",
          width: 1,
          height: 1,
          mode: "rgba",
          has_alpha: false,
          nontransparent_pixels: 1,
          alpha_coverage: 1,
          alpha_bbox: [0, 0, 0, 0],
          semi_transparent_ratio: 0,
          alpha_margins: { left: 0, top: 0, right: 0, bottom: 0 },
          corner_alpha: { top_left: 255, top_right: 255, bottom_left: 255, bottom_right: 255 },
          edge_alpha: {
            pixels: 1,
            nontransparent_pixels: 1,
            partial_alpha_pixels: 0,
            touches_canvas: true,
          },
          components: {
            count: 1,
            largest_pixels: 1,
            largest_ratio: 1,
            tiny_count: 1,
            tiny_max_pixels: 16,
          },
        },
        checks: [{
          name: "expected_size",
          status: "pass",
          expected: [1, 1],
          actual: [1, 1],
        }],
      });
      assert.deepEqual(result.structuredContent.qa.conditions[0], {
        kind: "transparent",
        requested: true,
        status: "fail",
        evidence: { artifacts: 1, alpha: [false] },
      });
      assert.deepEqual(result.structuredContent.summary, {
        source: { format: "png", width: 1, height: 1 },
        transforms: [{
          kind: "exact-size",
          size: [1, 1],
          fit: "contain",
          resample: "nearest",
          safeMargin: 0,
        }],
      });
      assert.equal(JSON.stringify(result).includes(privateText), false);
      assert.equal(JSON.stringify(result).includes(privateToken), false);
      assert.equal(JSON.stringify(result).includes(opaqueProbe), false);
      assert.equal(JSON.stringify(result).includes("runtimeSecretWithoutPath"), false);
      assert.equal(JSON.stringify(result).includes(String(nestedMetricProbe)), false);
      assert.equal(JSON.stringify(result).includes("C:/Users/private"), false);
    },
  );
});


test("deliver_image preserves only whitelisted numeric and boolean transparency checks", async () => {
  const sourceId = "img_01J00000000000000000000021";
  const nestedMetricProbe = 987654323;
  await withClient(
    {
      runTask: async () => ({
        ok: true,
        sourceArtifactId: sourceId,
        deliveryReady: false,
        artifacts: [],
        qa: {
          schema_version: "qa.v1",
          status: "fail",
          checks: {
            status: "unmet",
            transparent_pixel_ratio: 0.25,
            visible_pixel_ratio: 0.75,
            visible_border_ratio: 0.125,
            border_dark: {
              status: "pass",
              coverage: 0.98,
              required: 0.95,
              tolerance: 24,
              privatePath: "C:/Users/private/check.png",
            },
            key_contamination: {
              status: "unmet",
              pixels: 2,
              direct_pixels: 1,
              spill_pixels: 1,
              tested_pixels: 5,
              ratio: 0.4,
              allowed_pixels: 1,
              tolerance: 48,
              spill_threshold: 0.18,
              runtimeSecretWithoutPath: nestedMetricProbe,
            },
            options: {
              gamma: 1.2,
              invert: false,
              background_scope: "edge-connected",
            },
            failures: ["private-runtime-failure"],
          },
        },
      }),
      readArtifact: async () => { throw new Error("not used"); },
    },
    async (client) => {
      const result = await client.callTool({
        name: "deliver_image",
        arguments: { imageId: sourceId, delivery: { qa: true } },
      });

      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent.qa.checks, {
        transparent_pixel_ratio: 0.25,
        visible_pixel_ratio: 0.75,
        visible_border_ratio: 0.125,
        border_dark: { coverage: 0.98, required: 0.95, tolerance: 24 },
        key_contamination: {
          pixels: 2,
          direct_pixels: 1,
          spill_pixels: 1,
          tested_pixels: 5,
          ratio: 0.4,
          allowed_pixels: 1,
          tolerance: 48,
          spill_threshold: 0.18,
        },
        options: { gamma: 1.2, invert: false },
      });
      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes("C:/Users/private"), false);
      assert.equal(serialized.includes("background_scope"), false);
      assert.equal(serialized.includes("private-runtime-failure"), false);
      assert.equal(serialized.includes("runtimeSecretWithoutPath"), false);
      assert.equal(serialized.includes(String(nestedMetricProbe)), false);
    },
  );
});


test("generate_image and edit_image keep transparency outside provider output", async () => {
  const parentId = "img_01J00000000000000000000000";
  const generated = artifact("img_01J00000000000000000000001");
  const edited = artifact("img_01J00000000000000000000002", [parentId]);
  const tasks = [];
  await withClient(
    {
      runTask: async (task) => {
        tasks.push(task);
        const artifactId = task.operation === "generate" ? generated.id : edited.id;
        return {
          ok: true,
          artifacts: [{ id: artifactId }],
          apiDelivery: apiDeliveryFor([artifactId]),
        };
      },
      readArtifact: async (id) => ({
        metadata: id === generated.id ? generated : edited,
        data: PNG_BASE64,
      }),
    },
    async (client) => {
      const generatedResult = await client.callTool({
        name: "generate_image",
        arguments: {
          prompt: "transparent glow",
          quality: "high",
          transparency: TRANSPARENCY_REQUEST,
        },
      });
      const editedResult = await client.callTool({
        name: "edit_image",
        arguments: {
          parentImageId: parentId,
          prompt: "preserve glow with transparency",
          format: "png",
          transparency: TRANSPARENCY_REQUEST,
        },
      });

      assert.equal(generatedResult.isError, undefined);
      assert.equal(editedResult.isError, undefined);
    },
  );

  assert.deepEqual(tasks, [
    {
      operation: "generate",
      modelProfileId: "primary/gpt-image-2",
      prompt: "transparent glow",
      inputArtifactIds: [],
      annotationId: null,
      transparency: TRANSPARENCY_REQUEST,
      output: { quality: "high" },
    },
    {
      operation: "edit",
      modelProfileId: "primary/gpt-image-2",
      prompt: "preserve glow with transparency",
      inputArtifactIds: [parentId],
      annotationId: null,
      transparency: TRANSPARENCY_REQUEST,
      output: { format: "png" },
    },
  ]);
  assert.equal(Object.hasOwn(tasks[0].output, "transparency"), false);
  assert.equal(Object.hasOwn(tasks[1].output, "transparency"), false);
});


test("batch_images returns only the safe API delivery receipt fields", async () => {
  const source = artifact("img_01J00000000000000000000031");
  await withClient(
    {
      runTask: async () => ({
        ok: true,
        artifacts: [{ id: source.id }],
        apiDelivery: {
          status: "partial",
          requestedCount: 2,
          returnedCount: 2,
          publishedCount: 1,
          providerDetail: "private provider response",
          items: [{
            responseIndex: 1,
            artifactId: source.id,
            actualFormat: "png",
            width: 1,
            height: 1,
            privatePath: "C:/Users/private/image.png",
          }],
          issues: [
            { code: "item_unusable", responseIndex: 2, reason: "private decode error" },
            { code: "unknown_private_issue", responseIndex: 1 },
          ],
        },
      }),
      readArtifact: async () => ({ metadata: source, data: PNG_BASE64 }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "batch_images",
        arguments: {
          items: [{
            requestId: "partial-response",
            operation: "generate",
            prompt: "partial provider response",
            count: 2,
          }],
        },
      });

      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent.results[0].apiDelivery, {
        status: "partial",
        requestedCount: 2,
        returnedCount: 2,
        publishedCount: 1,
        items: [{
          responseIndex: 1,
          artifactId: source.id,
          actualFormat: "png",
          width: 1,
          height: 1,
        }],
        issues: [{ code: "item_unusable", responseIndex: 2 }],
      });
      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes("private provider response"), false);
      assert.equal(serialized.includes("C:/Users/private"), false);
      assert.equal(serialized.includes("private decode error"), false);
      assert.equal(serialized.includes("unknown_private_issue"), false);
    },
  );
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
        const artifactId = task.operation === "generate" ? generated.id : edited.id;
        return {
          ok: true,
          artifacts: [{ id: artifactId }],
          apiDelivery: apiDeliveryFor([artifactId]),
        };
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
            {
              requestId: "generate-a",
              operation: "generate",
              prompt: "generated task",
              quality: "high",
              transparency: TRANSPARENCY_REQUEST,
              delivery: { deliverySize: "4x4", fit: "contain", qa: true },
            },
            {
              requestId: "edit-b",
              operation: "edit",
              parentImageId: generated.id,
              prompt: "edited task",
              format: "png",
              transparency: TRANSPARENCY_REQUEST,
              delivery: { deliverySize: "8x8", fit: "stretch", qa: true },
            },
            {
              requestId: "generate-c",
              operation: "generate",
              prompt: "failed task",
              transparency: TRANSPARENCY_REQUEST,
              delivery: { deliverySize: "16x16", qa: true },
            },
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
    executionMode: "batch-item",
    modelProfileId: "primary/gpt-image-2",
    prompt: "generated task",
    inputArtifactIds: [],
    annotationId: null,
    transparency: TRANSPARENCY_REQUEST,
    delivery: { deliverySize: "4x4", fit: "contain", qa: true },
    output: { quality: "high" },
  });
  assert.deepEqual(calls[1], {
    operation: "edit",
    executionMode: "batch-item",
    modelProfileId: "primary/gpt-image-2",
    prompt: "edited task",
    inputArtifactIds: [generated.id],
    annotationId: null,
    transparency: TRANSPARENCY_REQUEST,
    delivery: { deliverySize: "8x8", fit: "stretch", qa: true },
    output: { format: "png" },
  });
  assert.equal(Object.hasOwn(calls[0].output, "transparency"), false);
  assert.equal(Object.hasOwn(calls[0].output, "delivery"), false);
  assert.equal(Object.hasOwn(calls[1].output, "transparency"), false);
  assert.equal(Object.hasOwn(calls[1].output, "delivery"), false);
});


test("batch_images rejects an edit while the same image has a pending canvas submission", async () => {
  const parentId = "img_01J00000000000000000000000";
  let runtimeCalls = 0;
  await withClient(
    {
      runTask: async (task) => {
        if (task.operation === "record_batch") {
          return { ok: false, error: { code: "image_task_failed" } };
        }
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


test("batch_images returns delivery receipts separately from successful API originals", async () => {
  const source = artifact("img_01J00000000000000000000010");
  const deliveryReceiptId = `delivery_${"d".repeat(64)}`;
  const derived = {
    ...artifact("img_01J00000000000000000000011"),
    operation: "derive",
    derivedFrom: source.id,
    deliveryKind: "transparent",
  };
  const privateWarning = "provider secret at C:/Users/private/auth.json";
  const opaqueProbe = "BATCH-ZXCV-938475";
  const nestedMetricProbe = 987654322;

  await withClient(
    {
      runTask: async () => ({
        ok: true,
        artifacts: [{ id: source.id }],
        apiDelivery: apiDeliveryFor([source.id]),
        deliveries: [{
          ok: true,
          deliveryReceiptId,
          sourceArtifactId: source.id,
          deliveryReady: true,
          artifacts: [{ id: derived.id }],
          qa: {
            schema_version: "qa.v1",
            status: "pass",
            providerDetail: opaqueProbe,
            artifacts: [{
              role: "delivery",
              inspection: {
                format: "png",
                width: 1,
                height: 1,
                alpha_margins: {
                  left: 0,
                  top: 0,
                  right: 0,
                  bottom: 0,
                  runtimeSecretWithoutPath: nestedMetricProbe,
                },
              },
            }],
            conditions: [{
              kind: "transparent",
              requested: true,
              status: "pass",
              evidence: {
                artifacts: 1,
                alpha: [true],
                runtimeSecretWithoutPath: nestedMetricProbe,
              },
            }],
            checks: [{ name: "expected_count", status: "pass", expected: 1, actual: 1 }],
          },
          warnings: [privateWarning],
          summary: {
            source: { format: "png", width: 1, height: 1 },
            transforms: [{ kind: "transparent", mode: "prompt-alpha", status: "pass" }],
            privatePath: "C:/Users/private/delivery.png",
          },
        }],
      }),
      readArtifact: async (id) => ({
        metadata: id === source.id ? source : derived,
        data: PNG_BASE64,
      }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "batch_images",
        arguments: {
          items: [{
            requestId: "transparent-a",
            operation: "generate",
            prompt: "transparent badge",
            transparency: TRANSPARENCY_REQUEST,
            delivery: { qa: true },
          }],
        },
      });

      assert.equal(result.isError, undefined);
      const item = result.structuredContent.results[0];
      assert.deepEqual(item.artifacts, [source]);
      assert.equal(item.delivery.deliveryReady, true);
      assert.deepEqual(item.delivery.artifactIds, [derived.id]);
      assert.equal(item.delivery.results[0].deliveryReceiptId, deliveryReceiptId);
      assert.deepEqual(item.delivery.results[0].artifacts, [derived]);
      assert.deepEqual(item.delivery.results[0].qa, {
        schema_version: "qa.v1",
        status: "pass",
        artifacts: [{
          role: "delivery",
          inspection: {
            format: "png",
            width: 1,
            height: 1,
            alpha_margins: { left: 0, top: 0, right: 0, bottom: 0 },
          },
        }],
        conditions: [{
          kind: "transparent",
          requested: true,
          status: "pass",
          evidence: { artifacts: 1, alpha: [true] },
        }],
        checks: [{ name: "expected_count", status: "pass", expected: 1, actual: 1 }],
      });
      assert.deepEqual(item.delivery.results[0].summary, {
        source: { format: "png", width: 1, height: 1 },
        transforms: [{ kind: "transparent", mode: "prompt-alpha", status: "pass" }],
      });
      assert.equal(JSON.stringify(result).includes(privateWarning), false);
      assert.equal(JSON.stringify(result).includes(opaqueProbe), false);
      assert.equal(JSON.stringify(result).includes("runtimeSecretWithoutPath"), false);
      assert.equal(JSON.stringify(result).includes(String(nestedMetricProbe)), false);
      assert.equal(JSON.stringify(result).includes("C:/Users/private"), false);
    },
  );
});


test("batch_images keeps API originals successful when local delivery receipts are unavailable", async () => {
  const cases = [
    { prompt: "missing receipt", expectedCode: "image_task_failed" },
    { prompt: "failed receipt", expectedCode: "unsupported_capability" },
    { prompt: "receipt without success marker", expectedCode: "image_task_failed" },
    { prompt: "derived read failure", expectedCode: "artifact_read_failed" },
  ];
  let sequence = 0;
  await withClient(
    {
      runTask: async (task) => {
        sequence += 1;
        const source = artifact(`img_01J0000000000000000000010${sequence}`);
        if (task.prompt === "missing receipt") {
          return {
            ok: true,
            artifacts: [{ id: source.id }],
            apiDelivery: apiDeliveryFor([source.id]),
          };
        }
        if (task.prompt === "failed receipt") {
          return {
            ok: true,
            artifacts: [{ id: source.id }],
            apiDelivery: apiDeliveryFor([source.id]),
            deliveries: [{
              ok: false,
              sourceArtifactId: source.id,
              error: { code: "unsupported_capability", message: "private provider detail" },
            }],
          };
        }
        if (task.prompt === "receipt without success marker") {
          return {
            ok: true,
            artifacts: [{ id: source.id }],
            apiDelivery: apiDeliveryFor([source.id]),
            deliveries: [{
              sourceArtifactId: source.id,
              deliveryReady: true,
              artifacts: [],
            }],
          };
        }
        return {
          ok: true,
          artifacts: [{ id: source.id }],
          apiDelivery: apiDeliveryFor([source.id]),
          deliveries: [{
            ok: true,
            sourceArtifactId: source.id,
            deliveryReady: true,
            artifacts: [{ id: `img_01J0000000000000000000020${sequence}` }],
          }],
        };
      },
      readArtifact: async (id) => {
        if (id.includes("0000000000000000000020")) throw new Error("private derived read failure");
        return { metadata: artifact(id), data: PNG_BASE64 };
      },
    },
    async (client) => {
      for (const testCase of cases) {
        const result = await client.callTool({
          name: "batch_images",
          arguments: {
            items: [{
              requestId: `case-${sequence + 1}`,
              operation: "generate",
              prompt: testCase.prompt,
              delivery: { qa: true },
            }],
          },
        });

        assert.equal(result.isError, undefined, testCase.prompt);
        const item = result.structuredContent.results[0];
        assert.equal(item.ok, true, testCase.prompt);
        assert.equal(item.artifacts.length, 1, testCase.prompt);
        assert.equal(item.delivery.deliveryReady, false, testCase.prompt);
        assert.equal(item.delivery.results[0].deliveryReady, false, testCase.prompt);
        assert.equal(item.delivery.results[0].error.code, testCase.expectedCode, testCase.prompt);
        assert.deepEqual(result.structuredContent.summary, {
          total: 1,
          succeeded: 1,
          failed: 0,
          artifactCount: 1,
        });
      }
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


function apiDeliveryFor(artifactIds, { requestedCount = artifactIds.length, returnedCount = artifactIds.length } = {}) {
  return {
    status: artifactIds.length === requestedCount ? "published" : "partial",
    requestedCount,
    returnedCount,
    publishedCount: artifactIds.length,
    items: artifactIds.map((artifactId, index) => ({
      responseIndex: index + 1,
      artifactId,
      actualFormat: "png",
      width: 1,
      height: 1,
    })),
    issues: artifactIds.length === requestedCount ? [] : [{ code: "count_mismatch" }],
  };
}


function batchArtifactId(index) {
  return `img_${String(index).padStart(26, "0")}`;
}


async function withClient(dependencies, callback) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-mcp-delivery-batch-"));
  const pluginRoot = path.join(fixtureRoot, "plugin-cache");
  const projectRoot = path.join(fixtureRoot, "workspace");
  await Promise.all([mkdir(pluginRoot), mkdir(projectRoot)]);
  const server = createImagegenServer({
    releaseIdentity: TEST_RELEASE_IDENTITY,
    launchContext: { cwd: pluginRoot, pluginRoot },
    projectContext: createFixtureProjectContext({ projectRoot }),
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
    assert.deepEqual(binding.structuredContent, {
      status: "bound",
      projectBindingId: FIXTURE_PROJECT_BINDING_ID,
    });
    client.callTool = async (request, ...rest) => await originalCallTool(
      {
        ...request,
        arguments: { projectBindingId: FIXTURE_PROJECT_BINDING_ID, ...request.arguments },
        _meta: request._meta ?? requestMeta,
      },
      ...rest,
    );
    await callback(client, { artifactRoot: path.join(projectRoot, "output", "imagegen") });
  } finally {
    await client.close();
    await server.close();
    await rm(fixtureRoot, { recursive: true });
  }
}
