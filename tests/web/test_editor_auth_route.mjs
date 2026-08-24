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
    apiKeyConfigured: false,
    chatgptRequirement: "codex_app_imagegen_handoff",
  });
  assert.equal(selectEditorAuthMode(route, "apikey").selectedAuthMode, "apikey");
  assert.equal(route.selectedAuthMode, "chatgpt");
  assert.deepEqual(authRouteStatus(route), {
    label: "当前图片生成路线暂不支持画布编辑",
    tone: "warning",
  });
});


test("editor auth route rejects incomplete receipts and unknown selections", () => {
  assert.equal(createEditorAuthRoute({ defaultAuthMode: "chatgpt", apiKeyConfigured: false }), null);
  assert.throws(() => selectEditorAuthMode(null, "apikey"), /unavailable/);
  assert.throws(() => selectEditorAuthMode({ selectedAuthMode: "apikey" }, "other"), /invalid/);
});
