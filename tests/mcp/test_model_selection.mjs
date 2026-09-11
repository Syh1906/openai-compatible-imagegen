import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withClient, artifact, PNG_BASE64, assertToolErrorCode } from "../support/mcp-tool-client.mjs";
import { resolveModelSelection, bindCanvasSelection } from "../../mcp/model-selection.mjs";
import { parseEditorDraft } from "../../mcp/editor-draft-contract.mjs";
import { runImageTask } from "../../mcp/image-runtime.mjs";

const config = { config_version: 2, active_profile: "a", providers: { p: { protocol: "openai-compatible", base_url: "https://example.test/v1" } }, models: {
  a: { provider: "p", model: "same", aliases: ["first"], capabilities: { edit: true } },
  b: { provider: "p", model: "same", capabilities: { edit: true } },
} };
const context = { apiRuntimeConfig: config, activeProfile: "a" };

test("MCP lists real Python catalogs with empty limits and native output defaults", async () => {
  for (const native of [false, true]) {
    const defaults = native ? { aspect_ratio: "16:9", resolution: "2K" } : { size: "1024x1024" };
    const limits = native ? { max_input_images: 3 } : {};
    const effectiveConfigJson = JSON.stringify({
      config_version: native ? 2 : 1,
      active_profile: "primary/gpt-image-2",
      ...(native ? {} : { defaults }),
      providers: { primary: { protocol: native ? "xai-images" : "openai-compatible", base_url: "https://example.test/v1", api_key: "fixture-key" } },
      models: { "primary/gpt-image-2": { provider: "primary", model: native ? "grok-imagine-image-2.0" : "gpt-image-2", capabilities: { generate: true, edit: true }, ...(native ? { defaults, limits } : {}) } },
    });
    await withClient({
      runTask: (task, runtimeContext) => runImageTask(task, {
        ...runtimeContext, effectiveConfigJson,
        effectiveConfigSha256: createHash("sha256").update(effectiveConfigJson).digest("hex"),
      }),
    }, async (client) => {
      const result = await client.callTool({ name: "list_image_models", arguments: {} });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      assert.equal(result.structuredContent.models.length, 1);
      const model = result.structuredContent.models[0];
      assert.deepEqual(model.limits, limits);
      for (const [key, value] of Object.entries(defaults)) assert.equal(model.defaults[key], value);
      assert.equal(model.protocol, native ? "xai-images" : "openai-compatible");
    });
  }
});

test("durable jobs retain distinct native refusal and empty-output errors without retrying", async () => {
  for (const code of ["image_content_blocked", "image_response_empty", "image_response_incomplete", "image_response_invalid_mime"]) {
    let calls = 0;
    await withClient({ runTask: async () => { calls += 1; return { ok: false, error: { code, message: "private provider detail" } }; } }, async (client) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "cube" } });
      assertToolErrorCode(result, code);
      assert.equal(calls, 1);
      assert.equal(JSON.stringify(result).includes("private provider detail"), false);
    });
  }
});

test("selection resolves exact profiles and aliases without guessing ambiguous model IDs", () => {
  assert.equal(resolveModelSelection(context, "first").modelProfileId, "a");
  assert.equal(resolveModelSelection(context, "b").modelProfileId, "b");
  assert.throws(() => resolveModelSelection(context, "same"), /ambiguous/);
  assert.throws(() => resolveModelSelection(context, "missing"), /configured/);
});

test("canvas freezes API selection and rejects overrides or changed profile config", () => {
  const selection = resolveModelSelection(context, "b");
  const request = bindCanvasSelection(context, { prompt: "edit" }, { authMode: "apikey", ...selection, parameters: { seed: 7 } });
  assert.equal(request.modelProfileId, "b");
  assert.deepEqual(request.parameters, { seed: 7 });
  assert.throws(() => bindCanvasSelection(context, { modelProfileId: "a" }, { authMode: "apikey", ...selection }), /match/);
  assert.throws(() => bindCanvasSelection(context, {}, { authMode: "chatgpt" }), /ChatGPT/);
  assert.throws(() => bindCanvasSelection(context, { quality: "high" }, { authMode: "apikey", ...selection, output: { quality: "low" } }), /match/);
  const changed = structuredClone(context);
  changed.apiRuntimeConfig.models.b.model = "new-model";
  assert.throws(() => bindCanvasSelection(changed, {}, { authMode: "apikey", ...selection }), /changed/);
});

test("model-only drafts survive without manufacturing an edit intent", () => {
  assert.deepEqual(parseEditorDraft({ annotations: [], prompt: "", modelSelection: { authMode: "apikey", modelProfileId: "b" } })?.modelSelection,
    { authMode: "apikey", modelProfileId: "b" });
  assert.equal(parseEditorDraft({ annotations: [], prompt: "" }), null);
});

test("MCP preparation binds a non-default profile through the durable edit job", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "model-binding-"));
  const parent = artifact("img_01J00000000000000000000000");
  const child = artifact("img_01J00000000000000000000001", [parent.id]);
  const calls = [];
  const receipt = { status: "bound", projectBindingId: `pbind_${"0".repeat(64)}`, distribution: "plugin", defaultAuthMode: "apikey", canvasSubmissionMode: "auto", apiKeyConfigured: true, chatgptRequirement: "codex_app_imagegen_handoff" };
  try {
    await withClient({
      projectContext: { bind: async () => receipt, require: async () => ({ ...context, projectRoot: root, artifactRoot: root, bindingKey: "0".repeat(64), effectiveConfigSha256: "0".repeat(64), effectiveConfigJson: JSON.stringify(config) }) },
      runTask: async (task) => { calls.push(task); return { ok: true, artifacts: [child] }; },
      readArtifact: async (id) => ({ metadata: id === parent.id ? parent : child, data: PNG_BASE64 }),
    }, async (client) => {
      const prepared = await client.callTool({ name: "prepare_image_edit_submission", arguments: { parentImageId: parent.id, items: [], sourcePrompt: "blue", modelSelection: { authMode: "apikey", modelProfileId: "b", parameters: { seed: 7 } } } });
      assert.equal(prepared.isError, undefined);
      const submissionId = prepared.structuredContent.submission.id;
      const mismatch = await client.callTool({ name: "edit_image", arguments: { parentImageId: parent.id, submissionId, prompt: "blue", modelProfileId: "a" } });
      assertToolErrorCode(mismatch, "edit_submission_mismatch");
      assert.equal(calls.length, 0);
      const edited = await client.callTool({ name: "edit_image", arguments: { parentImageId: parent.id, submissionId, prompt: "blue" } });
      assert.equal(edited.isError, undefined);
      assert.equal(calls[0].modelProfileId, "b");
      assert.deepEqual(calls[0].output.parameters, { seed: 7 });
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
