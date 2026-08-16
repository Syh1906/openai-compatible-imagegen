import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { createBoundToolClient } from "../web/bound-tool-client.mjs";
import {
  CODEX_COMPOSER_HOST_CAPABILITIES,
  EDITOR_SESSION_ID,
  FULL_MESSAGE_HOST_CAPABILITIES,
  IMAGE_ID,
  PNG_BASE64,
  PROJECT_BINDING_ID,
  installDomGlobals,
  installHost,
  pointerEvent,
  restoreDomGlobals,
  sendToApp,
  waitFor,
} from "./support/widget-runtime-host.mjs";

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
    await import(`../web/editor-runtime.mjs?explicit-project-binding=${Date.now()}`);
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
        await import(`../web/editor-runtime.mjs?rejected-project-binding=${label}-${Date.now()}`);
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
    await import(`../web/editor-runtime.mjs?host-observation=${Date.now()}`);
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
    await import(`../web/editor-runtime.mjs?host-observation-rejected=${Date.now()}`);
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






test("the render result opens the selected candidate after server-backed artifact reads", async () => {
  const secondId = "img_01J00000000000000000000001";
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialArtifacts: [
      { id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] },
      { id: secondId, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] },
    ],
  });

  try {
    await import(`../web/editor-runtime.mjs?multi-result=${Date.now()}`);
    await waitFor(() => {
      const buttons = [...document.querySelectorAll("[data-action=open-editor]")];
      return buttons.length === 2 && buttons.every((button) => !button.disabled);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      host.toolCalls.filter(({ name }) => name === "read_image_artifact_data").map(({ arguments: args }) => args.imageId),
      [IMAGE_ID, secondId],
    );
    assert.deepEqual(host.toolCalls.filter(({ name }) => name === "get_image_artifact"), []);
    document.querySelector(`[data-result-image-id="${secondId}"] [data-action=open-editor]`).click();
    await waitFor(() => host.toolCalls.some(({ name, arguments: args }) => name === "open_image_editor" && args.imageId === secondId));
    await waitFor(() => document.querySelector(".editor-app") !== null);
    assert.equal(document.querySelector(".editor-app [data-image-id]").textContent, secondId);
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "只修改第二个候选";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    document.querySelector("[data-action=submit]").click();
    await waitFor(() => host.messages.length === 1);
    await waitFor(() => document.querySelectorAll("[data-action=open-editor]").length === 2);
    assert.equal(host.modelContexts[0].structuredContent.projectBindingId, PROJECT_BINDING_ID);
    assert.equal(host.modelContexts[0].structuredContent.imageId, secondId);
    assert.match(host.messages[0].content[0].text, new RegExp(secondId));
    assert.deepEqual(host.toolCalls.filter(({ name }) => name === "prepare_image_edit_submission").map(({ arguments: args }) => [args.parentImageId, args.items.length]), [[secondId, 0]]);
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-results") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("result widget loads each image once for either host notification order", async (t) => {
  const secondId = "img_01J00000000000000000000001";
  const initialArtifacts = [
    { id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] },
    { id: secondId, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] },
  ];
  for (const notificationOrder of ["input-first", "result-first"]) {
    await t.test(notificationOrder, async () => {
      const dom = new JSDOM(
        '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
        { pretendToBeVisual: true, url: "https://widget.local/" },
      );
      const previous = installDomGlobals(dom.window);
      const host = installHost(dom.window, {
        toolName: "render_image_results",
        initialArtifacts,
        initialResultIncludesImages: false,
        initialResultIncludesStructuredContent: false,
        initialResultNotificationOrder: notificationOrder,
        initialResultText: "x".repeat(1_048_601),
      });

      try {
        await import(`../web/editor-runtime.mjs?tool-backed-result-images=${notificationOrder}-${Date.now()}`);
        const imageUrl = `data:image/png;base64,${PNG_BASE64}`;
        await waitFor(() => document.querySelectorAll("[data-image]").length === 2);
        await waitFor(() => [...document.querySelectorAll("[data-image]")]
          .every((image) => image.getAttribute("src") === imageUrl));
        assert.deepEqual(
          [...document.querySelectorAll("[data-result-image-id]")].map((item) => item.dataset.resultImageId),
          [IMAGE_ID, secondId],
        );
        const dataReadIds = () => host.toolCalls
          .filter(({ name }) => name === "read_image_artifact_data")
          .map(({ arguments: args }) => args.imageId);
        assert.deepEqual(dataReadIds(), [IMAGE_ID, secondId]);
        host.notifyResultArtifacts(initialArtifacts);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(dataReadIds(), [IMAGE_ID, secondId]);
        assert.deepEqual(host.resourceReads, []);
        assert.deepEqual(host.toolCalls.filter(({ name }) => name === "get_image_artifact"), []);
        assert.equal([...document.querySelectorAll("[data-action=open-editor]")].every((button) => !button.disabled), true);
      } finally {
        host.dispose();
        restoreDomGlobals(previous);
        dom.window.close();
      }
    });
  }
});

test("one failed candidate does not block a successful candidate", async () => {
  const failedId = "img_01J00000000000000000000001";
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialArtifacts: [
      { id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1 },
      { id: failedId, mimeType: "image/png", width: 1, height: 1 },
    ],
    failArtifactDataImageId: failedId,
  });

  try {
    await import(`../web/editor-runtime.mjs?partial-artifact-load=${Date.now()}`);
    await waitFor(() => document.querySelector(`[data-result-image-id="${IMAGE_ID}"] [data-image]`) !== null);
    await waitFor(() => document.querySelector(`[data-result-image-id="${failedId}"] [data-inline-status]`)?.textContent === "图片读取失败 · IMG-SERVER");
    assert.equal(document.querySelector(`[data-result-image-id="${IMAGE_ID}"] [data-action=open-editor]`)?.disabled, false);
    assert.equal(document.querySelector(`[data-result-image-id="${failedId}"] [data-action=open-editor]`)?.disabled, true);
    assert.equal(document.querySelectorAll(".inline-loading").length, 0);
    assert.equal(document.querySelectorAll(".inline-error").length, 1);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("all failed candidates finish with per-card errors", async () => {
  const failedId = "img_01J00000000000000000000001";
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialArtifacts: [
      { id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1 },
      { id: failedId, mimeType: "image/png", width: 1, height: 1 },
    ],
    failArtifactDataImageIds: [IMAGE_ID, failedId],
  });

  try {
    await import(`../web/editor-runtime.mjs?all-artifact-loads-fail=${Date.now()}`);
    await waitFor(() => [...document.querySelectorAll("[data-inline-status]")]
      .every((element) => element.textContent === "图片读取失败 · IMG-SERVER"));
    assert.equal(document.querySelectorAll(".inline-loading").length, 0);
    assert.equal([...document.querySelectorAll("[data-action=open-editor]")].every((button) => button.disabled), true);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a server error invalidates an artifact read already in flight", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialArtifacts: [{ id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1 }],
    deferArtifactDataImageIds: [IMAGE_ID],
  });

  try {
    await import(`../web/editor-runtime.mjs?server-error-after-start=${Date.now()}`);
    await waitFor(() => host.pendingArtifactDataRequestCount === 1);
    sendToApp(dom.window, {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        isError: true,
        content: [{ type: "text", text: "artifact_read_failed: 读取图片产物失败。" }],
      },
    });
    await waitFor(() => document.body.textContent.includes("IMG-SERVER"));
    host.resolveArtifactData(IMAGE_ID);
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(document.querySelector("[data-inline-status]")?.textContent, "图片读取失败 · IMG-SERVER");
    assert.equal(document.querySelector("[data-image]:not([hidden])"), null);
    assert.equal(host.toolCalls.filter(({ name }) => name === "read_image_artifact_data").length, 1);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("result widget distinguishes schema, projection, server, and payload failures", async (t) => {
  const cases = [
    { name: "missing result input field", options: { initialResultToolInputArguments: {} }, code: "IMG-SCHEMA", noReads: true },
    { name: "empty result input", options: { initialResultToolInputArguments: { imageIds: [] } }, code: "IMG-SCHEMA", noReads: true },
    { name: "malformed result input", options: { initialResultToolInputArguments: { imageIds: ["not-an-image-id"] } }, code: "IMG-SCHEMA", noReads: true },
    { name: "initial server error", options: { initialResultIsError: true }, code: "IMG-SERVER", noReads: true },
    {
      name: "projected server error without isError",
      options: { initialResultText: "artifact_read_failed: 读取图片产物失败。", initialResultIncludesImages: false, initialResultIncludesStructuredContent: false },
      code: "IMG-SERVER",
      noReads: true,
    },
    { name: "projected binding error without isError", options: { initialResultText: "project_binding_required: 当前 MCP 进程尚未绑定图片项目。", initialResultIncludesImages: false, initialResultIncludesStructuredContent: false }, code: "IMG-SERVER", noReads: true },
    { name: "artifact data server error", options: { artifactDataIsError: true }, code: "IMG-SERVER" },
    { name: "artifact data payload invalid", options: { artifactDataPayloadInvalid: true }, code: "IMG-PAYLOAD" },
  ];

  for (const [index, testCase] of cases.entries()) {
    await t.test(testCase.name, async () => {
      const dom = new JSDOM(
        '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
        { pretendToBeVisual: true, url: "https://widget.local/" },
      );
      const previous = installDomGlobals(dom.window);
      const host = installHost(dom.window, {
        toolName: "render_image_results",
        initialArtifacts: [{ id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1 }],
        ...testCase.options,
      });

      try {
        await import(`../web/editor-runtime.mjs?artifact-load-error=${index}-${Date.now()}`);
        await waitFor(() => document.body.textContent.includes(testCase.code));
        const status = document.querySelector("[data-inline-status]");
        assert.equal(status?.textContent, `图片读取失败 · ${testCase.code}`);
        assert.equal(status?.dataset.statusTone, "error");
        await new Promise((resolve) => setTimeout(resolve, 20));
        const metadataReads = host.toolCalls.filter(({ name }) => name === "get_image_artifact").length;
        const dataReads = host.toolCalls.filter(({ name }) => name === "read_image_artifact_data").length;
        assert.equal(metadataReads, 0);
        if (testCase.noReads) {
          assert.equal(dataReads, 0);
        } else {
          assert.equal(dataReads, 1);
        }
      } finally {
        host.dispose();
        restoreDomGlobals(previous);
        dom.window.close();
      }
    });
  }
});

test("result widget ignores legacy widget-only bytes and uses the app-only image tool", async () => {
  const secondId = "img_01J00000000000000000000001";
  const initialArtifacts = [
    { id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] },
    { id: secondId, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] },
  ];
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialArtifacts,
    initialResultIncludesImages: false,
    initialResultIncludesWidgetImages: true,
  });

  try {
    await import(`../web/editor-runtime.mjs?widget-only-images=${Date.now()}`);
    const imageUrl = `data:image/png;base64,${PNG_BASE64}`;
    await waitFor(() => document.querySelectorAll("[data-image]").length === 2);
    await waitFor(() => [...document.querySelectorAll("[data-image]")]
      .every((image) => image.getAttribute("src") === imageUrl));
    assert.equal(
      [...document.querySelectorAll("[data-action=open-editor]")].every((button) => !button.disabled),
      true,
    );
    assert.deepEqual(
      host.toolCalls.filter(({ name }) => name === "read_image_artifact_data").map(({ arguments: args }) => args.imageId),
      [IMAGE_ID, secondId],
    );
    assert.deepEqual(host.resourceReads, []);
    assert.deepEqual(host.toolCalls.filter(({ name }) => name === "get_image_artifact"), []);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("container-only host context updates do not rebuild the inline result DOM", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialArtifacts: [{ id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] }],
  });

  try {
    await import(`../web/editor-runtime.mjs?stable-inline-layout=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    assert.equal(document.body.dataset.view, "result");
    const originalResults = document.querySelector(".inline-results");
    host.notifyHostContextChanged({ containerDimensions: { width: 880, height: 420 } });
    host.notifyHostContextChanged({ containerDimensions: { width: 879, height: 421 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(document.querySelector(".inline-results"), originalResults);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a destroyed canvas stays unavailable when the result widget reloads its artifact", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialArtifacts: [{ id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [], canvasStatus: "destroyed" }],
  });

  try {
    await import(`../web/editor-runtime.mjs?destroyed-artifact=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    assert.equal(document.querySelector(".inline-result")?.dataset.canvasStatus, "destroyed");
    assert.equal(document.querySelector("[data-action=open-editor]"), null);
    assert.match(document.querySelector(".inline-result")?.textContent || "", /画布已销毁/);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a failed multi-image canvas open keeps the error on the selected candidate", async () => {
  const secondId = "img_01J00000000000000000000001";
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    failOpenImageId: secondId,
    initialArtifacts: [
      { id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] },
      { id: secondId, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] },
    ],
  });

  try {
    await import(`../web/editor-runtime.mjs?multi-open-error=${Date.now()}`);
    await waitFor(() => {
      const buttons = [...document.querySelectorAll("[data-action=open-editor]")];
      return buttons.length === 2 && buttons.every((button) => !button.disabled);
    });
    document.querySelector(`[data-result-image-id="${secondId}"] [data-action=open-editor]`).click();
    await waitFor(() => host.toolCalls.some(({ name, arguments: args }) => name === "open_image_editor" && args.imageId === secondId));
    await waitFor(() => document.querySelector(`[data-result-image-id="${secondId}"] [data-inline-status]`)?.dataset.statusTone === "error");
    assert.equal(document.querySelector(`[data-result-image-id="${secondId}"] [data-inline-status]`).textContent, "Codex 未能打开画布");
    assert.equal(document.querySelector(`[data-result-image-id="${IMAGE_ID}"] [data-inline-status]`).textContent, "");
    assert.notEqual(document.querySelector(`[data-result-image-id="${secondId}"] [data-action=open-editor]`), null);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("result widget expands into the editor and returns to a reusable conversation entry", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialArtifacts: [{ id: IMAGE_ID, mimeType: "image/png", width: 1, height: 1, operation: "generate", parentIds: [], childIds: [] }],
  });

  try {
    await import(`../web/editor-runtime.mjs?startup=${Date.now()}`);

    assert.equal(document.querySelector("main > p"), null);
    const imageUrl = `data:image/png;base64,${PNG_BASE64}`;
    await waitFor(() => document.querySelector("[data-image]")?.getAttribute("src") === imageUrl);
    assert.equal(document.querySelector("[data-image-id]")?.textContent, IMAGE_ID);
    assert.equal(document.querySelector("[data-action=open-editor]")?.textContent.trim(), "打开画布");
    document.querySelector("[data-action=open-editor]").click();
    assert.equal(document.querySelector("[data-inline-status]")?.dataset.statusTone, "progress");
    assert.equal(document.querySelector("[data-action=open-editor]")?.textContent.trim(), "正在打开...");
    await waitFor(() => host.toolCalls.some(({ name }) => name === "open_image_editor"));
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => host.displayModeRequests.length === 1);
    assert.equal(document.querySelector(".editor-app")?.getAttribute("aria-label"), "聚焦图片编辑器");
    assert.match(document.querySelector("[data-close-guidance]")?.textContent || "", /返回会话可保留画布/);
    assert.equal(document.querySelector("[data-close-guidance]")?.getAttribute("aria-describedby"), "close-guidance-description");
    assert.match(document.querySelector("#close-guidance-description")?.textContent || "", /直接关闭 Codex 画布可能移除入口/);
    assert.equal(document.querySelector("[data-action=back]")?.getAttribute("aria-label"), "返回会话");
    assert.deepEqual(host.displayModeRequests, ["fullscreen"]);
    assert.deepEqual(host.messages, []);
    assert.deepEqual(
      host.toolCalls.filter(({ name }) => name !== "list_image_models").slice(0, 2).map(({ name, arguments: toolArguments }) => ({ name, arguments: toolArguments })),
      [
        { name: "read_image_artifact_data", arguments: { imageId: IMAGE_ID, projectBindingId: PROJECT_BINDING_ID } },
        { name: "open_image_editor", arguments: { imageId: IMAGE_ID, projectBindingId: PROJECT_BINDING_ID } },
      ],
    );

    document.querySelector("[data-action=back]").click();
    await waitFor(() => host.displayModeRequests.length === 2);
    await waitFor(() => document.querySelector(".inline-result") !== null);
    assert.deepEqual(host.displayModeRequests, ["fullscreen", "inline"]);
    assert.equal(document.querySelector(".editor-app"), null);
    assert.notEqual(document.querySelector("[data-action=open-editor]"), null);
    assert.equal(host.teardownRequests, 0);

    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => host.displayModeRequests.length === 3);
    await waitFor(() => document.querySelector(".editor-app") !== null);
    assert.deepEqual(host.displayModeRequests, ["fullscreen", "inline", "fullscreen"]);
    assert.equal(host.toolCalls.filter(({ name }) => name === "open_image_editor").length, 1);
    document.querySelector("[data-action=back]").click();
    await waitFor(() => host.displayModeRequests.length === 4);
    await waitFor(() => document.querySelector(".inline-result") !== null);
  } finally {
    await waitFor(() => document.querySelector(".editor-app") !== null).catch(() => {});
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("result image opens an independent fullscreen preview with local zoom and returns to the same card", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialArtifacts: [{ id: IMAGE_ID, mimeType: "image/png", width: 1024, height: 768, operation: "generate", parentIds: [], childIds: [] }],
  });

  try {
    await import(`../web/editor-runtime.mjs?result-preview=${Date.now()}`);
    await waitFor(() => document.querySelector(`[data-result-image-id="${IMAGE_ID}"] [data-image]`) !== null);

    const trigger = document.querySelector(`[data-result-image-id="${IMAGE_ID}"] [data-action=preview-image]`);
    assert.ok(trigger, "结果图片必须提供独立预览入口");
    assert.equal(trigger.tagName, "BUTTON");
    trigger.click();

    await waitFor(() => document.querySelector("[data-result-preview]")?.hidden === false);
    await waitFor(() => host.displayModeRequests.length === 1);
    assert.deepEqual(host.displayModeRequests, ["fullscreen"]);
    assert.equal(host.toolCalls.some(({ name }) => name === "open_image_editor"), false);
    const preview = document.querySelector("[data-result-preview]");
    assert.equal(preview.dataset.imageId, IMAGE_ID);
    assert.equal(preview.dataset.previewScale, "1");

    document.querySelector("[data-preview-action=zoom-in]").click();
    assert.equal(preview.dataset.previewScale, "1.25");
    const wheel = new dom.window.WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true });
    document.querySelector("[data-preview-viewport]").dispatchEvent(wheel);
    assert.equal(preview.dataset.previewScale, "1.5");
    document.querySelector("[data-preview-action=reset]").click();
    assert.equal(preview.dataset.previewScale, "1");
    assert.equal(host.toolCalls.some(({ name }) => name === "open_image_editor"), false);

    document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => host.displayModeRequests.length === 2);
    await waitFor(() => document.querySelector("[data-result-preview]") === null);
    assert.deepEqual(host.displayModeRequests, ["fullscreen", "inline"]);
    const returnedTrigger = document.querySelector(`[data-result-image-id="${IMAGE_ID}"] [data-action=preview-image]`);
    await waitFor(() => document.activeElement === returnedTrigger);
    assert.equal(document.querySelector(`[data-result-image-id="${IMAGE_ID}"] [data-action=open-editor]`)?.textContent.trim(), "打开画布");
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("result card menu and fullscreen toolbar reveal the matching artifact through one app-only tool", async () => {
  const secondImageId = "img_01J00000000000000000000001";
  const artifacts = [IMAGE_ID, secondImageId].map((id) => ({
    id,
    mimeType: "image/png",
    width: 1024,
    height: 768,
    operation: "generate",
    parentIds: [],
    childIds: [],
  }));
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "render_image_results", initialArtifacts: artifacts });

  try {
    await import(`../web/editor-runtime.mjs?result-reveal=${Date.now()}`);
    await waitFor(() => document.querySelector(`[data-result-image-id="${secondImageId}"] [data-image]`) !== null);
    const card = document.querySelector(`[data-result-image-id="${secondImageId}"]`);
    const previewTrigger = card.querySelector("[data-action=preview-image]");
    const menuEvent = new dom.window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: 320,
      clientY: 180,
    });
    card.dispatchEvent(menuEvent);

    assert.equal(menuEvent.defaultPrevented, true);
    assert.equal(host.toolCalls.some(({ name }) => name === "reveal_image_artifact"), false);
    const menu = document.querySelector("[data-result-context-menu]");
    assert.equal(menu?.getAttribute("role"), "menu");
    const menuItem = menu.querySelector("[data-action=reveal-result-image]");
    assert.equal(menuItem.getAttribute("role"), "menuitem");
    assert.match(menuItem.textContent, /在文件夹中显示/);
    menuItem.click();

    await waitFor(() => host.toolCalls.filter(({ name }) => name === "reveal_image_artifact").length === 1);
    await waitFor(() => card.querySelector("[data-inline-status]")?.textContent === "");
    assert.deepEqual(
      host.toolCalls.find(({ name }) => name === "reveal_image_artifact").arguments,
      { imageId: secondImageId, projectBindingId: PROJECT_BINDING_ID },
    );
    assert.equal(document.querySelector("[data-result-context-menu]"), null);
    assert.equal(document.activeElement, previewTrigger);

    card.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    assert.notEqual(document.querySelector("[data-result-context-menu]"), null);
    document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(document.querySelector("[data-result-context-menu]"), null);
    assert.equal(host.toolCalls.filter(({ name }) => name === "reveal_image_artifact").length, 1);

    card.querySelector("[data-action=preview-image]").click();
    await waitFor(() => document.querySelector("[data-result-preview]")?.dataset.imageId === secondImageId);
    const revealButton = document.querySelector("[data-preview-action=reveal]");
    assert.equal(revealButton?.getAttribute("aria-label"), "在文件夹中显示");
    revealButton.click();
    await waitFor(() => host.toolCalls.filter(({ name }) => name === "reveal_image_artifact").length === 2);
    await waitFor(() => revealButton.disabled === false);
    assert.deepEqual(
      host.toolCalls.filter(({ name }) => name === "reveal_image_artifact")[1].arguments,
      { imageId: secondImageId, projectBindingId: PROJECT_BINDING_ID },
    );
    assert.equal(document.querySelector("[data-preview-status]")?.textContent, "");

    document.querySelector("[data-preview-action=close]").click();
    await waitFor(() => document.querySelector("[data-result-preview]") === null);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("result preview clamps zoom and closes only through explicit preview affordances", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialArtifacts: [{ id: IMAGE_ID, mimeType: "image/png", width: 1024, height: 768, operation: "generate", parentIds: [], childIds: [] }],
  });

  try {
    await import(`../web/editor-runtime.mjs?result-preview-bounds=${Date.now()}`);
    await waitFor(() => document.querySelector(`[data-result-image-id="${IMAGE_ID}"] [data-action=preview-image]`) !== null);
    document.querySelector("[data-action=preview-image]").click();
    await waitFor(() => document.querySelector("[data-result-preview]") !== null);

    const preview = document.querySelector("[data-result-preview]");
    const zoomIn = preview.querySelector("[data-preview-action=zoom-in]");
    const zoomOut = preview.querySelector("[data-preview-action=zoom-out]");
    for (let index = 0; index < 20; index += 1) zoomIn.click();
    assert.equal(preview.dataset.previewScale, "4");
    assert.equal(zoomIn.disabled, true);
    for (let index = 0; index < 20; index += 1) zoomOut.click();
    assert.equal(preview.dataset.previewScale, "0.5");
    assert.equal(zoomOut.disabled, true);

    preview.querySelector("[data-preview-image]").click();
    assert.notEqual(document.querySelector("[data-result-preview]"), null, "单击图片本身不能关闭预览");
    preview.querySelector("[data-preview-stage]").click();
    await waitFor(() => document.querySelector("[data-result-preview]") === null);
    assert.deepEqual(host.displayModeRequests, ["fullscreen", "inline"]);

    document.querySelector("[data-action=preview-image]").click();
    await waitFor(() => host.displayModeRequests.length === 3);
    document.querySelector("[data-preview-action=close]").click();
    await waitFor(() => document.querySelector("[data-result-preview]") === null);
    assert.deepEqual(host.displayModeRequests, ["fullscreen", "inline", "fullscreen", "inline"]);
    assert.equal(host.toolCalls.some(({ name }) => name === "open_image_editor"), false);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("result preview reports a fullscreen refusal without creating an editor session", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    rejectDisplayMode: "fullscreen",
    initialArtifacts: [{ id: IMAGE_ID, mimeType: "image/png", width: 1024, height: 768, operation: "generate", parentIds: [], childIds: [] }],
  });

  try {
    await import(`../web/editor-runtime.mjs?result-preview-refusal=${Date.now()}`);
    await waitFor(() => document.querySelector(`[data-result-image-id="${IMAGE_ID}"] [data-action=preview-image]`) !== null);
    const trigger = document.querySelector("[data-action=preview-image]");
    trigger.click();

    await waitFor(() => document.querySelector("[data-inline-status]")?.textContent === "Codex 未能打开图片预览");
    assert.equal(document.querySelector("[data-result-preview]"), null);
    assert.deepEqual(host.displayModeRequests, ["fullscreen"]);
    assert.equal(host.toolCalls.some(({ name }) => name === "open_image_editor"), false);
    await waitFor(() => document.activeElement === document.querySelector("[data-action=preview-image]"));
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("an edit result binds the child image and keeps its editor action enabled", async () => {
  const childId = "img_01J00000000000000000000001";
  const child = {
    id: childId,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: "edit",
    parentIds: [IMAGE_ID],
    childIds: [],
  };
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "render_image_results", initialArtifacts: [child] });

  try {
    await import(`../web/editor-runtime.mjs?edit-result=${Date.now()}`);
    await waitFor(() =>
      document.querySelector("[data-image-id]")?.textContent === childId
      && document.querySelector("[data-image]")?.hidden === false
      && document.querySelector("[data-action=open-editor]")?.disabled === false);
    assert.equal(document.querySelector("[data-image]")?.hidden, false);
    assert.equal(document.querySelector("[data-action=open-editor]")?.disabled, false);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("destroying the editor session returns to the conversation entry", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?editor=${Date.now()}`);

    await waitFor(() => document.querySelector(".editor-app") !== null);
    assert.equal(document.querySelector(".editor-app")?.getAttribute("aria-label"), "聚焦图片编辑器");
    assert.equal(document.querySelector("[data-action=destroy]")?.textContent.trim(), "销毁画布");
    await waitFor(() => host.displayModeRequests.length === 1);
    assert.deepEqual(host.displayModeRequests, ["fullscreen"]);
    await waitFor(() => document.querySelector("[data-image-id]")?.textContent === IMAGE_ID);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    await waitFor(() => host.toolCalls.some(({ name }) => name === "get_image_editor_session"));
    assert.equal(
      host.toolCalls.some(({ name, arguments: toolArguments }) =>
        name === "get_image_editor_session" && toolArguments.editorSessionId === EDITOR_SESSION_ID),
      true,
    );

    document.querySelector("[data-action=destroy]").click();
    assert.equal(document.querySelector("[data-destroy-confirm]").hidden, false); assert.equal(host.toolCalls.some(({ name }) => name === "destroy_image_editor"), false);
    document.querySelector("[data-action=cancel-destroy]").click(); assert.equal(document.querySelector("[data-destroy-confirm]").hidden, true);
    document.querySelector("[data-action=destroy]").click(); document.querySelector("[data-action=confirm-destroy]").click();
    await waitFor(() => host.toolCalls.some(({ name }) => name === "destroy_image_editor"));
    await waitFor(() => document.querySelector(".inline-result") !== null);
    assert.equal(host.teardownRequests, 0);
    assert.deepEqual(host.displayModeRequests, ["fullscreen", "inline"]);
    assert.equal(document.querySelector(".inline-result")?.dataset.canvasStatus, "destroyed");
    assert.equal(document.querySelector("[data-action=open-editor]"), null);
    assert.match(document.querySelector(".inline-result")?.textContent || "", /画布已销毁/);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a brush annotation can be undone and redone", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?history=${Date.now()}`);

    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => document.querySelector("[data-image-id]")?.textContent === IMAGE_ID);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    document.querySelector("[data-tool=pen]").click();
    assert.equal(document.querySelector("[data-tool=pen]")?.getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector("[data-tool=select]")?.getAttribute("aria-pressed"), "false");

    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointermove", { clientX: 200, clientY: 200, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 1 }));

    assert.equal(document.querySelector("[data-summary]")?.textContent, "已标注 1 处");
    document.querySelector("[data-action=undo]").click();
    assert.equal(document.querySelector("[data-summary]")?.textContent, "已标注 0 处");
    document.querySelector("[data-action=redo]").click();
    assert.equal(document.querySelector("[data-summary]")?.textContent, "已标注 1 处");
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("an accidental click does not create an invisible drawing annotation", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?empty-gesture=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=pen]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 100, clientY: 100, pointerId: 1 }));

    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
    assert.equal(document.querySelector("[data-action=submit]").disabled, true);
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("an acknowledged composer draft can atomically update the task input after editing", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    hostCapabilities: CODEX_COMPOSER_HOST_CAPABILITIES,
  });

  try {
    await import(`../web/editor-runtime.mjs?acknowledged-reentry=${Date.now()}`);
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);

    const initialPrompt = document.querySelector("[data-prompt]");
    initialPrompt.value = "先提交这一版修改";
    initialPrompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    document.querySelector("[data-action=submit]").click();
    document.querySelector("[data-action=submit]").click();
    await waitFor(() => host.modelContexts.length === 1);
    await waitFor(() => document.querySelector(".inline-result") !== null);
    assert.equal(host.modelContexts.length, 1);
    assert.equal(host.toolCalls.filter(({ name }) => name === "edit_image").length, 0);

    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => document.querySelector(".editor-app") !== null);
    const updatedPrompt = document.querySelector("[data-prompt]");
    assert.equal(updatedPrompt.value, "先提交这一版修改");
    updatedPrompt.value = "返回后继续修改这一版";
    updatedPrompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    document.querySelector("[data-action=back]").click();
    await waitFor(() => document.querySelector(".inline-result") !== null);
    assert.equal(document.querySelector("[data-draft-state]")?.textContent, "有更新");
    assert.equal(document.querySelector("[data-action=open-editor]")?.textContent.trim(), "继续编辑");
    assert.equal(host.modelContexts.length, 1);
    assert.equal(host.toolCalls.filter(({ name }) => name === "edit_image").length, 0);

    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => document.querySelector(".editor-app") !== null);
    assert.equal(document.querySelector("[data-prompt]")?.value, "返回后继续修改这一版");
    assert.equal(host.modelContexts.length, 1);
    assert.equal(host.toolCalls.filter(({ name }) => name === "edit_image").length, 0);

    const update = document.querySelector("[data-action=submit]");
    assert.equal(update.disabled, false);
    assert.equal(update.textContent, "更新任务输入框");
    update.click();
    await waitFor(() => host.modelContexts.length === 2);
    await waitFor(() => document.querySelector(".inline-result") !== null);
    assert.match(host.modelContexts[1].content[0].text, /返回后继续修改这一版/);
    assert.deepEqual(host.modelContexts[1].content.map((item) => item.type), ["text", "image"]);
    assert.equal(host.modelContexts[1].structuredContent.prompt, "返回后继续修改这一版");
    assert.notEqual(
      host.modelContexts[1].structuredContent.submissionId,
      host.modelContexts[0].structuredContent.submissionId,
    );
    assert.equal(host.toolCalls.filter(({ name }) => name === "prepare_image_edit_submission").length, 2);
    assert.equal(document.querySelector("[data-draft-state]")?.textContent, "待发送");
    assert.equal(document.querySelector("[data-inline-status]")?.textContent, "任务输入框已更新，请确认后发送");
    assert.equal(host.toolCalls.filter(({ name }) => name === "edit_image").length, 0);
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("a failed conversation message can be retried without saving annotations twice", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor", failMessageOnce: true });

  try {
    await import(`../web/editor-runtime.mjs?retry=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 1 }));

    document.querySelector("[data-action=submit]").click();
    await waitFor(() => document.querySelector("[data-submit-status]")?.textContent.includes("发送失败"));
    assert.equal(host.toolCalls.filter(({ name }) => name === "prepare_image_edit_submission").length, 1);
    assert.equal(host.messages.length, 1);

    document.querySelector("[data-action=submit]").click();
    await waitFor(() => document.querySelector(".inline-result") !== null);
    assert.equal(host.toolCalls.filter(({ name }) => name === "prepare_image_edit_submission").length, 1);
    assert.equal(host.modelContexts.length, 1);
    assert.equal(host.messages.length, 2);
    assert.equal(host.messages[0].content[0].text, host.messages[1].content[0].text);
    assert.match(host.messages[1].content[0].text, /标注 ID：ann_01J00000000000000000000000/);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("clearing the current change resets annotations and the prompt as one undoable action", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?clear-draft=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=arrow]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 1 }));
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "保持整体构图";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    document.querySelector("[data-action=clear]").click();
    document.querySelector("[data-action=confirm-clear]").click();
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
    assert.equal(document.querySelector("[data-prompt]").value, "");
    assert.equal(document.querySelector("[data-action=submit]").disabled, true);

    document.querySelector("[data-action=undo]").click();
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
    assert.equal(document.querySelector("[data-prompt]").value, "保持整体构图");
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("prompt-only edits submit without creating an empty annotation record", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?prompt-only=${Date.now()}`);
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => document.querySelector("[data-image-id]")?.textContent === IMAGE_ID);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);

    const submitButton = document.querySelector("[data-action=submit]");
    assert.equal(submitButton.disabled, true);
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "保持构图不变，把整体色调调整得更温暖";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(submitButton.disabled, false);
    assert.equal(document.querySelector("[data-action=clear]").disabled, false);

    submitButton.click();
    submitButton.click();
    await waitFor(() => host.messages.length === 1);
    await waitFor(() => document.querySelector(".inline-result") !== null);

    assert.deepEqual(host.toolCalls.filter(({ name }) => name === "prepare_image_edit_submission").map(({ arguments: args }) => args.items.length), [0]);
    assert.equal(host.modelContexts.length, 1);
    const modelContext = host.modelContexts[0].structuredContent;
    assert.equal(modelContext.imageId, IMAGE_ID);
    assert.equal(modelContext.annotationId, null);
    assert.equal(modelContext.annotationCount, 0);
    assert.equal(modelContext.prompt, "保持构图不变，把整体色调调整得更温暖");
    assert.match(host.messages[0].content[0].text, /基于图片 .* 进行图改图/);
    assert.equal(host.messages[0].content.length, 2);
    assert.equal(host.messages[0].content[1].type, "image");
    assert.equal(host.modelContexts[0].content, undefined);
    assert.equal(host.displayModeRequests.at(-1), "inline");
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("submission waits for model context before sending the conversation message", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor", deferModelContext: true });

  try {
    await import(`../web/editor-runtime.mjs?ordered-submit=${Date.now()}`);
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => document.querySelector("[data-image-id]")?.textContent === IMAGE_ID);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "保持构图并调整颜色";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    document.querySelector("[data-action=submit]").click();
    await waitFor(() => host.modelContexts.length === 1);
    assert.equal(host.messages.length, 0);
    assert.equal(document.querySelector(".editor-app")?.getAttribute("aria-busy"), "true");
    assert.equal(document.querySelector("[data-prompt]").disabled, true);
    assert.equal(document.querySelector("[data-tool=pen]").disabled, true);
    host.releaseModelContext();
    await waitFor(() => host.messages.length === 1);
    await waitFor(() => document.querySelector(".inline-result") !== null);
  } finally {
    host.releaseModelContext();
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("an unacknowledged Codex composer update keeps one request and preserves the draft until acknowledgement", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    deferModelContext: true,
    hostCapabilities: CODEX_COMPOSER_HOST_CAPABILITIES,
  });

  try {
    await import(`../web/editor-runtime.mjs?unacknowledged-context=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "保持构图并调整颜色";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    document.querySelector("[data-action=submit]").click();
    await waitFor(() => host.modelContexts.length === 1);
    await waitFor(() => document.querySelector(".inline-result") !== null, 2000);
    assert.equal(host.messages.length, 0);
    assert.deepEqual([document.querySelector("[data-inline-status]")?.textContent.includes("任务输入框更新未获确认"), document.querySelector("[data-draft-state]")?.textContent], [true, "写入中"]);

    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => document.querySelector(".editor-app") !== null);
    assert.equal(document.querySelector("[data-prompt]").value, "保持构图并调整颜色");

    document.querySelector("[data-action=submit]").click();
    await waitFor(() => document.querySelector(".inline-result") !== null, 2000);
    assert.equal(host.modelContexts.length, 1);

    host.releaseModelContext();
    await waitFor(() => document.querySelector("[data-draft-state]")?.textContent === "待发送");
    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => document.querySelector(".editor-app") !== null);
    const submit = document.querySelector("[data-action=submit]");
    assert.equal(submit.disabled, true);
    assert.equal(submit.textContent, "已放入输入框");
    assert.equal(host.modelContexts.length, 1);

    assert.equal(document.querySelector("[data-prompt]").value, "保持构图并调整颜色");
  } finally {
    host.releaseModelContext();
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("the annotation panel has an explicit narrow-window toggle", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?panel-toggle=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const toggle = document.querySelector("[data-action=toggle-intents]");
    const panel = document.querySelector("[data-intent-panel]");
    assert.ok(toggle);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    toggle.click();
    assert.equal(panel.classList.contains("open"), true);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("mask is shown only when the configured model declares mask support", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor", maskCapability: false });

  try {
    await import(`../web/editor-runtime.mjs?capabilities=${Date.now()}`);
    await waitFor(() => host.toolCalls.some(({ name }) => name === "list_image_models"));
    assert.equal(document.querySelector("[data-tool=mask]").hidden, true);
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("mask size controls start a new stroke without moving the selected mask", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?mask-next-stroke=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    await waitFor(() => document.querySelector("[data-tool=mask]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });

    document.querySelector("[data-tool=mask]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointermove", { clientX: 300, clientY: 300, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 1 }));
    const originalPoints = document.querySelector("[data-layer] polyline")?.getAttribute("points");

    document.querySelector("[data-tool=select]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 200, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 200, clientY: 200, pointerId: 2 }));
    document.querySelector('[data-mask-radius="0.06"]').click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 200, pointerId: 3 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointermove", { clientX: 500, clientY: 250, pointerId: 3 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 500, clientY: 250, pointerId: 3 }));

    const masks = [...document.querySelectorAll("[data-layer] polyline")];
    assert.deepEqual(
      {
        activeTool: document.querySelector("[data-tool=mask]").getAttribute("aria-pressed"),
        maskCount: masks.length,
        originalPoints: masks[0]?.getAttribute("points"),
        newBrushWidth: masks[1]?.getAttribute("stroke-width"),
      },
      {
        activeTool: "true",
        maskCount: 2,
        originalPoints,
        newBrushWidth: "120",
      },
    );
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("annotation editor keeps focus and caret when the host refreshes the widget", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?focus-refresh=${Date.now()}`);
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => document.querySelector("[data-image-id]")?.textContent === IMAGE_ID);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=arrow]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 1 }));

    const field = document.querySelector("[data-annotation-text]");
    field.focus();
    field.value = "调整箭头区域";
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    field.setSelectionRange(2, 2);
    host.notifyHostContext("fullscreen");

    await new Promise((resolve) => setTimeout(resolve, 0));
    const refreshedField = document.querySelector("[data-annotation-text]");
    assert.equal(document.activeElement, refreshedField);
    assert.equal(refreshedField.value, "调整箭头区域");
    assert.equal(refreshedField.selectionStart, 2);
    assert.equal(refreshedField.selectionEnd, 2);
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("annotation style controls and text labels update the visible overlay", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?styles=${Date.now()}`);
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => document.querySelector("[data-image-id]")?.textContent === IMAGE_ID);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });

    document.querySelector('[data-color="#2563eb"]').click();
    document.querySelector('[data-stroke="3"]').click();
    assert.equal(document.querySelector('[data-stroke="3"]').classList.contains("active"), true);
    assert.equal(document.querySelector('[data-stroke="5"]').classList.contains("active"), false);

    document.querySelector("[data-tool=text]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 300, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 260, clientY: 340, pointerId: 1 }));
    const inlineEditor = document.querySelector("[data-canvas-text-editor]");
    assert.equal(document.activeElement, inlineEditor);
    assert.match(inlineEditor?.getAttribute("style") || "", /--canvas-text-color:#2563eb/);
    assert.equal(document.querySelector("[data-layer] .annotation-index text")?.textContent, "1");

    inlineEditor.value = "移除这里的文字";
    inlineEditor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    inlineEditor.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    assert.equal(document.querySelector("[data-layer] .annotation-mark text")?.textContent, "移除这里的文字");
    assert.equal(document.querySelector("[data-layer] .annotation-mark text")?.getAttribute("fill"), "#2563eb");
    assert.equal(document.querySelector("[data-annotation-text]")?.value, "移除这里的文字");

    document.querySelector('[data-color="#111827"]').click();
    assert.equal(document.querySelector("[data-layer] .annotation-mark text")?.getAttribute("fill"), "#2563eb");
    document.querySelector("[data-action=apply-foreground-color]").click();
    assert.equal(document.querySelector("[data-layer] .annotation-mark text")?.getAttribute("fill"), "#111827");
    document.querySelector('[data-stroke="5"]').click();
    assert.equal(document.querySelector("[data-layer] .annotation-mark text")?.getAttribute("fill"), "#111827");
    document.querySelector("[data-action=undo]").click();
    assert.equal(document.querySelector('[data-stroke="3"]').classList.contains("active"), true);
    document.querySelector("[data-action=undo]").click();
    assert.equal(document.querySelector("[data-layer] .annotation-mark text")?.getAttribute("fill"), "#2563eb");
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("select moves an annotation with undo support and eraser removes it", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?hit=${Date.now()}`);
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => document.querySelector("[data-image-id]")?.textContent === IMAGE_ID);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=rectangle]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 1 }));
    const annotationId = document.querySelector("[data-annotation-id]")?.dataset.annotationId;

    document.querySelector("[data-tool=select]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 200, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointermove", { clientX: 400, clientY: 400, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 400, clientY: 400, pointerId: 2 }));
    assert.equal(document.querySelector("[data-annotation-id].selected")?.dataset.annotationId, annotationId);
    assert.equal(document.querySelector("[data-layer] rect")?.getAttribute("x"), "300");
    assert.equal(document.querySelector("[data-layer] rect")?.getAttribute("y"), "300");
    assert.equal(document.querySelector("[data-layer] .annotation-index")?.classList.contains("selected"), true);

    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 800, clientY: 800, pointerId: 4 }));
    assert.equal(document.querySelector("[data-annotation-id].selected"), null);

    document.querySelector("[data-action=undo]").click();
    assert.equal(document.querySelector("[data-layer] rect")?.getAttribute("x"), "100");
    document.querySelector("[data-action=redo]").click();
    assert.equal(document.querySelector("[data-layer] rect")?.getAttribute("x"), "300");

    document.querySelector("[data-tool=eraser]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 400, clientY: 400, pointerId: 3 }));
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
    assert.equal(document.querySelector("[data-summary]")?.textContent, "已标注 0 处");
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("eraser removes freeform marks only when the pointer is near the visible stroke", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?eraser-hit=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    document.querySelector("[data-tool=arrow]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 1 }));
    document.querySelector("[data-tool=eraser]").click();

    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 300, pointerId: 2 }));
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 1);
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 200, clientY: 200, pointerId: 3 }));
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("zoom scales the fitted image and annotation coordinate space together", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?zoom=${Date.now()}`);
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => document.querySelector("[data-image-id]")?.textContent === IMAGE_ID);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const viewport = document.querySelector("[data-canvas]");
    assert.equal(viewport?.classList.contains("canvas-content"), true); document.querySelector(".canvas-frame").getBoundingClientRect = () => ({ width: 1000, height: 600 });
    const zoom = document.querySelector("[data-zoom-select]");
    zoom.value = "1.5";
    zoom.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(document.querySelector("[data-canvas]")?.style.width, "900px");
    document.querySelector("[data-action=fit]").click();
    assert.equal(document.querySelector("[data-canvas]")?.style.width, "600px");
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("editor widget returns to the conversation when the LLM destroys its session", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor", editorSessionStatus: "destroyed" });

  try {
    await import(`../web/editor-runtime.mjs?destroyed=${Date.now()}`);

    await waitFor(() => host.toolCalls.some(({ name }) => name === "get_image_editor_session"));
    await waitFor(() => document.querySelector(".inline-result") !== null);
    assert.equal(host.teardownRequests, 0);
    assert.deepEqual(host.displayModeRequests, ["fullscreen", "inline"]);
    assert.equal(document.querySelector(".inline-result")?.dataset.canvasStatus, "destroyed");
    assert.equal(document.querySelector("[data-action=open-editor]"), null);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});
