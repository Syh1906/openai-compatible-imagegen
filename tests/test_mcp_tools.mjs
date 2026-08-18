import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readImageArtifact } from "../mcp/artifact-repository.mjs";
import {
  artifact,
  assertToolErrorCode,
  EDITOR_WIDGET_URI,
  PNG_BASE64,
  RESULT_WIDGET_URI,
  withClient,
} from "./support/mcp-tool-client.mjs";

test("configuration MCP tools initialize, inspect, and update without exposing credentials", async () => {
  const calls = [];
  await withClient({
    configManager: {
      async initialize() {
        calls.push(["initialize"]);
        return { created: true, path: "user-config", config: { providers: { primary: { api_key_env: "IMAGE_API_KEY" } } }, gitignoreUpdated: true };
      },
      async inspect(input) {
        calls.push(["inspect", input]);
        return { user: { exists: true, config: {} }, project: { exists: false, config: null } };
      },
      async update(input) {
        calls.push(["update", input]);
        return { scope: input.scope, path: "user-config", config: input.changes };
      },
    },
    runTask: async () => { throw new Error("not used"); },
    readArtifact: async () => { throw new Error("not used"); },
  }, async (client) => {
    const initialized = await client.callTool({ name: "initialize_image_config", arguments: {} });
    assert.equal(initialized.structuredContent.created, true);
    const inspected = await client.callTool({ name: "inspect_image_config", arguments: {} });
    assert.equal(inspected.structuredContent.user.exists, true);
    const updated = await client.callTool({ name: "update_image_config", arguments: { changes: { defaults: { quality: "high" } } } });
    assert.equal(updated.structuredContent.scope, "user");
  });
  assert.deepEqual(calls.map(([name]) => name), ["initialize", "inspect", "update"]);
  assert.equal(JSON.stringify(calls).includes('"api_key":"'), false);
});

test("widget resources read the current bundle for each request", async () => {
  let widgetHtml = "<html>first</html>";
  await withClient(
    {
      readWidgetHtml: async () => widgetHtml,
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async () => {
        throw new Error("not used");
      },
    },
    async (client) => {
      const first = await client.readResource({ uri: RESULT_WIDGET_URI });
      widgetHtml = "<html>second</html>";
      const second = await client.readResource({ uri: RESULT_WIDGET_URI });
      assert.equal(first.contents[0].text, "<html>first</html>");
      assert.equal(second.contents[0].text, "<html>second</html>");
      assert.deepEqual(first.contents[0]._meta.ui.csp.resourceDomains, ["data:", "blob:"]);
      assert.deepEqual(first.contents[0]._meta["openai/widgetCSP"].resource_domains, ["data:", "blob:"]);
    },
  );
});

test("configuration and project binding tool descriptions declare local ignore protection", async () => {
  await withClient(
    {
      runTask: async () => { throw new Error("not used"); },
      readArtifact: async () => { throw new Error("not used"); },
    },
    async (client) => {
      const { tools } = await client.listTools();
      const descriptions = new Map(tools.map((tool) => [tool.name, tool.description]));
      assert.match(descriptions.get("initialize_image_config"), /user.*project.*\.gitignore/i);
      assert.match(descriptions.get("update_image_config"), /target configuration directory.*\.gitignore/i);
      assert.match(descriptions.get("bind_imagegen_project"), /artifact directory.*\.gitignore/i);
      for (const tool of tools) {
        assert.doesNotMatch(tool.title || "", /\p{Script=Han}/u, `${tool.name} title`);
        assert.doesNotMatch(tool.description || "", /\p{Script=Han}/u, `${tool.name} description`);
      }
    },
  );
});

test("only the result renderer and focused editor bind app resources", async () => {
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async () => {
        throw new Error("not used");
      },
    },
    async (client) => {
      const { tools } = await client.listTools();
      const generateTool = tools.find((tool) => tool.name === "generate_image");
      const editTool = tools.find((tool) => tool.name === "edit_image");
      const artifactTool = tools.find((tool) => tool.name === "get_image_artifact");
      const renderTool = tools.find((tool) => tool.name === "render_image_results");
      const resultUri = renderTool._meta.ui.resourceUri;
      const editorUri = tools.find((tool) => tool.name === "open_image_editor")._meta.ui.resourceUri;
      const sessionStateTool = tools.find((tool) => tool.name === "get_image_editor_session");
      const draftTool = tools.find((tool) => tool.name === "save_image_editor_draft");
      const finalizeSessionTool = tools.find((tool) => tool.name === "finalize_image_editor_session");
      const annotationTool = tools.find((tool) => tool.name === "save_image_annotations");
      const imageDataTool = tools.find((tool) => tool.name === "read_image_artifact_data");
      const modelTool = tools.find((tool) => tool.name === "list_image_models");

      assert.equal(generateTool._meta?.ui?.resourceUri, undefined);
      assert.equal(editTool._meta?.ui?.resourceUri, undefined);
      assert.equal(artifactTool._meta?.ui?.resourceUri, undefined);
      assert.equal(resultUri, RESULT_WIDGET_URI);
      assert.notEqual(resultUri, editorUri);
      assert.deepEqual(tools.find((tool) => tool.name === "open_image_editor")._meta.ui.visibility, ["app"]);
      assert.deepEqual(sessionStateTool._meta.ui.visibility, ["app"]);
      assert.deepEqual(draftTool._meta.ui.visibility, ["app"]);
      assert.deepEqual(finalizeSessionTool._meta.ui.visibility, ["app"]);
      assert.deepEqual(annotationTool._meta.ui.visibility, ["app"]);
      assert.deepEqual(imageDataTool._meta.ui.visibility, ["app"]);
      assert.equal(imageDataTool._meta["openai/widgetAccessible"], true);
      assert.deepEqual(imageDataTool.outputSchema.required.sort(), ["artifact", "canvasStatus"]);
      assert.equal(imageDataTool.outputSchema.properties.dataBase64, undefined);
      assert.notEqual(annotationTool, undefined);
      assert.notEqual(modelTool, undefined);

      const { resources } = await client.listResources();
      assert.deepEqual(
        resources.map((resource) => resource.uri).sort(),
        [
          resultUri,
          editorUri,
          ...["result", "editor"].flatMap((view) =>
            ["", "-43c3a69a85db10633692", "-9caad8c28a921a55611b"].map(
              (suffix) => `ui://openai-compatible-imagegen/${view}${suffix}.html`,
            )),
        ].sort(),
      );
    },
  );
});

test("all product tools declare precise structured output schemas", async () => {
  await withClient(
    {
      runTask: async () => ({ ok: true, models: [] }),
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
      saveAnnotations: async () => ({
        id: "ann_01J00000000000000000000000",
        imageId: "img_01J00000000000000000000000",
        itemCount: 1,
        previewMimeType: "image/svg+xml",
        hasMask: false,
        maskMimeType: null,
        maskPolicy: null,
      }),
    },
    async (client) => {
      const { tools } = await client.listTools();
      const schemas = new Map(tools.map((tool) => [tool.name, tool.outputSchema]));
      const productTools = [
        "bind_imagegen_project",
        "list_image_models",
        "generate_image",
        "edit_image",
        "get_image_artifact",
        "read_image_artifact_data",
        "render_image_results",
        "reveal_image_artifact",
        "open_image_editor",
        "prepare_image_edit_submission",
        "save_image_annotations",
        "save_image_editor_draft",
        "get_image_editor_session",
        "destroy_image_editor",
        "finalize_image_editor_session",
      ];

      for (const name of productTools) {
        assert.notEqual(schemas.get(name), undefined, `${name} outputSchema missing`);
        assert.equal(schemas.get(name).additionalProperties, false, `${name} outputSchema must be strict`);
      }

      assert.deepEqual(schemas.get("bind_imagegen_project").required.sort(), ["projectBindingId", "status"]);

      assert.deepEqual(schemas.get("list_image_models").required, ["models"]);
      assert.deepEqual(schemas.get("list_image_models").properties.models.items.required.sort(), ["capabilities", "id", "model", "provider"]);
      assert.equal(schemas.get("list_image_models").properties.models.items.additionalProperties, false);
      assert.deepEqual(Object.keys(schemas.get("list_image_models").properties.models.items.properties.capabilities.properties).sort(), ["edit", "generate", "mask", "multi_reference"]);

      for (const name of ["generate_image", "edit_image"]) {
        assert.deepEqual(schemas.get(name).required, ["artifacts"]);
        assert.equal(schemas.get(name).properties.artifacts.items.additionalProperties, false);
        assert.deepEqual(schemas.get(name).properties.artifacts.items.required.sort(), [
          "annotationId",
          "childIds",
          "createdAt",
          "height",
          "id",
          "mimeType",
          "model",
          "operation",
          "parameters",
          "parentIds",
          "prompt",
          "provider",
          "width",
        ]);
      }

      assert.deepEqual(schemas.get("get_image_artifact").required.sort(), ["artifact", "canvasStatus"]);
      assert.deepEqual(schemas.get("render_image_results").required.sort(), ["artifacts", "imageIds"]);
      assert.deepEqual(schemas.get("reveal_image_artifact").required.sort(), ["imageId", "status"]);
      assert.deepEqual(schemas.get("render_image_results").properties.artifacts.items.required.sort(), [
        "annotationId",
        "canvasStatus",
        "childIds",
        "createdAt",
        "height",
        "id",
        "mimeType",
        "model",
        "operation",
        "parameters",
        "parentIds",
        "prompt",
        "provider",
        "width",
      ]);

      assert.deepEqual(schemas.get("open_image_editor").required.sort(), ["artifact", "editorSession"]);
      assert.deepEqual(schemas.get("open_image_editor").properties.editorSession.required.sort(), ["id", "imageId", "status"]);
      assert.equal(schemas.get("open_image_editor").properties.editorSession.additionalProperties, false);
      assert.deepEqual(schemas.get("save_image_annotations").required, ["annotation"]);
      assert.equal(schemas.get("save_image_annotations").properties.annotation.additionalProperties, false);
      assert.deepEqual(schemas.get("save_image_annotations").properties.annotation.required.sort(), [
        "hasMask",
        "id",
        "imageId",
        "itemCount",
        "maskMimeType",
        "maskPolicy",
        "previewMimeType",
      ]);

      assert.deepEqual(schemas.get("prepare_image_edit_submission").required.sort(), ["annotation", "submission"]);
      assert.deepEqual(schemas.get("prepare_image_edit_submission").properties.submission.required.sort(), [
        "annotationId",
        "id",
        "parentImageId",
        "revisionSha256",
      ]);

      for (const name of ["save_image_editor_draft", "get_image_editor_session", "destroy_image_editor", "finalize_image_editor_session"]) {
        assert.deepEqual(schemas.get(name).required, ["editorSession"]);
        assert.deepEqual(schemas.get(name).properties.editorSession.required, ["id", "status"]);
      }
    },
  );
});
test("generate_image leaves candidate presentation to render_image_results", async () => {
  const artifacts = [artifact("img_01J00000000000000000000000"), artifact("img_01J00000000000000000000001")];
  const calls = [];
  await withClient(
    {
      runTask: async (task) => {
        calls.push(task);
        return { ok: true, artifacts };
      },
      readArtifact: async (id) => ({ metadata: artifacts.find((item) => item.id === id), data: PNG_BASE64 }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "generate_image",
        arguments: { prompt: "two candidates", count: 2 },
      });
      const rendered = await client.callTool({
        name: "render_image_results",
        arguments: { imageIds: artifacts.map((item) => item.id) },
      });

      assert.equal(result.isError, undefined);
      assert.equal(result.content.filter((item) => item.type === "image").length, 0);
      assert.deepEqual(result.structuredContent.artifacts, artifacts);
      assert.equal(result._meta?.ui?.resourceUri, undefined);
      assert.deepEqual(result._meta.imageIds, artifacts.map((item) => item.id));
      assert.equal(JSON.stringify(result).includes("runtime-secret"), false);
      assert.equal(rendered.content.filter((item) => item.type === "image").length, 2);
      assert.equal(rendered._meta.ui.resourceUri, RESULT_WIDGET_URI);
      assert.equal(
        [result, rendered].flatMap((item) => item.content).filter((item) => item.type === "image").length,
        2,
      );
    },
  );
  assert.equal(calls[0].operation, "generate");
  assert.equal(calls[0].modelProfileId, "primary/gpt-image-2");
  assert.equal(calls[0].output.count, 2);
});

test("edit_image returns child metadata without duplicating result presentation", async () => {
  const parentId = "img_01J00000000000000000000000";
  const child = artifact("img_01J00000000000000000000001", [parentId]);
  let captured;
  await withClient(
    {
      runTask: async (task) => {
        captured = task;
        return { ok: true, artifacts: [child] };
      },
      readArtifact: async () => ({ metadata: child, data: PNG_BASE64 }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "edit_image",
        arguments: { parentImageId: parentId, prompt: "change the color" },
      });
      assert.equal(result.content.filter((item) => item.type === "image").length, 0);
      assert.deepEqual(result.structuredContent.artifact, child);
      assert.deepEqual(result.structuredContent.artifacts[0].parentIds, [parentId]);
      assert.equal(result._meta?.ui?.resourceUri, undefined);
      assert.equal(result._meta.imageId, child.id);
      assert.deepEqual(result._meta.imageIds, [child.id]);
    },
  );
  assert.equal(captured.operation, "edit");
  assert.deepEqual(captured.inputArtifactIds, [parentId]);
});

test("edit_image rejects a legacy mask annotation without a signed policy", async () => {
  const parentId = "img_01J00000000000000000000000";
  const annotationId = "ann_01J00000000000000000000000";
  const child = artifact("img_01J00000000000000000000001", [parentId]);
  const maskPath = "F:/private/imagegen/annotations/mask.png";
  let runtimeCalls = 0;
  let requestedAnnotationId;
  await withClient(
    {
      runTask: async (task) => {
        runtimeCalls += 1;
        return { ok: true, artifacts: [child] };
      },
      readArtifact: async () => ({ metadata: child, data: PNG_BASE64 }),
      readAnnotation: async (id) => {
        requestedAnnotationId = id;
        return { id, imageId: parentId, maskPath, maskPolicy: null };
      },
    },
    async (client) => {
      const result = await client.callTool({
        name: "edit_image",
        arguments: { parentImageId: parentId, annotationId, prompt: "replace the marked region" },
      });
      assertToolErrorCode(result, "mask_policy_missing");
    },
  );
  assert.equal(requestedAnnotationId, annotationId);
  assert.equal(runtimeCalls, 0);
});

test("edit_image keeps signed v1 mask annotations read-only", async () => {
  const parentId = "img_01J00000000000000000000000";
  const annotationId = "ann_01J00000000000000000000000";
  let runtimeCalls = 0;
  await withClient(
    {
      runTask: async () => {
        runtimeCalls += 1;
        return { ok: true, artifacts: [] };
      },
      readAnnotation: async () => ({
        id: annotationId,
        imageId: parentId,
        maskPath: "F:/legacy/mask.png",
        maskPolicy: {
          policyVersion: "mask-policy-v1",
          modelProfileId: "primary/gpt-image-2",
          requiredCapabilities: { mask: true },
        },
      }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "edit_image",
        arguments: { parentImageId: parentId, annotationId, prompt: "replay legacy mask" },
      });
      assertToolErrorCode(result, "mask_policy_unsupported");
    },
  );
  assert.equal(runtimeCalls, 0);
});

test("a server-issued edit submission binds the exact parent annotation and mask policy", async () => {
  const parentId = "img_01J00000000000000000000000";
  const annotationId = "ann_01J00000000000000000000000";
  const child = artifact("img_01J00000000000000000000001", [parentId]);
  const maskPath = "F:/private/imagegen/annotations/mask.png";
  const policy = {
    policyVersion: "mask-policy-v2",
    modelProfileId: "primary/gpt-image-2",
    requiredCapabilities: { mask: true },
    strategy: "protect-only",
    parentImageId: parentId,
    annotationId,
    width: 1,
    height: 1,
    masks: [{ id: "mask-1", mode: "protect", operation: "paint", radiusPx: 0.04 }],
    hardBoundary: { source: "none", postprocess: "none" },
    semanticProtection: {
      enabled: true,
      source: "protect-strokes",
      preserve: ["identity", "geometry", "text", "texture"],
      allowAdaptation: ["lighting", "shadow", "tone"],
    },
    transitionBand: { kind: "outer-feather", featherRatio: 0.35, minimumWidthPx: 1 },
    maskSha256: "a".repeat(64),
    policySha256: "c".repeat(64),
  };
  const items = [{
    id: "mask-1",
    type: "mask",
    mode: "protect",
    brushRadius: 0.04,
    points: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }],
  }];
  let runtimeTask;
  let runtimeCalls = 0;
  await withClient(
    {
      runTask: async (task) => {
        runtimeCalls += 1;
        runtimeTask = task;
        return { ok: true, artifacts: [child] };
      },
      readArtifact: async (id) => ({ metadata: id === child.id ? child : artifact(id), data: PNG_BASE64 }),
      saveAnnotations: async () => ({
        id: annotationId,
        imageId: parentId,
        itemCount: 1,
        previewMimeType: "image/svg+xml",
        hasMask: true,
        maskMimeType: "image/png",
        maskPolicy: policy,
      }),
      readAnnotation: async () => ({
        id: annotationId,
        imageId: parentId,
        maskPath,
        maskPolicy: policy,
      }),
    },
    async (client) => {
      const prepared = await client.callTool({
        name: "prepare_image_edit_submission",
        arguments: { parentImageId: parentId, items, sourcePrompt: "keep the cup unchanged" },
      });
      assert.equal(prepared.isError, undefined);
      assert.match(prepared.structuredContent.submission.id, /^sub_[0-9a-f]{32}$/);
      assert.equal(prepared.structuredContent.submission.annotationId, annotationId);
      assert.equal(JSON.stringify(prepared).includes(maskPath), false);

      for (const conflict of [
        { size: "2x2" },
        { format: "jpeg" },
        { count: 2 },
      ]) {
        const rejected = await client.callTool({
          name: "edit_image",
          arguments: {
            parentImageId: parentId,
            annotationId,
            submissionId: prepared.structuredContent.submission.id,
            prompt: "conflicting output",
            ...conflict,
          },
        });
        assertToolErrorCode(rejected, "invalid_task");
        assert.equal(runtimeCalls, 0);
      }

      const edited = await client.callTool({
        name: "edit_image",
        arguments: {
          parentImageId: parentId,
          annotationId,
          submissionId: prepared.structuredContent.submission.id,
          prompt: "change only the allowed area",
        },
      });
      assert.equal(edited.isError, undefined);
      assert.equal(runtimeTask.submissionId, prepared.structuredContent.submission.id);
      assert.equal(runtimeTask.annotationId, annotationId);
      assert.equal(runtimeTask.mask, maskPath);
      assert.deepEqual(runtimeTask.maskPolicy, policy);
      assert.deepEqual(runtimeTask.output, { size: "1x1", format: "png", count: 1 });

      const replayed = await client.callTool({
        name: "edit_image",
        arguments: {
          parentImageId: parentId,
          annotationId,
          submissionId: prepared.structuredContent.submission.id,
          prompt: "repeat",
        },
      });
      assert.equal(replayed.isError, undefined);
      assert.equal(replayed.structuredContent.artifact.id, child.id);
    },
  );
  assert.equal(runtimeCalls, 1);
});

test("prompt-only canvas submissions bind and complete without an annotation", async () => {
  const parentId = "img_01J00000000000000000000000";
  const child = artifact("img_01J00000000000000000000001", [parentId]);
  let runtimeTask;
  await withClient(
    {
      runTask: async (task) => {
        runtimeTask = task;
        return { ok: true, artifacts: [child] };
      },
      readArtifact: async (id) => ({ metadata: id === child.id ? child : artifact(id), data: PNG_BASE64 }),
      saveAnnotations: async () => {
        throw new Error("prompt-only submissions must not save an empty annotation");
      },
    },
    async (client) => {
      const prepared = await client.callTool({
        name: "prepare_image_edit_submission",
        arguments: { parentImageId: parentId, items: [], sourcePrompt: "make the scene warmer" },
      });
      assert.equal(prepared.structuredContent.annotation, null);

      const edited = await client.callTool({
        name: "edit_image",
        arguments: {
          parentImageId: parentId,
          submissionId: prepared.structuredContent.submission.id,
          prompt: "make the scene warmer",
        },
      });
      assert.equal(edited.isError, undefined);
      assert.equal(runtimeTask.annotationId, null);
      assert.equal(runtimeTask.submissionId, prepared.structuredContent.submission.id);
      assert.equal(runtimeTask.mask, undefined);
      assert.equal(runtimeTask.maskPolicy, undefined);
    },
  );
});

test("a concurrent edit replay fails closed while the first runtime call remains in flight", async () => {
  const parentId = "img_01J00000000000000000000000";
  const child = artifact("img_01J00000000000000000000001", [parentId]);
  let runtimeCalls = 0;
  let markRuntimeStarted;
  const runtimeStarted = new Promise((resolve) => { markRuntimeStarted = resolve; });
  let releaseRuntime;
  const runtimeGate = new Promise((resolve) => { releaseRuntime = resolve; });
  await withClient(
    {
      runTask: async () => {
        runtimeCalls += 1;
        markRuntimeStarted();
        await runtimeGate;
        return { ok: true, artifacts: [child] };
      },
      readArtifact: async (id) => ({ metadata: id === child.id ? child : artifact(id), data: PNG_BASE64 }),
    },
    async (client) => {
      const prepared = await client.callTool({
        name: "prepare_image_edit_submission",
        arguments: { parentImageId: parentId, items: [], sourcePrompt: "one edit" },
      });
      const editArguments = {
        parentImageId: parentId,
        submissionId: prepared.structuredContent.submission.id,
        prompt: "one edit",
      };
      const first = client.callTool({ name: "edit_image", arguments: editArguments });
      await runtimeStarted;
      assert.equal(runtimeCalls, 1);
      const replayResult = await client.callTool({ name: "edit_image", arguments: editArguments });
      assertToolErrorCode(replayResult, "stale_edit_submission");
      const replacement = await client.callTool({
        name: "prepare_image_edit_submission",
        arguments: { parentImageId: parentId, items: [], sourcePrompt: "replacement" },
      });
      assertToolErrorCode(replacement, "edit_submission_in_flight");
      releaseRuntime();
      const result = await first;
      assert.equal(result.isError, undefined);
    },
  );
  assert.equal(runtimeCalls, 1);
});

test("a rejected replacement revision removes the annotation saved for that failed receipt", async () => {
  const parentId = "img_01J00000000000000000000000";
  const child = artifact("img_01J00000000000000000000001", [parentId]);
  let nextAnnotation = 0;
  const removed = [];
  let markAnnotationRemoved;
  const annotationRemoved = new Promise((resolve) => { markAnnotationRemoved = resolve; });
  let markRuntimeStarted;
  const runtimeStarted = new Promise((resolve) => { markRuntimeStarted = resolve; });
  let releaseRuntime;
  const runtimeGate = new Promise((resolve) => { releaseRuntime = resolve; });
  await withClient(
    {
      runTask: async () => {
        markRuntimeStarted();
        await runtimeGate;
        return { ok: true, artifacts: [child] };
      },
      readArtifact: async (id) => ({ metadata: id === child.id ? child : artifact(id), data: PNG_BASE64 }),
      saveAnnotations: async ({ imageId, items }) => ({
        id: `ann_01J0000000000000000000000${nextAnnotation++}`,
        imageId,
        itemCount: items.length,
        previewMimeType: "image/svg+xml",
        hasMask: false,
        maskMimeType: null,
        maskPolicy: null,
      }),
      readAnnotation: async (annotationId) => ({
        id: annotationId,
        imageId: parentId,
        items: [{ id: "mark-1", type: "rectangle", x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
        maskPath: null,
        maskPolicy: null,
      }),
      deleteAnnotation: async (annotationId) => {
        removed.push(annotationId);
        markAnnotationRemoved();
      },
    },
    async (client) => {
      const items = [{ id: "mark-1", type: "rectangle", x: 0.1, y: 0.1, width: 0.2, height: 0.2 }];
      const prepared = await client.callTool({
        name: "prepare_image_edit_submission",
        arguments: { parentImageId: parentId, items, sourcePrompt: "first" },
      });
      const first = client.callTool({
        name: "edit_image",
        arguments: {
          parentImageId: parentId,
          annotationId: prepared.structuredContent.annotation.id,
          submissionId: prepared.structuredContent.submission.id,
          prompt: "first",
        },
      });
      await runtimeStarted;
      const replacementPromise = client.callTool({
        name: "prepare_image_edit_submission",
        arguments: { parentImageId: parentId, items, sourcePrompt: "replacement" },
      });
      await annotationRemoved;
      releaseRuntime();
      const [firstResult, replacement] = await Promise.all([first, replacementPromise]);
      assertToolErrorCode(replacement, "edit_submission_in_flight");
      assert.deepEqual(removed, ["ann_01J00000000000000000000001"]);
      assert.equal(firstResult.isError, undefined);
    },
  );
});

test("a committed runtime submission returns the existing child when result metadata read initially fails", async () => {
  const parentId = "img_01J00000000000000000000000";
  const child = artifact("img_01J00000000000000000000001", [parentId]);
  let runtimeCalls = 0;
  let artifactReads = 0;
  await withClient(
    {
      runTask: async () => {
        runtimeCalls += 1;
        return { ok: true, artifacts: [child] };
      },
      readArtifact: async (id) => {
        if (id === parentId) return { metadata: artifact(parentId), data: PNG_BASE64 };
        artifactReads += 1;
        if (artifactReads === 1) throw new Error("metadata temporarily unavailable");
        return { metadata: child, data: PNG_BASE64 };
      },
    },
    async (client) => {
      const prepared = await client.callTool({
        name: "prepare_image_edit_submission",
        arguments: { parentImageId: parentId, items: [], sourcePrompt: "commit once" },
      });
      const editArguments = {
        parentImageId: parentId,
        submissionId: prepared.structuredContent.submission.id,
        prompt: "commit once",
      };
      const first = await client.callTool({ name: "edit_image", arguments: editArguments });
      assertToolErrorCode(first, "image_task_failed");
      const replay = await client.callTool({ name: "edit_image", arguments: editArguments });
      assert.equal(replay.isError, undefined);
      assert.equal(replay.structuredContent.artifact.id, child.id);
    },
  );
  assert.equal(runtimeCalls, 1);
  assert.equal(artifactReads, 2);
});

test("prepared canvas revisions survive validation failure until one completes", async () => {
  const parentId = "img_01J00000000000000000000000";
  const annotationId = "ann_01J00000000000000000000000";
  const policy = {
    policyVersion: "mask-policy-v2",
    modelProfileId: "primary/gpt-image-2",
    requiredCapabilities: { mask: true },
    strategy: "edit-only",
    parentImageId: parentId,
    annotationId,
    width: 1,
    height: 1,
    masks: [{ id: "mask-1", mode: "edit", operation: "paint", radiusPx: 0.04 }],
    hardBoundary: { source: "edit-strokes", postprocess: "parent-blend" },
    semanticProtection: {
      enabled: false,
      source: "protect-strokes",
      preserve: ["identity", "geometry", "text", "texture"],
      allowAdaptation: ["lighting", "shadow", "tone"],
    },
    transitionBand: { kind: "outer-feather", featherRatio: 0.35, minimumWidthPx: 1 },
    maskSha256: "b".repeat(64),
    policySha256: "d".repeat(64),
  };
  let runtimeCalls = 0;
  await withClient(
    {
      runTask: async () => {
        runtimeCalls += 1;
        return { ok: true, artifacts: [artifact("img_01J00000000000000000000001", [parentId])] };
      },
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
      saveAnnotations: async () => ({
        id: annotationId,
        imageId: parentId,
        itemCount: 1,
        previewMimeType: "image/svg+xml",
        hasMask: true,
        maskMimeType: "image/png",
        maskPolicy: policy,
      }),
      readAnnotation: async () => ({ id: annotationId, imageId: parentId, maskPath: "F:/mask.png", maskPolicy: policy }),
    },
    async (client) => {
      const prepare = async (sourcePrompt) => await client.callTool({
        name: "prepare_image_edit_submission",
        arguments: {
          parentImageId: parentId,
          sourcePrompt,
          items: [{ id: "mask-1", type: "mask", mode: "edit", brushRadius: 0.04, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
        },
      });
      const first = await prepare("first revision");

      const missing = await client.callTool({
        name: "edit_image",
        arguments: { parentImageId: parentId, annotationId, prompt: "missing ID" },
      });
      assertToolErrorCode(missing, "missing_edit_submission");

      const latest = await prepare("latest revision");
      const mismatch = await client.callTool({
        name: "edit_image",
        arguments: {
          parentImageId: parentId,
          annotationId: "ann_01J00000000000000000000001",
          submissionId: latest.structuredContent.submission.id,
          prompt: "wrong annotation",
        },
      });
      assertToolErrorCode(mismatch, "edit_submission_mismatch");

      policy.policySha256 = "e".repeat(64);
      const policyMismatch = await client.callTool({
        name: "edit_image",
        arguments: {
          parentImageId: parentId,
          annotationId,
          submissionId: latest.structuredContent.submission.id,
          prompt: "tampered policy",
        },
      });
      assertToolErrorCode(policyMismatch, "edit_submission_mismatch");

      policy.policySha256 = "d".repeat(64);
      const selected = await client.callTool({
        name: "edit_image",
        arguments: {
          parentImageId: parentId,
          annotationId,
          submissionId: first.structuredContent.submission.id,
          prompt: "select first revision",
        },
      });
      assert.equal(selected.isError, undefined);

      const stale = await client.callTool({
        name: "edit_image",
        arguments: {
          parentImageId: parentId,
          annotationId,
          submissionId: latest.structuredContent.submission.id,
          prompt: "completed alternative",
        },
      });
      assertToolErrorCode(stale, "stale_edit_submission");
    },
  );
  assert.equal(runtimeCalls, 1);
});

test("legacy mask annotations cannot issue an edit submission without a signed mask policy", async () => {
  const parentId = "img_01J00000000000000000000000";
  let runtimeCalls = 0;
  await withClient(
    {
      runTask: async () => {
        runtimeCalls += 1;
        return { ok: true, artifacts: [] };
      },
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
      saveAnnotations: async () => ({
        id: "ann_01J00000000000000000000000",
        imageId: parentId,
        itemCount: 1,
        previewMimeType: "image/svg+xml",
        hasMask: true,
        maskMimeType: "image/png",
        maskPolicy: null,
      }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "prepare_image_edit_submission",
        arguments: {
          parentImageId: parentId,
          sourcePrompt: "legacy mask",
          items: [{ id: "mask-1", type: "mask", mode: "edit", brushRadius: 0.04, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
        },
      });
      assertToolErrorCode(result, "mask_policy_missing");
    },
  );
  assert.equal(runtimeCalls, 0);
});

test("edit_image rejects an annotation that belongs to another parent", async () => {
  const parentId = "img_01J00000000000000000000000";
  let runtimeCalls = 0;
  await withClient(
    {
      runTask: async () => {
        runtimeCalls += 1;
        return { ok: true, artifacts: [] };
      },
      readArtifact: async () => {
        throw new Error("not used");
      },
      readAnnotation: async (id) => ({ id, imageId: "img_01J00000000000000000000002", maskPath: null }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "edit_image",
        arguments: {
          parentImageId: parentId,
          annotationId: "ann_01J00000000000000000000000",
          prompt: "replace the marked region",
        },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /annotation_image_mismatch/);
    },
  );
  assert.equal(runtimeCalls, 0);
});

test("get_image_artifact returns image bytes without an absolute path", async () => {
  const current = artifact("img_01J00000000000000000000000");
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async () => ({ metadata: current, data: PNG_BASE64 }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "get_image_artifact",
        arguments: { imageId: current.id },
      });
      assert.equal(result.content[0].type, "image");
      assert.deepEqual(result.structuredContent.artifact, current);
      assert.equal(result.structuredContent.canvasStatus, "available");
      assert.equal(result._meta?.ui?.resourceUri, undefined);
      assert.equal(JSON.stringify(result).includes(":\\"), false);
    },
  );
});

test("render_image_results returns ordered metadata and model-visible images", async () => {
  const imageIds = [
    "img_01J00000000000000000000000",
    "img_01J00000000000000000000001",
  ];
  const artifacts = imageIds.map((imageId) => ({ ...artifact(imageId), canvasStatus: "available" }));
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async (imageId) => ({
        metadata: artifact(imageId),
        data: PNG_BASE64,
      }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "render_image_results",
        arguments: { imageIds },
      });

      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent.imageIds, imageIds);
      assert.deepEqual(result.structuredContent.artifacts, artifacts);
      assert.deepEqual(result._meta.imageIds, imageIds);
      assert.equal(result._meta.ui.resourceUri, RESULT_WIDGET_URI);
      assert.equal(result._meta.imageArtifacts, undefined);
      assert.deepEqual(result.content, [
        { type: "text", text: "已显示 2 张图片。" },
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
      ]);
    },
  );
});

test("render_image_results rejects an artifact whose stable ID does not match the request", async () => {
  const requestedImageId = "img_01J00000000000000000000000";
  const otherImageId = "img_01J00000000000000000000001";
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async () => ({
        metadata: artifact(otherImageId),
        data: PNG_BASE64,
      }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "render_image_results",
        arguments: { imageIds: [requestedImageId] },
      });

      assertToolErrorCode(result, "artifact_read_failed");
      assert.equal(result.content?.some((item) => item.type === "image"), false);
      assert.equal(result._meta?.imageIds, undefined);
    },
  );
});

test("render_image_results rejects duplicate image IDs before reading artifacts", async () => {
  const imageId = "img_01J00000000000000000000000";
  let artifactReads = 0;
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async () => {
        artifactReads += 1;
        return { metadata: artifact(imageId), data: PNG_BASE64 };
      },
    },
    async (client) => {
      const result = await client.callTool({
        name: "render_image_results",
        arguments: { imageIds: [imageId, imageId] },
      });

      assertToolErrorCode(result, "invalid_task");
      assert.equal(artifactReads, 0);
    },
  );
});

test("editor sessions can be opened, inspected, and destroyed", async () => {
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "open_image_editor",
        arguments: { imageId: "img_01J00000000000000000000000" },
      });
      assert.equal(result._meta.ui.resourceUri, EDITOR_WIDGET_URI);
      assert.equal(result.structuredContent.editorSession.imageId, "img_01J00000000000000000000000");
      assert.equal(result.structuredContent.editorSession.status, "active");
      assert.equal(result.structuredContent.artifact.id, "img_01J00000000000000000000000");
      assert.match(result.structuredContent.editorSession.id, /^eds_/);

      const editorSessionId = result.structuredContent.editorSession.id;
      const active = await client.callTool({
        name: "get_image_editor_session",
        arguments: { editorSessionId },
      });
      assert.equal(active.structuredContent.editorSession.status, "active");

      const duplicate = await client.callTool({
        name: "open_image_editor",
        arguments: { imageId: "img_01J00000000000000000000000" },
      });
      const duplicateSessionId = duplicate.structuredContent.editorSession.id;
      assert.notEqual(duplicateSessionId, editorSessionId);

      const destroyed = await client.callTool({
        name: "destroy_image_editor",
        arguments: { editorSessionId },
      });
      assert.equal(destroyed.structuredContent.editorSession.status, "destroyed");

      const duplicateAfterDestroy = await client.callTool({
        name: "get_image_editor_session",
        arguments: { editorSessionId: duplicateSessionId },
      });
      assert.equal(duplicateAfterDestroy.structuredContent.editorSession.status, "destroyed");

      const afterDestroy = await client.callTool({
        name: "get_image_editor_session",
        arguments: { editorSessionId },
      });
      assert.equal(afterDestroy.structuredContent.editorSession.status, "destroyed");

      const lateDraft = await client.callTool({
        name: "save_image_editor_draft",
        arguments: {
          editorSessionId,
          draft: { annotations: [], prompt: "不得在销毁后重新写入" },
        },
      });
      assert.equal(lateDraft.isError, true);
      assertToolErrorCode(lateDraft, "image_canvas_destroyed");

      const artifactAfterDestroy = await client.callTool({
        name: "get_image_artifact",
        arguments: { imageId: "img_01J00000000000000000000000" },
      });
      assert.equal(artifactAfterDestroy.structuredContent.canvasStatus, "destroyed");

      const reopened = await client.callTool({
        name: "open_image_editor",
        arguments: { imageId: "img_01J00000000000000000000000" },
      });
      assert.equal(reopened.isError, true);
      assertToolErrorCode(reopened, "image_canvas_destroyed");
    },
  );
});

test("destroy_image_editor remains idempotent after the session was released", async () => {
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
    },
    async (client) => {
      const opened = await client.callTool({
        name: "open_image_editor",
        arguments: { imageId: "img_01J00000000000000000000000" },
      });
      const editorSessionId = opened.structuredContent.editorSession.id;
      await client.callTool({
        name: "destroy_image_editor",
        arguments: { editorSessionId },
      });
      await client.callTool({
        name: "finalize_image_editor_session",
        arguments: { editorSessionId },
      });

      const repeated = await client.callTool({
        name: "destroy_image_editor",
        arguments: { editorSessionId },
      });

      assert.notEqual(repeated.isError, true);
      assert.equal(repeated.structuredContent.editorSession.id, editorSessionId);
      assert.equal(repeated.structuredContent.editorSession.status, "released");
    },
  );
});

test("missing editor sessions return a stable error outside success structured content", async () => {
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
    },
    async (client) => {
      const result = await client.callTool({
        name: "get_image_editor_session",
        arguments: { editorSessionId: "eds_00000000000000000000000000000000" },
      });

      assert.equal(result.isError, true);
      assertToolErrorCode(result, "editor_session_not_found");
      assert.match(result.content[0].text, /画布会话不存在/);
    },
  );
});

test("open_image_editor rejects an artifact that does not exist", async () => {
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async () => {
        throw new Error("artifact not found");
      },
    },
    async (client) => {
      const result = await client.callTool({
        name: "open_image_editor",
        arguments: { imageId: "img_01J00000000000000000000000" },
      });
      assert.equal(result.isError, true);
      assertToolErrorCode(result, "artifact_not_found");
      assert.match(result.content[0].text, /未找到指定图片产物/);
    },
  );
});

test("filesystem errors return a safe summary without absolute paths", async () => {
  const leakedPath = "F:/private/imagegen/output/image.png";
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async () => {
        throw new Error(`EACCES: ${leakedPath}`);
      },
    },
    async (client) => {
      const result = await client.callTool({
        name: "open_image_editor",
        arguments: { imageId: "img_01J00000000000000000000000" },
      });
      assert.equal(result.isError, true);
      assertToolErrorCode(result, "artifact_not_found");
      assert.equal(result.content[0].text.includes(leakedPath), false);
    },
  );
});

test("product tool errors never expose provider text or local paths", async () => {
  const imageId = "img_01J00000000000000000000000";
  const annotationId = "ann_01J00000000000000000000000";
  const secret = "provider-secret-token";
  const windowsPath = "F:/private/imagegen/output/image.png";
  const posixPath = "/home/alice/private/image.png";
  const unsafeError = () => new Error(`EPERM: ${windowsPath}; ${posixPath}; ${secret}`);
  const cases = [
    {
      name: "list_image_models",
      arguments: {},
      expectedCode: "image_task_failed",
      dependencies: { runTask: async () => { throw unsafeError(); } },
    },
    {
      name: "generate_image",
      arguments: { prompt: "test" },
      expectedCode: "image_task_failed",
      dependencies: { runTask: async () => { throw unsafeError(); } },
    },
    {
      name: "edit_image",
      arguments: { parentImageId: imageId, annotationId, prompt: "test" },
      expectedCode: "annotation_not_found",
      dependencies: {
        runTask: async () => { throw new Error("not used"); },
        readAnnotation: async () => { throw unsafeError(); },
      },
    },
    {
      name: "get_image_artifact",
      arguments: { imageId },
      expectedCode: "image_task_failed",
      dependencies: {},
    },
    {
      name: "read_image_artifact_data",
      arguments: { imageId },
      expectedCode: "artifact_read_failed",
      dependencies: {},
    },
    {
      name: "render_image_results",
      arguments: { imageIds: [imageId] },
      expectedCode: "artifact_read_failed",
      dependencies: {},
    },
    {
      name: "open_image_editor",
      arguments: { imageId },
      expectedCode: "artifact_not_found",
      dependencies: {},
    },
    {
      name: "save_image_annotations",
      arguments: {
        imageId,
        items: [{ id: "note-1", type: "text", x: 0.5, y: 0.5, text: "test" }],
      },
      expectedCode: "annotation_save_failed",
      dependencies: {
        readArtifact: async () => ({ metadata: artifact(imageId), data: PNG_BASE64 }),
        saveAnnotations: async () => { throw unsafeError(); },
      },
    },
  ];

  for (const testCase of cases) {
    await withClient(
      {
        runTask: async () => { throw new Error("not used"); },
        readArtifact: async () => { throw unsafeError(); },
        ...testCase.dependencies,
      },
      async (client) => {
        const result = await client.callTool({ name: testCase.name, arguments: testCase.arguments });
        assert.equal(result.isError, true, testCase.name);
        assertToolErrorCode(result, testCase.expectedCode, testCase.name);
        const serialized = JSON.stringify(result);
        for (const privateValue of [secret, windowsPath, posixPath]) {
          assert.equal(serialized.includes(privateValue), false, `${testCase.name} exposed ${privateValue}`);
        }
      },
    );
  }
});

test("tool errors preserve supported runtime codes with fixed safe summaries", async () => {
  const privateMessage = "provider rejected sk-private at F:/private/config.json";
  await withClient(
    {
      runTask: async (task) => ({
        ok: false,
        error: { code: task.operation === "edit" ? "edit_submission_mismatch" : "unsupported_capability", message: privateMessage },
      }),
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
    },
    async (client) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "test" } });
      assert.equal(result.isError, true);
      assertToolErrorCode(result, "unsupported_capability");
      assert.equal(JSON.stringify(result).includes(privateMessage), false);
      assert.equal(JSON.stringify(result).includes("sk-private"), false);
      const parentImageId = "img_01J00000000000000000000000";
      const prepared = await client.callTool({ name: "prepare_image_edit_submission", arguments: { parentImageId, items: [], sourcePrompt: "test" } });
      const edit = await client.callTool({ name: "edit_image", arguments: { parentImageId, submissionId: prepared.structuredContent.submission.id, prompt: "test" } });
      assertToolErrorCode(edit, "edit_submission_mismatch");
    },
  );

  const configError = new Error("unsafe local configuration detail");
  configError.code = "image_config_missing";
  await withClient(
    {
      runTask: async () => { throw configError; },
      readArtifact: async () => { throw new Error("not used"); },
    },
    async (client) => {
      const result = await client.callTool({ name: "list_image_models", arguments: {} });
      assertToolErrorCode(result, "image_config_missing");
      assert.equal(JSON.stringify(result).includes(configError.message), false);
    },
  );
});

test("finalize_image_editor_session is idempotent", async () => {
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
    },
    async (client) => {
      const opened = await client.callTool({
        name: "open_image_editor",
        arguments: { imageId: "img_01J00000000000000000000000" },
      });
      const editorSessionId = opened.structuredContent.editorSession.id;
      const first = await client.callTool({ name: "finalize_image_editor_session", arguments: { editorSessionId } });
      const second = await client.callTool({ name: "finalize_image_editor_session", arguments: { editorSessionId } });

      assert.equal(first.structuredContent.editorSession.status, "released");
      assert.equal(second.structuredContent.editorSession.status, "released");
      assert.equal(second.structuredContent.editorSession.id, editorSessionId);
    },
  );
});

test("list_image_models returns only safe configured model capabilities", async () => {
  const models = [{
    id: "primary/gpt-image-2",
    provider: "primary",
    model: "gpt-image-2",
    capabilities: { generate: true, edit: true, mask: true },
  }];
  await withClient(
    {
      runTask: async (task) => task.operation === "list_models" ? { ok: true, models } : { ok: false },
      readArtifact: async () => {
        throw new Error("not used");
      },
    },
    async (client) => {
      const result = await client.callTool({ name: "list_image_models", arguments: {} });
      assert.deepEqual(result.structuredContent.models, models);
      assert.equal(JSON.stringify(result).includes("api_key"), false);
      assert.equal(JSON.stringify(result).includes("base_url"), false);
    },
  );
});

test("save_image_annotations stores multiple independent annotations together", async () => {
  const imageId = "img_01J00000000000000000000000";
  const items = [
    { id: "mark-1", type: "arrow", from: { x: 0.8, y: 0.2 }, to: { x: 0.5, y: 0.4 }, text: "Move this lower", color: "#2563eb", strokeWidth: 3 },
    { id: "mark-2", type: "text", x: 0.1, y: 0.2, text: "Use a warmer color", color: "#111827", strokeWidth: 5 },
  ];
  let captured;
  await withClient(
    {
      runTask: async () => {
        throw new Error("not used");
      },
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
      saveAnnotations: async (request) => {
        captured = request;
        return {
          id: "ann_01J00000000000000000000000",
          imageId,
          itemCount: items.length,
          previewMimeType: "image/svg+xml",
          hasMask: false,
          maskMimeType: null,
          maskPolicy: null,
        };
      },
    },
    async (client) => {
      const result = await client.callTool({
        name: "save_image_annotations",
        arguments: { imageId, items },
      });
      assert.deepEqual(captured, { imageId, items });
      assert.equal(result.structuredContent.annotation.id, "ann_01J00000000000000000000000");
      assert.equal(result.structuredContent.annotation.itemCount, 2);
    },
  );
});

test("runtime failure is returned as an MCP error without switching route", async () => {
  let calls = 0;
  await withClient(
    {
      runTask: async () => {
        calls += 1;
        return { ok: false, error: { code: "image_task_failed", message: "provider rejected request" } };
      },
      readArtifact: async () => {
        throw new Error("not used");
      },
    },
    async (client) => {
      const result = await client.callTool({
        name: "generate_image",
        arguments: { prompt: "one attempt" },
      });
      assert.equal(result.isError, true);
      assertToolErrorCode(result, "image_task_failed");
      assert.match(result.content[0].text, /图片任务执行失败/);
      assert.equal(result.content[0].text.includes("provider rejected request"), false);
    },
  );
  assert.equal(calls, 1);
});

test("missing artifact errors do not expose the project path", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-mcp-"));
  try {
    await assert.rejects(
      readImageArtifact("img_01J00000000000000000000000", { projectRoot }),
      (error) => {
        assert.equal(error.message.includes(projectRoot), false);
        return true;
      },
    );
  } finally {
    await rm(projectRoot, { recursive: true });
  }
});

test("editor state failures keep their stable codes across canvas status tools", async () => {
  const invalidState = Object.assign(new Error("invalid editor state"), { code: "editor_state_invalid" });
  const unavailableState = Object.assign(new Error("unavailable editor state"), { code: "editor_state_unavailable" });
  await withClient(
    {
      runTask: async () => { throw new Error("not used"); },
      readArtifact: async (id) => ({ metadata: artifact(id), data: PNG_BASE64 }),
      editorState: {
        async open() { throw invalidState; },
        async getSession() { throw new Error("not used"); },
        async destroy() { throw new Error("not used"); },
        async finalize() { throw new Error("not used"); },
        async getCanvasStatuses() { throw unavailableState; },
      },
    },
    async (client) => {
      const imageId = "img_01J00000000000000000000000";
      const opened = await client.callTool({ name: "open_image_editor", arguments: { imageId } });
      assertToolErrorCode(opened, "editor_state_invalid");

      for (const [name, arguments_] of [
        ["get_image_artifact", { imageId }],
        ["read_image_artifact_data", { imageId }],
        ["render_image_results", { imageIds: [imageId] }],
      ]) {
        const result = await client.callTool({ name, arguments: arguments_ });
        assertToolErrorCode(result, "editor_state_unavailable", name);
      }
    },
  );
});
