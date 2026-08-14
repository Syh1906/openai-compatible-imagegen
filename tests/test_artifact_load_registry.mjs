import assert from "node:assert/strict";
import test from "node:test";

import { createArtifactLoadRegistry } from "../web/artifact-load-registry.mjs";


test("retry clears a previous load error before the artifact becomes ready", () => {
  const registry = createRegistry();
  registry.record(failedArtifact("first failure"));

  registry.record({ ...registry.get("img_retry"), loadState: "loading" });

  assert.equal(registry.get("img_retry").loadState, "loading");
  assert.equal("loadError" in registry.get("img_retry"), false);

  registry.capture(
    ["img_retry"],
    [{ status: "fulfilled", value: { id: "img_retry", data: "ready-data" } }],
  );

  assert.equal(registry.get("img_retry").loadState, "ready");
  assert.equal(registry.get("img_retry").data, "ready-data");
  assert.equal("loadError" in registry.get("img_retry"), false);
});


test("retry clears a previous load error before a new load error is recorded", () => {
  const registry = createRegistry();
  registry.record(failedArtifact("first failure"));

  registry.record({ ...registry.get("img_retry"), loadState: "loading" });

  assert.equal(registry.get("img_retry").loadState, "loading");
  assert.equal("loadError" in registry.get("img_retry"), false);

  registry.record(failedArtifact("second failure"));

  assert.equal(registry.get("img_retry").loadState, "error");
  assert.equal(registry.get("img_retry").loadError.message, "second failure");
});

test("a stale failed attempt cannot replace a newer attempt for the same artifact", () => {
  const registry = createRegistry();
  const staleAttempt = registry.begin("img_retry");
  const currentAttempt = registry.begin("img_retry");

  const staleCapture = registry.captureAttempt(
    staleAttempt,
    { status: "rejected", reason: new Error("stale failure") },
  );

  assert.equal(staleCapture.accepted, false);
  assert.equal(registry.get("img_retry"), undefined);

  const currentCapture = registry.captureAttempt(
    currentAttempt,
    { status: "fulfilled", value: { id: "img_retry", data: "ready-data" } },
  );
  assert.equal(currentCapture.accepted, true);
  assert.equal(registry.get("img_retry").loadState, "ready");
});

test("a successful immutable artifact read cannot be replaced by a later failure", () => {
  const registry = createRegistry();
  const firstAttempt = registry.begin("img_retry");
  const secondAttempt = registry.begin("img_retry");

  registry.captureAttempt(
    firstAttempt,
    { status: "fulfilled", value: { id: "img_retry", data: "ready-data" } },
  );
  const failedCapture = registry.captureAttempt(
    secondAttempt,
    { status: "rejected", reason: new Error("late failure") },
  );

  assert.equal(failedCapture.accepted, false);
  assert.equal(registry.get("img_retry").loadState, "ready");
  assert.equal(registry.get("img_retry").data, "ready-data");
});


test("a late failed batch capture cannot replace an artifact already captured as ready", () => {
  const registry = createRegistry();

  registry.capture(
    ["img_retry"],
    [{ status: "fulfilled", value: { id: "img_retry", data: "ready-data" } }],
  );
  const [lateCapture] = registry.capture(
    ["img_retry"],
    [{ status: "rejected", reason: new Error("late batch failure") }],
  );

  assert.equal(lateCapture.loadState, "ready");
  assert.equal(lateCapture.data, "ready-data");
  assert.equal(registry.get("img_retry").loadState, "ready");
  assert.equal(registry.get("img_retry").data, "ready-data");
});


function createRegistry() {
  return createArtifactLoadRegistry({
    timeoutMs: 1_000,
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
  });
}


function failedArtifact(message) {
  return {
    id: "img_retry",
    data: "",
    loadState: "error",
    loadError: { code: "artifact_server_error", message },
  };
}
