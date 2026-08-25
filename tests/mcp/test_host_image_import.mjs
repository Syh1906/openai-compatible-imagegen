import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readImageArtifact } from "../../mcp/artifact-repository.mjs";
import { createHostImageImporter } from "../../mcp/host-image-import.mjs";
import { artifact, assertToolErrorCode, PNG_BASE64, withClient } from "../support/mcp-tool-client.mjs";


const CONTEXT = {
  projectRoot: "C:/workspace/project",
  artifactRoot: "C:/workspace/project/output/imagegen",
};


test("host image importer sends only frozen handoff fields to the local runtime", async () => {
  const calls = [];
  const importer = createHostImageImporter({
    runOperation: async (request) => {
      calls.push(request);
      if (request.operation === "prepare") return { handoffId: `handoff_${"a".repeat(64)}`, status: "prepared" };
      if (request.operation === "stage") return { handoffId: request.handoffId, status: "staged", imageCount: 1 };
      return { handoffId: request.handoffId, status: "aborted" };
    },
  });

  const prepared = await importer.prepare({ route: "chatgpt", intent: "generate", prompt: "sample", count: 1 }, CONTEXT);
  await importer.stage({
    handoffId: prepared.handoffId,
    hostOutput: { type: "codex-imagegen-saved-path", savedPath: "C:/host/result.png" },
  }, CONTEXT);
  await importer.finalize({ handoffId: prepared.handoffId, action: "abort" }, CONTEXT);

  assert.deepEqual(calls, [
    { operation: "prepare", ...CONTEXT, route: "chatgpt", intent: "generate", prompt: "sample", count: 1 },
    {
      operation: "stage",
      ...CONTEXT,
      handoffId: prepared.handoffId,
      hostOutput: { type: "codex-imagegen-saved-path", savedPath: "C:/host/result.png" },
    },
    { operation: "finalize", ...CONTEXT, handoffId: prepared.handoffId, action: "abort" },
  ]);
});


test("host image importer exposes only stable handoff errors", async () => {
  const importer = createHostImageImporter({
    runOperation: async (request) => {
      throw new Error(request.operation === "stage" ? "host_image_output_invalid" : "unexpected local path C:/secret.png");
    },
  });

  await assert.rejects(
    importer.stage({
      handoffId: `handoff_${"a".repeat(64)}`,
      hostOutput: { type: "codex-imagegen-saved-path", savedPath: "C:/host/result.png" },
    }, CONTEXT),
    (error) => error.code === "host_image_output_invalid" && error.message === "host_image_output_invalid",
  );
  await assert.rejects(
    importer.prepare({ route: "chatgpt", intent: "generate", prompt: "sample", count: 1 }, CONTEXT),
    (error) => error.code === "host_image_import_failed" && error.message === "host_image_import_failed",
  );
});


test("host image importer completes the Node to Python repository handoff", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-host-import-"));
  const projectRoot = path.join(root, "project");
  const artifactRoot = path.join(projectRoot, "output", "imagegen");
  await mkdir(projectRoot);
  try {
    const importer = createHostImageImporter();
    const context = { projectRoot, artifactRoot };
    const prepared = await importer.prepare({ route: "chatgpt", intent: "generate", prompt: "sample", count: 1 }, context);
    const source = path.join(projectRoot, "host-output.png");
    await writeFile(source, Buffer.from(PNG_BASE64, "base64"));
    const staged = await importer.stage({
      handoffId: prepared.handoffId,
      hostOutput: { type: "codex-imagegen-saved-path", savedPath: source },
    }, context);
    const committed = await importer.finalize({ handoffId: prepared.handoffId, action: "commit" }, context);
    const stored = await readImageArtifact(committed.artifacts[0].id, { artifactRoot });

    assert.equal(staged.imageCount, 1);
    assert.equal(stored.metadata.operation, "import");
    assert.equal(stored.metadata.parameters.acquisition.trustLevel, "declared");
    assert.equal(stored.data, PNG_BASE64);
    assert.equal(JSON.stringify(committed).includes(source), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("host image handoff tools keep the host path confined to the stage call", async () => {
  const calls = [];
  const handoffId = `handoff_${"a".repeat(64)}`;
  const imported = { ...artifact("img_01J00000000000000000000000"), provider: "codex-host", model: "unreported", operation: "import" };
  await withClient({
    hostImageImporter: {
      async prepare(input) {
        calls.push(["prepare", input]);
        return { handoffId, status: "prepared" };
      },
      async stage(input) {
        calls.push(["stage", input]);
        return { handoffId, status: "staged", imageCount: 1 };
      },
      async finalize(input) {
        calls.push(["finalize", input]);
        return { handoffId, status: "committed", artifacts: [imported] };
      },
    },
    runTask: async () => { throw new Error("not used"); },
    readArtifact: async () => { throw new Error("not used"); },
  }, async (client) => {
    await client.callTool({
      name: "prepare_host_image_import",
      arguments: { route: "chatgpt", intent: "generate", prompt: "sample", count: 1 },
    });
    await client.callTool({
      name: "stage_host_image_import",
      arguments: { handoffId, hostOutput: { type: "codex-imagegen-saved-path", savedPath: "C:/host/result.png" } },
    });
    const committed = await client.callTool({
      name: "finalize_host_image_import",
      arguments: { handoffId, action: "commit" },
    });
    assert.notEqual(committed.isError, true, JSON.stringify(committed));
    assert.equal(committed.structuredContent.artifacts[0].operation, "import");
    assert.equal(JSON.stringify(committed).includes("C:/host/result.png"), false);
  });
  assert.deepEqual(calls.map(([name]) => name), ["prepare", "stage", "finalize"]);
});


test("ChatGPT edit handoff returns the clean parent and completes the canvas submission", async () => {
  const handoffId = `handoff_${"b".repeat(64)}`;
  const parentImageId = "img_01J00000000000000000000000";
  const childImageId = "img_01J00000000000000000000001";
  const annotationId = "ann_01J00000000000000000000000";
  const submissionId = "sub_0123456789abcdef0123456789abcdef";
  const receipt = { id: submissionId, parentImageId, annotationId, revisionSha256: "a".repeat(64) };
  const registryCalls = [];
  const imported = {
    ...artifact(childImageId, [parentImageId]),
    operation: "import",
    provider: "codex-host",
    model: "unreported",
    annotationId,
    parameters: { submissionId },
  };
  await withClient({
    editSubmissions: {
      async claimForEdit(input) {
        registryCalls.push(["claim", input]);
        return { receipt, claimGeneration: 3, maskSha256: null, maskPolicySha256: null };
      },
      async complete(input) {
        registryCalls.push(["complete", input]);
        return receipt;
      },
      async releaseForEdit(input) {
        registryCalls.push(["release", input]);
        return receipt;
      },
      async resolveForEdit() { return null; },
      async issue() { throw new Error("not used"); },
    },
    hostImageImporter: {
      async prepare(input) {
        assert.equal(input.intent, "edit");
        assert.equal(input.claimGeneration, 3);
        return { handoffId, status: "prepared" };
      },
      async stage() { return { handoffId, status: "staged", imageCount: 1 }; },
      async finalize() {
        return {
          handoffId,
          status: "committed",
          artifacts: [imported],
          editContext: { parentImageId, annotationId, submissionId, claimGeneration: 3 },
        };
      },
    },
    runTask: async () => { throw new Error("not used"); },
    readArtifact: async (imageId) => {
      assert.equal(imageId, parentImageId);
      return { metadata: artifact(parentImageId), data: PNG_BASE64 };
    },
  }, async (client) => {
    const prepared = await client.callTool({
      name: "prepare_host_image_import",
      arguments: {
        route: "chatgpt",
        intent: "edit",
        prompt: "提亮标注区域",
        count: 1,
        parentImageId,
        annotationId,
        submissionId,
      },
    });
    assert.equal(prepared.isError, undefined, JSON.stringify(prepared));
    assert.equal(prepared.content[0].type, "text");
    assert.equal(prepared.content[1].type, "image");
    assert.equal(prepared.content[1].data, PNG_BASE64);

    const committed = await client.callTool({
      name: "finalize_host_image_import",
      arguments: { handoffId, action: "commit" },
    });
    assert.equal(committed.isError, undefined, JSON.stringify(committed));
    assert.equal(committed.structuredContent.artifacts[0].parentIds[0], parentImageId);
    assert.equal(JSON.stringify(committed).includes("claimGeneration"), false);
  });
  assert.deepEqual(registryCalls.map(([name]) => name), ["claim", "complete"]);
});


test("ChatGPT-only projects reject API tools before any provider runtime call", async () => {
  const projectBindingId = `pbind_${"0".repeat(64)}`;
  const receipt = {
    status: "bound",
    projectBindingId,
    distribution: "plugin",
    defaultAuthMode: "chatgpt",
    apiKeyConfigured: false,
    chatgptRequirement: "codex_app_imagegen_handoff",
  };
  let runtimeCalls = 0;
  await withClient({
    expectedBindingReceipt: receipt,
    projectContext: {
      async bind() { return receipt; },
      async require() {
        return {
          bindingKey: "0".repeat(64),
          projectRoot: "C:/workspace/project",
          artifactRoot: "C:/workspace/project/output/imagegen",
          activeProfile: null,
          apiKeyConfigured: false,
        };
      },
    },
    runTask: async () => { runtimeCalls += 1; throw new Error("must not run"); },
    readArtifact: async () => ({ metadata: artifact("img_01J00000000000000000000000"), data: PNG_BASE64 }),
  }, async (client) => {
    const calls = [
      { name: "list_image_models", arguments: {} },
      { name: "generate_image", arguments: { prompt: "sample" } },
      { name: "edit_image", arguments: { parentImageId: "img_01J00000000000000000000000", prompt: "sample" } },
      { name: "batch_images", arguments: { items: [{ requestId: "one", operation: "generate", prompt: "sample" }] } },
    ];
    for (const call of calls) {
      assertToolErrorCode(await client.callTool(call), "api_provider_not_configured", call.name);
    }
  });
  assert.equal(runtimeCalls, 0);
});
