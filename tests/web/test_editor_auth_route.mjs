import assert from "node:assert/strict";
import test from "node:test";

import { authRouteStatus, createEditorAuthRoute, selectEditorAuthMode } from "../../web/editor-auth-route.mjs";


test("editor auth route honors the bound project default without automatic switching", () => {
  const route = createEditorAuthRoute({
    defaultAuthMode: "chatgpt",
    apiKeyConfigured: false,
    chatgptRequirement: "codex_app_imagegen_handoff",
  });

  assert.deepEqual(route, {
    selectedAuthMode: "chatgpt",
    canvasSubmissionMode: "auto",
    apiKeyConfigured: false,
    chatgptRequirement: "codex_app_imagegen_handoff",
  });
  assert.equal(selectEditorAuthMode(route, "apikey").selectedAuthMode, "apikey");
  assert.equal(route.selectedAuthMode, "chatgpt");
  assert.deepEqual(authRouteStatus(route), {
    label: "ChatGPT 已选择",
    tone: "success",
  });
});


test("editor auth route rejects incomplete receipts and unknown selections", () => {
  assert.equal(createEditorAuthRoute({ defaultAuthMode: "chatgpt", apiKeyConfigured: false }), null);
  assert.throws(() => selectEditorAuthMode(null, "apikey"), /unavailable/);
  assert.throws(() => selectEditorAuthMode({ selectedAuthMode: "apikey" }, "other"), /invalid/);
});

test("editor auth route preserves the configured submission mode when image authentication changes", () => {
  const receipt = { defaultAuthMode: "chatgpt", apiKeyConfigured: true, chatgptRequirement: "codex_app_imagegen_handoff", canvasSubmissionMode: "composer" };
  const route = createEditorAuthRoute(receipt);
  assert.equal(route.canvasSubmissionMode, "composer");
  assert.equal(selectEditorAuthMode(route, "apikey").canvasSubmissionMode, "composer");
  assert.equal(createEditorAuthRoute({ ...receipt, canvasSubmissionMode: "invalid" }), null);
});
