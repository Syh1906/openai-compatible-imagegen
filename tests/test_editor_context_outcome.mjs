import assert from "node:assert/strict";
import test from "node:test";

import {
  composerSubmissionStatus,
  observeComposerContext,
  submissionErrorStatus,
  submissionProgressStatus,
} from "../web/editor-context-outcome.mjs";
import { createEditorDraftRegistry } from "../web/editor-drafts.mjs";


test("composer acknowledgement is applied after the pending draft is registered", async () => {
  let resolveOutcome;
  const contextOutcome = new Promise((resolve) => { resolveOutcome = resolve; });
  const calls = [];
  const registry = {
    acknowledge(imageId, submissionId) {
      calls.push([imageId, submissionId]);
      return { updatingTaskInput: true };
    },
  };
  const acknowledged = new Promise((resolve) => {
    observeComposerContext({
      delivery: "composer",
      contextAcknowledged: false,
      contextOutcome,
      submissionId: "sub_current",
      snapshot: { imageId: "img_parent" },
    }, registry, resolve);
  });

  resolveOutcome({ ok: true });

  assert.deepEqual(await acknowledged, {
    imageId: "img_parent",
    status: "任务输入框已更新，请确认后发送",
    tone: "success",
  });
  assert.deepEqual(calls, [["img_parent", "sub_current"]]);
});

test("a late acknowledgement clears composer status when its exact child already arrived", async () => {
  const registry = createEditorDraftRegistry();
  const original = editor("第一版要求");
  registry.saveWorking(original);
  registry.markPending("img_parent", {
    submissionId: "sub_current",
    annotationId: null,
    contextAcknowledged: false,
    snapshot: snapshot(original),
  });
  registry.reconcileArtifacts([{
    id: "img_child",
    parentIds: ["img_parent"],
    annotationId: null,
    parameters: { submissionId: "sub_current" },
  }]);

  const settled = [];
  observeComposerContext({
    delivery: "composer",
    contextAcknowledged: false,
    contextOutcome: Promise.resolve({ ok: true }),
    submissionId: "sub_current",
    snapshot: { imageId: "img_parent" },
  }, registry, (outcome) => settled.push(outcome));

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(registry.status("img_parent").kind, "empty");
  assert.deepEqual(settled, [{
    imageId: "img_parent",
    status: "",
    tone: "neutral",
  }]);
});

test("a late context failure unlocks only its exact updated draft", async () => {
  const registry = createEditorDraftRegistry();
  const first = editor("第一版要求");
  registry.saveWorking(first);
  registry.markPending("img_parent", {
    submissionId: "sub_failed",
    annotationId: null,
    contextAcknowledged: false,
    snapshot: snapshot(first),
  });
  const second = editor("第二版要求");
  registry.saveWorking(second);
  assert.deepEqual(registry.status("img_parent"), { kind: "updated", canUpdate: false });

  const settled = [];
  observeComposerContext({
    delivery: "composer",
    contextAcknowledged: false,
    contextOutcome: Promise.resolve({ ok: false }),
    submissionId: "sub_failed",
    snapshot: { imageId: "img_parent" },
  }, registry, (outcome) => settled.push(outcome));

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(registry.status("img_parent"), { kind: "editing" });
  assert.deepEqual(settled, [{
    imageId: "img_parent",
    status: "任务输入框更新失败，可重新提交",
    tone: "error",
  }]);

  registry.markPending("img_parent", {
    submissionId: "sub_current",
    annotationId: null,
    contextAcknowledged: false,
    snapshot: snapshot(second),
  });
  observeComposerContext({
    delivery: "composer",
    contextAcknowledged: false,
    contextOutcome: Promise.resolve({ ok: false }),
    submissionId: "sub_older",
    snapshot: { imageId: "img_parent" },
  }, registry, (outcome) => settled.push(outcome));

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(registry.status("img_parent"), { kind: "writing" });
  assert.equal(settled.length, 1);
});


test("a rejected replacement restores the previously acknowledged composer draft", async () => {
  const registry = createEditorDraftRegistry();
  const first = editor("第一版要求");
  const second = editor("第二版要求");
  registry.saveWorking(first);
  registry.markPending("img_parent", {
    submissionId: "sub_first",
    annotationId: null,
    contextAcknowledged: true,
    snapshot: snapshot(first),
  });
  registry.saveWorking(second);
  registry.markPending("img_parent", {
    submissionId: "sub_second",
    annotationId: null,
    contextAcknowledged: false,
    updatingTaskInput: true,
    snapshot: snapshot(second),
  });
  assert.deepEqual(registry.status("img_parent"), { kind: "writing" });

  const settled = [];
  observeComposerContext({
    delivery: "composer",
    contextAcknowledged: false,
    contextOutcome: Promise.resolve({ ok: false }),
    submissionId: "sub_second",
    snapshot: { imageId: "img_parent" },
  }, registry, (outcome) => settled.push(outcome));

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(registry.status("img_parent"), { kind: "updated", canUpdate: true });
  assert.deepEqual(settled, [{
    imageId: "img_parent",
    status: "任务输入框更新失败，仍保留上一版，可重新更新",
    tone: "error",
  }]);
});


test("a completed previous draft is not restored when its replacement is rejected", async () => {
  const registry = createEditorDraftRegistry();
  const first = editor("第一版要求");
  const second = editor("第二版要求");
  registry.saveWorking(first);
  registry.markPending("img_parent", {
    submissionId: "sub_first",
    annotationId: "ann_first",
    contextAcknowledged: true,
    snapshot: snapshot(first),
  });
  registry.saveWorking(second);
  registry.markPending("img_parent", {
    submissionId: "sub_second",
    annotationId: "ann_second",
    contextAcknowledged: false,
    updatingTaskInput: true,
    snapshot: snapshot(second),
  });

  registry.reconcileArtifacts([{
    id: "img_child",
    parentIds: ["img_parent"],
    annotationId: "ann_first",
    parameters: { submissionId: "sub_first" },
  }]);
  const settled = [];
  observeComposerContext({
    delivery: "composer",
    contextAcknowledged: false,
    contextOutcome: Promise.resolve({ ok: false }),
    submissionId: "sub_second",
    snapshot: { imageId: "img_parent" },
  }, registry, (outcome) => settled.push(outcome));

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(registry.status("img_parent"), { kind: "editing" });
  assert.deepEqual(settled, [{
    imageId: "img_parent",
    status: "任务输入框更新失败，可重新提交",
    tone: "error",
  }]);
});

test("a replacement rejected after an arrived deferred completion does not restore the completed draft", async () => {
  const registry = createEditorDraftRegistry();
  const first = editor("第一版要求");
  const second = editor("第二版要求");
  registry.saveWorking(first);
  registry.markPending("img_parent", {
    submissionId: "sub_first",
    annotationId: "ann_first",
    contextAcknowledged: false,
    snapshot: snapshot(first),
  });

  registry.reconcileArtifacts([{
    id: "img_child",
    parentIds: ["img_parent"],
    annotationId: "ann_first",
    parameters: { submissionId: "sub_first" },
  }]);
  registry.saveWorking(second);
  registry.markPending("img_parent", {
    submissionId: "sub_second",
    annotationId: "ann_second",
    contextAcknowledged: false,
    updatingTaskInput: true,
    snapshot: snapshot(second),
  });

  const settled = [];
  observeComposerContext({
    delivery: "composer",
    contextAcknowledged: false,
    contextOutcome: Promise.resolve({ ok: false }),
    submissionId: "sub_second",
    snapshot: { imageId: "img_parent" },
  }, registry, (outcome) => settled.push(outcome));

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(registry.status("img_parent"), { kind: "editing" });
  assert.deepEqual(settled, [{
    imageId: "img_parent",
    status: "任务输入框更新失败，可重新提交",
    tone: "error",
  }]);
});


test("already acknowledged context outcomes do not update draft state", async () => {
  let calls = 0;
  const registry = { acknowledge() { calls += 1; }, reject() { calls += 1; } };
  observeComposerContext({
    delivery: "composer",
    contextAcknowledged: true,
  }, registry, () => { calls += 1; });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 0);
});


test("context outcomes do not update a released widget resource", async () => {
  let calls = 0;
  const registry = { acknowledge() { calls += 1; }, reject() { calls += 1; } };
  observeComposerContext({
    delivery: "composer",
    contextAcknowledged: false,
    contextOutcome: Promise.resolve({ ok: true }),
    submissionId: "sub_late",
    snapshot: { imageId: "img_parent" },
  }, registry, () => { calls += 1; }, () => false);

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 0);
});

test("submission status helpers keep composer and failure states explicit", () => {
  assert.equal(submissionProgressStatus("prepare", true), "正在保存标注...");
  assert.equal(composerSubmissionStatus({ delivery: "composer", contextAcknowledged: true }, true), "任务输入框已更新，请确认后发送");
  assert.equal(composerSubmissionStatus({ delivery: "composer", contextAcknowledged: false }, false), "任务输入框更新未获确认，请检查输入框；若未出现可重新提交");
  assert.equal(submissionErrorStatus("busy"), "上一次任务输入框更新仍在确认中，请稍后再提交");
});


function editor(prompt) {
  return {
    image: { id: "img_parent" },
    annotations: [],
    prompt,
  };
}


function snapshot(value) {
  return {
    imageId: value.image.id,
    annotations: value.annotations,
    prompt: value.prompt,
  };
}
