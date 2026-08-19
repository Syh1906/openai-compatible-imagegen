import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { createBoundToolClient } from "../../web/bound-tool-client.mjs";
import {
  IMAGE_ID,
  PNG_BASE64,
  PROJECT_BINDING_ID,
  installDomGlobals,
  installHost,
  restoreDomGlobals,
  waitFor,
} from "../support/widget-runtime-host.mjs";

test("bound tool client freezes the first valid project binding for the widget lifecycle", async () => {
  const alternateBindingId = `pbind_${"b".repeat(64)}`;
  const toolCalls = [];
  const modelContexts = [];
  const client = createBoundToolClient({
    async callServerTool(request) {
      toolCalls.push(request);
      return { ok: true };
    },
    updateModelContext(request) {
      modelContexts.push(request);
    },
  });

  assert.equal(client.observeToolInput({ arguments: { projectBindingId: PROJECT_BINDING_ID } }), true);
  assert.equal(client.observeToolInput({ arguments: { projectBindingId: PROJECT_BINDING_ID } }), true);
  assert.equal(client.observeToolInput({ arguments: { projectBindingId: alternateBindingId } }), false);
  assert.equal(client.isBound(), false);
  assert.equal(client.observeToolInput({ arguments: { projectBindingId: PROJECT_BINDING_ID } }), false);

  const callError = await client.callServerTool({ name: "get_image_artifact", arguments: { imageId: IMAGE_ID } })
    .then(() => null, (error) => error);
  assert.equal(callError?.name, "ProjectBindingError");
  assert.equal(callError?.code, "project_binding_conflict");
  assert.equal(callError?.message, "Project binding conflicts with the binding already established for this widget");
  assert.throws(
    () => client.updateModelContext({ structuredContent: { imageId: IMAGE_ID } }),
    (error) => error?.name === callError.name
      && error?.code === callError.code
      && error?.message === callError.message,
  );
  assert.deepEqual(toolCalls, []);
  assert.deepEqual(modelContexts, []);
});

test("bound tool client preserves its frozen binding when later tool input is invalid", async () => {
  const toolCalls = [];
  const client = createBoundToolClient({
    async callServerTool(request) {
      toolCalls.push(request);
      return { ok: true };
    },
  });

  assert.equal(client.observeToolInput({ arguments: { projectBindingId: PROJECT_BINDING_ID } }), true);
  assert.equal(client.observeToolInput({ arguments: { projectBindingId: "pbind_invalid" } }), false);
  await assert.rejects(
    client.callServerTool({ name: "get_image_artifact", arguments: { imageId: IMAGE_ID } }),
    { name: "ProjectBindingError", code: "project_binding_invalid", message: "Project binding in the tool input is invalid" },
  );
  assert.equal(client.observeToolInput({ arguments: { projectBindingId: PROJECT_BINDING_ID } }), true);
  await client.callServerTool({ name: "get_image_artifact", arguments: { imageId: IMAGE_ID } });
  assert.equal(toolCalls[0].arguments.projectBindingId, PROJECT_BINDING_ID);
});

test("widget forwards the tool-input project binding to every App-only tool call", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialArtifacts: [
      { id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] },
    ],
    initialResultToolInputArguments: { imageIds: [IMAGE_ID], projectBindingId: PROJECT_BINDING_ID },
  });

  try {
    await import(`../../web/editor-runtime.mjs?explicit-project-binding=${Date.now()}`);
    await waitFor(() => host.toolCalls.some(({ name }) => name === "read_image_artifact_data"));
    assert.equal(host.toolCalls.length > 0, true);
    assert.equal(
      host.toolCalls.every(({ arguments: toolArguments }) => toolArguments.projectBindingId === PROJECT_BINDING_ID),
      true,
    );
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("widget rejects missing or invalid project bindings before App-only tool calls", async (t) => {
  for (const [label, projectBindingId] of [["missing", undefined], ["invalid", "pbind_invalid"]]) {
    await t.test(label, async () => {
      const dom = new JSDOM(
        '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
        { pretendToBeVisual: true, url: "https://widget.local/" },
      );
      const previous = installDomGlobals(dom.window);
      const host = installHost(dom.window, {
        toolName: "render_image_results",
        initialArtifacts: [
          { id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] },
        ],
        initialResultToolInputArguments: {
          imageIds: [IMAGE_ID],
          ...(projectBindingId === undefined ? {} : { projectBindingId }),
        },
      });

      try {
        await import(`../../web/editor-runtime.mjs?rejected-project-binding=${label}-${Date.now()}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(host.toolCalls, []);
      } finally {
        host.dispose();
        restoreDomGlobals(previous);
        dom.window.close();
      }
    });
  }
});

test("widget reports the initial notification and tools call response as safe shapes", async () => {
  const releaseFingerprint = "0123456789abcdefabcd";
  const dom = new JSDOM(
    `<!doctype html><html><head><meta name="openai-compatible-imagegen-release" content="${releaseFingerprint}"></head><body><main><p>正在加载图片...</p></main></body></html>`,
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialArtifacts: [
      { id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] },
    ],
    initialResultIncludesImages: true,
  });

  try {
    await import(`../../web/editor-runtime.mjs?host-observation=${Date.now()}`);
    await waitFor(() => host.toolCalls.some(({ name }) => name === "report_imagegen_host_observation"));
    const report = host.toolCalls.find(({ name }) => name === "report_imagegen_host_observation");
    assert.equal(report.arguments.releaseFingerprint, releaseFingerprint);
    assert.deepEqual(
      report.arguments.observations.map((observation) => observation.source),
      ["ui/notifications/tool-result", "tools/call"],
    );
    const serialized = JSON.stringify(report.arguments.observations);
    assert.equal(serialized.includes(IMAGE_ID), false);
    assert.equal(serialized.includes(PNG_BASE64), false);
    await waitFor(() => document.querySelector("[data-image]")?.getAttribute("src") === `data:image/png;base64,${PNG_BASE64}`);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("widget does not synthesize a tools call envelope when the host rejects it", async () => {
  const releaseFingerprint = "0123456789abcdefabcd";
  const dom = new JSDOM(
    `<!doctype html><html><head><meta name="openai-compatible-imagegen-release" content="${releaseFingerprint}"></head><body><main><p>正在加载图片...</p></main></body></html>`,
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialArtifacts: [
      { id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] },
    ],
    deferArtifactDataImageIds: [IMAGE_ID],
  });

  try {
    await import(`../../web/editor-runtime.mjs?host-observation-rejected=${Date.now()}`);
    await waitFor(() => host.toolCalls.some(({ name }) => name === "read_image_artifact_data"));
    host.rejectArtifactData(IMAGE_ID);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(host.toolCalls.some(({ name }) => name === "report_imagegen_host_observation"), false);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});
