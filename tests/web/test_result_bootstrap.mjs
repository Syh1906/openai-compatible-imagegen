import assert from "node:assert/strict";
import test from "node:test";

import { createResultBootstrap } from "../../web/result-bootstrap.mjs";


const imageIds = [
  "img_01J00000000000000000000000",
  "img_01J00000000000000000000001",
];
const inputEvent = { type: "tool-input", imageIds, valid: true };
const resultEvent = { type: "tool-result", status: "completed" };
const readyEvent = { type: "host-ready" };

test("input, result, and host readiness start exactly once in every order", () => {
  for (const events of permutations([inputEvent, resultEvent, readyEvent])) {
    const bootstrap = createResultBootstrap();
    const effects = events.flatMap((event) => bootstrap.observe(event));

    assert.deepEqual(effects, [
      { type: "bind", imageIds },
      { type: "start", imageIds },
    ]);
    assert.deepEqual(bootstrap.observe(inputEvent), []);
    assert.deepEqual(bootstrap.observe(resultEvent), []);
    assert.deepEqual(bootstrap.observe(readyEvent), []);
  }
});

test("valid tool input starts reading when the host is ready even if the projected result is missing", () => {
  const bootstrap = createResultBootstrap();

  assert.deepEqual(bootstrap.observe(inputEvent), [
    { type: "bind", imageIds },
  ]);
  assert.deepEqual(bootstrap.observe(readyEvent), [
    { type: "start", imageIds },
  ]);
  assert.deepEqual(bootstrap.observe(resultEvent), []);
});

test("the first valid input freezes image identity", () => {
  const bootstrap = createResultBootstrap();
  const originalIds = [...imageIds];

  assert.deepEqual(bootstrap.observe({ type: "tool-input", imageIds: originalIds, valid: true }), [
    { type: "bind", imageIds },
  ]);
  originalIds[0] = "img_changed";
  assert.deepEqual(bootstrap.observe({
    type: "tool-input",
    imageIds: ["img_01J00000000000000000000002"],
    valid: true,
  }), []);
  assert.deepEqual(bootstrap.observe(resultEvent), []);
  assert.deepEqual(bootstrap.observe(readyEvent), [{ type: "start", imageIds }]);
});

test("the first invalid input fails once and remains frozen", () => {
  for (const invalidInput of [
    { imageIds: undefined, valid: false },
    { imageIds: [], valid: false },
    { imageIds, valid: false },
    { imageIds: [], valid: true },
  ]) {
    const bootstrap = createResultBootstrap();

    assert.deepEqual(bootstrap.observe({ type: "tool-input", ...invalidInput }), [
      { type: "fail", code: "artifact_schema_missing" },
    ]);
    assert.deepEqual(bootstrap.observe(inputEvent), []);
    assert.deepEqual(bootstrap.observe(resultEvent), []);
    assert.deepEqual(bootstrap.observe(readyEvent), []);
  }
});

test("a server error terminates bootstrap once", () => {
  const errorEvent = {
    type: "server-error",
    code: "artifact_server_error",
  };

  for (const prefix of [
    [],
    [inputEvent],
    [resultEvent],
    [readyEvent],
    [inputEvent, resultEvent],
    [inputEvent, readyEvent],
    [resultEvent, readyEvent],
    [inputEvent, resultEvent, readyEvent],
  ]) {
    const bootstrap = createResultBootstrap();
    prefix.flatMap((event) => bootstrap.observe(event));

    assert.deepEqual(bootstrap.observe(errorEvent), [
      { type: "fail", code: "artifact_server_error" },
    ]);
    assert.deepEqual(bootstrap.observe(errorEvent), []);
    assert.deepEqual(bootstrap.observe(inputEvent), []);
    assert.deepEqual(bootstrap.observe(resultEvent), []);
    assert.deepEqual(bootstrap.observe(readyEvent), []);
  }
});

test("dispose suppresses its own and all later effects", () => {
  for (const prefix of [[], [inputEvent], [resultEvent], [readyEvent], [resultEvent, readyEvent]]) {
    const bootstrap = createResultBootstrap();
    prefix.flatMap((event) => bootstrap.observe(event));

    assert.deepEqual(bootstrap.observe({ type: "dispose" }), []);
    assert.deepEqual(bootstrap.observe(inputEvent), []);
    assert.deepEqual(bootstrap.observe(resultEvent), []);
    assert.deepEqual(bootstrap.observe(readyEvent), []);
  }
});

function permutations(values) {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) => permutations([
    ...values.slice(0, index),
    ...values.slice(index + 1),
  ]).map((tail) => [value, ...tail]));
}
