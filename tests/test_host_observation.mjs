import assert from "node:assert/strict";
import test from "node:test";

import {
  createHostObservationReporter,
  summarizeHostEnvelope,
} from "../web/host-observation.mjs";


const RELEASE_FINGERPRINT = "0123456789abcdefabcd";
const IMAGE_ID = "img_01J00000000000000000000000";
const IMAGE_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";


test("host envelope summaries retain shape without retaining values", () => {
  const summary = summarizeHostEnvelope("ui/notifications/tool-result", {
    content: [{ type: "image", mimeType: "image/png", data: IMAGE_DATA }],
    structuredContent: {
      artifacts: [{ id: IMAGE_ID, mimeType: "image/png" }],
      error: { code: "artifact_read_failed", message: "EACCES: C:/Users/alice/private.png" },
      api_key: "secret-value",
    },
    _meta: {
      widgetData: { id: IMAGE_ID, dataBase64: IMAGE_DATA },
    },
  });

  assert.equal(summary.source, "ui/notifications/tool-result");
  assert.equal(summary.truncated, false);
  assert.deepEqual(summary.errorCodes, ["artifact_read_failed"]);
  assert.equal(summary.fields.some((field) => field.path === "$._meta.widgetData.dataBase64" && field.type === "string" && field.length === IMAGE_DATA.length), true);
  assert.equal(summary.fields.some((field) => field.path === "$.content" && field.type === "array" && field.length === 1), true);
  assert.equal(summary.fields.some((field) => field.path === "$.structuredContent.redacted"), true);
  const serialized = JSON.stringify(summary);
  for (const privateValue of [IMAGE_ID, IMAGE_DATA, "secret-value", "C:/Users/alice/private.png", "api_key"]) {
    assert.equal(serialized.includes(privateValue), false, `summary exposed ${privateValue}`);
  }
});


test("host envelope summaries generalize dynamic keys and bound large containers", () => {
  const dynamicKeySummary = summarizeHostEnvelope("ui/notifications/tool-result", {
    structuredContent: {
      [IMAGE_ID]: { status: "ready" },
      error: { code: "user_123456" },
    },
  });
  assert.equal(JSON.stringify(dynamicKeySummary).includes(IMAGE_ID), false);
  assert.deepEqual(dynamicKeySummary.errorCodes, []);

  const stableRuntimeError = summarizeHostEnvelope("tools/call", {
    error: { code: "unsupported_capability", message: "private provider detail" },
  });
  assert.deepEqual(stableRuntimeError.errorCodes, ["unsupported_capability"]);
  assert.equal(JSON.stringify(stableRuntimeError).includes("private provider detail"), false);

  let deepValue = "leaf";
  for (let index = 0; index < 8; index += 1) {
    deepValue = { [`field_${index}_${"x".repeat(54)}`]: deepValue };
  }
  const deepSummary = summarizeHostEnvelope("tools/call", deepValue);
  assert.equal(deepSummary.fields.every(({ path }) => path.length <= 512), true);

  const errorGroups = Array.from({ length: 8 }, (_, groupIndex) => Object.fromEntries(
    Array.from({ length: 32 }, (_, errorIndex) => [
      `error_${groupIndex}_${errorIndex}`,
      { code: `observed_error_${groupIndex}_${errorIndex}` },
    ]),
  ));
  const errorSummary = summarizeHostEnvelope("tools/call", { errorGroups });
  assert.equal(errorSummary.errorCodes.length <= 32, true);
  assert.equal(errorSummary.fields.length <= 256, true);

  const largeObjectSummary = summarizeHostEnvelope("tools/call", {
    structuredContent: Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`entry_${index}`, index]),
    ),
  });
  const largeObject = largeObjectSummary.fields.find(({ path }) => path === "$.structuredContent");
  assert.equal(largeObject.length, null);
  assert.equal(largeObjectSummary.fields.some(({ path }) => path.startsWith("$.structuredContent.field")), false);

  const sparseArray = new Array(1_000_000);
  const sparseSummary = summarizeHostEnvelope("tools/call", { content: sparseArray });
  assert.equal(sparseSummary.fields.find(({ path }) => path === "$.content")?.length, 1_000_000);

  const oversizedArray = new Proxy([], {
    get(target, key, receiver) {
      return key === "length" ? (64 * 1024 * 1024) + 1 : Reflect.get(target, key, receiver);
    },
  });
  const oversizedSummary = summarizeHostEnvelope("tools/call", { content: oversizedArray });
  assert.equal(oversizedSummary.fields.find(({ path }) => path === "$.content")?.length, 64 * 1024 * 1024);
  assert.equal(oversizedSummary.truncated, true);
});


test("host envelope summaries probe fixed fields without enumerating arbitrary object keys", () => {
  let ownKeysCalls = 0;
  const valueReads = [];
  const target = {
    structuredContent: { artifacts: [] },
    dynamic_payload: "private-value",
  };
  const envelope = new Proxy(target, {
    ownKeys() {
      ownKeysCalls += 1;
      return [
        ...Reflect.ownKeys(target),
        ...Array.from({ length: 50_000 }, (_, index) => `field_${index}`),
      ];
    },
    get(current, key, receiver) {
      valueReads.push(key);
      return Reflect.get(current, key, receiver);
    },
  });

  const summary = summarizeHostEnvelope("ui/notifications/tool-result", envelope);

  assert.equal(ownKeysCalls, 0);
  assert.equal(valueReads.includes("structuredContent"), true);
  assert.equal(valueReads.includes("dynamic_payload"), false);
  assert.equal(summary.fields.some(({ path }) => path === "$.structuredContent.artifacts"), true);
  assert.equal(summary.fields.every(({ type, length }) => type !== "object" || length === null), true);
});


test("host observation reporter submits one release-bound pair", async () => {
  const calls = [];
  const app = {
    callServerTool: async (request) => {
      calls.push(request);
      return { structuredContent: { accepted: request.arguments.observations.length } };
    },
  };
  const reporter = createHostObservationReporter({ app, releaseFingerprint: RELEASE_FINGERPRINT });

  reporter.observeNotification({ structuredContent: { artifacts: [] } });
  await Promise.resolve();
  assert.equal(calls.length, 0);

  reporter.observeToolCall({ content: [], structuredContent: { models: [] } });
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].name, "report_imagegen_host_observation");
  assert.equal(calls[0].arguments.releaseFingerprint, RELEASE_FINGERPRINT);
  assert.deepEqual(
    calls[0].arguments.observations.map((observation) => observation.source),
    ["ui/notifications/tool-result", "tools/call"],
  );

  reporter.observeToolCall({ structuredContent: { models: [{ id: "ignored" }] } });
  await Promise.resolve();
  assert.equal(calls.length, 1);
});


test("host observation reporter ignores failed tools/call results", async () => {
  const calls = [];
  const app = {
    callServerTool: async (request) => {
      calls.push(request);
      return { structuredContent: { accepted: request.arguments.observations.length } };
    },
  };
  const reporter = createHostObservationReporter({ app, releaseFingerprint: RELEASE_FINGERPRINT });

  reporter.observeNotification({ structuredContent: { artifacts: [] } });
  await Promise.resolve();
  reporter.observeToolCall({ isError: true, structuredContent: { error: { code: "image_task_failed" } } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 0);

  reporter.observeToolCall({ isError: false, structuredContent: { models: [] } });
  await waitFor(() => calls.length === 1);
});


test("host observation reporter retries a failed report RPC once", async () => {
  const calls = [];
  let attempts = 0;
  const app = {
    callServerTool: async (request) => {
      calls.push(request);
      attempts += 1;
      if (attempts === 1) throw new Error("transport failed");
      return { structuredContent: { accepted: request.arguments.observations.length } };
    },
  };
  const reporter = createHostObservationReporter({ app, releaseFingerprint: RELEASE_FINGERPRINT });

  reporter.observeNotification({ structuredContent: { artifacts: [] } });
  reporter.observeToolCall({ content: [], structuredContent: { models: [] } });

  await waitFor(() => calls.length === 2);
  assert.equal(reporter.getStatus().state, "submitted");
  assert.equal(reporter.getStatus().attempts, 2);
  assert.deepEqual(
    calls[1].arguments.observations.map((observation) => observation.source),
    ["ui/notifications/tool-result", "tools/call"],
  );
});


test("host observation reporter retries an isError report result once", async () => {
  const calls = [];
  const app = {
    callServerTool: async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        return {
          isError: true,
          structuredContent: { error: { code: "release_identity_mismatch" } },
        };
      }
      return { structuredContent: { accepted: request.arguments.observations.length } };
    },
  };
  const reporter = createHostObservationReporter({ app, releaseFingerprint: RELEASE_FINGERPRINT });

  reporter.observeNotification({ structuredContent: { artifacts: [] } });
  reporter.observeToolCall({ content: [], structuredContent: { models: [] } });

  await waitFor(() => calls.length === 2);
  assert.deepEqual(reporter.getStatus(), { state: "submitted", attempts: 2 });
});


test("host observation reporter stops after two isError report results", async () => {
  const calls = [];
  const app = {
    callServerTool: async (request) => {
      calls.push(request);
      return {
        isError: true,
        structuredContent: { error: { code: "release_identity_mismatch" } },
      };
    },
  };
  const reporter = createHostObservationReporter({ app, releaseFingerprint: RELEASE_FINGERPRINT });

  reporter.observeNotification({ structuredContent: { artifacts: [] } });
  reporter.observeToolCall({ content: [], structuredContent: { models: [] } });

  await waitFor(() => reporter.getStatus().attempts === 2);
  assert.deepEqual(reporter.getStatus(), { state: "failed", attempts: 2 });
  assert.equal(calls.length, 2);
});


test("host observation reporter stops after two failed report RPC attempts", async () => {
  const calls = [];
  const privateError = "EACCES: C:/Users/alice/private-token";
  const app = {
    callServerTool: async (request) => {
      calls.push(request);
      throw new Error(privateError);
    },
  };
  const reporter = createHostObservationReporter({ app, releaseFingerprint: RELEASE_FINGERPRINT });

  reporter.observeNotification({ structuredContent: { artifacts: [] } });
  reporter.observeToolCall({ content: [], structuredContent: { models: [] } });

  await waitFor(() => reporter.getStatus().state === "failed");
  assert.deepEqual(reporter.getStatus(), { state: "failed", attempts: 2 });
  assert.equal(JSON.stringify(reporter.getStatus()).includes(privateError), false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 2);
});


async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("host observation reporter did not submit");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
