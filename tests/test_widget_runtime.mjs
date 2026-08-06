import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

const IMAGE_ID = "img_01J00000000000000000000000";
const EDITOR_SESSION_ID = "eds_01J00000000000000000000000";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL1WQAAAABJRU5ErkJggg==";

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
    rejectModelCatalog: true,
  });

  try {
    await import(`../web/editor-runtime.mjs?host-observation-rejected=${Date.now()}`);
    await waitFor(() => host.toolCalls.some(({ name }) => name === "list_image_models"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(host.toolCalls.some(({ name }) => name === "report_imagegen_host_observation"), false);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("the render result opens the selected candidate after app-only artifact reads", async () => {
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
    assert.equal(host.toolCalls.some(({ name }) => name === "get_image_artifact"), false);
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
    assert.equal(host.modelContexts[0].structuredContent.imageId, secondId);
    assert.match(host.messages[0].content[0].text, new RegExp(secondId));
    assert.equal(host.toolCalls.some(({ name }) => name === "save_image_annotations"), false);
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-results") !== null).catch(() => {});
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("result widget loads images through app-only tools when the host only forwards structured content", async () => {
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
  });

  try {
    await import(`../web/editor-runtime.mjs?tool-backed-result-images=${Date.now()}`);
    const imageUrl = `data:image/png;base64,${PNG_BASE64}`;
    await waitFor(() => document.querySelectorAll("[data-image]").length === 2);
    await waitFor(() => [...document.querySelectorAll("[data-image]")]
      .every((image) => image.getAttribute("src") === imageUrl));
    assert.deepEqual(
      [...document.querySelectorAll("[data-result-image-id]")].map((item) => item.dataset.resultImageId),
      [IMAGE_ID, secondId],
    );
    assert.deepEqual(
      host.toolCalls.filter(({ name }) => name === "read_image_artifact_data").map(({ arguments: args }) => args.imageId),
      [IMAGE_ID, secondId],
    );
    assert.deepEqual(host.resourceReads, []);
    assert.equal(host.toolCalls.some(({ name }) => name === "get_image_artifact"), false);
    assert.equal([...document.querySelectorAll("[data-action=open-editor]")].every((button) => !button.disabled), true);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
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
    assert.equal(host.toolCalls.some(({ name }) => name === "get_image_artifact"), false);
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
    toolName: "generate_image",
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
    assert.match(document.querySelector("[data-close-guidance]")?.textContent || "", /直接关闭可能移除入口/);
    assert.equal(document.querySelector("[data-action=back]")?.getAttribute("aria-label"), "返回会话");
    assert.deepEqual(host.displayModeRequests, ["fullscreen"]);
    assert.deepEqual(host.messages, []);
    assert.deepEqual(
      host.toolCalls.filter(({ name }) => name !== "list_image_models").slice(0, 2).map(({ name, arguments: toolArguments }) => ({ name, arguments: toolArguments })),
      [
        { name: "read_image_artifact_data", arguments: { imageId: IMAGE_ID } },
        { name: "open_image_editor", arguments: { imageId: IMAGE_ID } },
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

test("annotations submit once and return to the conversation after explicit save", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor" });

  try {
    await import(`../web/editor-runtime.mjs?annotations=${Date.now()}`);
    await waitFor(() => document.querySelector(".editor-app") !== null);
    await waitFor(() => document.querySelector("[data-image-id]")?.textContent === IMAGE_ID);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const canvas = document.querySelector("[data-canvas]");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });

    document.querySelector("[data-tool=arrow]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 300, clientY: 300, pointerId: 1 }));
    document.querySelector("[data-tool=pen]").click();
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 400, clientY: 400, pointerId: 2 }));
    canvas.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 500, clientY: 500, pointerId: 2 }));

    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 2);
    assert.equal(host.modelContexts.length, 0);
    assert.equal(host.messages.length, 0);

    const firstAnnotation = document.querySelector("[data-annotation-id]");
    const secondAnnotation = document.querySelectorAll("[data-annotation-id]")[1];
    const firstDescription = firstAnnotation?.querySelector("textarea");
    assert.ok(firstDescription);
    assert.equal(firstDescription.maxLength, 600);
    assert.equal(firstAnnotation.querySelector("[data-annotation-count]")?.textContent, "0/600");
    firstDescription.focus();
    assert.equal(firstAnnotation.classList.contains("selected"), true);
    assert.equal(secondAnnotation?.classList.contains("selected"), false);
    firstDescription.value = "只修改箭头区域";
    firstDescription.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(firstAnnotation.querySelector("[data-annotation-count]")?.textContent, "7/600");
    assert.equal(secondAnnotation?.querySelector("textarea")?.value, "");

    document.querySelector("[data-action=submit]").click();
    assert.match(document.querySelector("[data-submit-status]")?.textContent || "", /^正在/);
    document.querySelector("[data-action=submit]").click();
    await waitFor(() => host.toolCalls.some(({ name }) => name === "save_image_annotations"));
    await waitFor(() => host.messages.length === 1);
    await waitFor(() => document.querySelector(".inline-result") !== null);
    assert.equal(host.modelContexts.length, 1);
    assert.equal(host.modelContexts[0].structuredContent.annotationCount, 2);
    assert.equal(host.modelContexts[0].structuredContent.intents[0], "1. 箭头指引：只修改箭头区域");
    assert.match(host.messages[0].content[0].text, /1\. 箭头指引：只修改箭头区域/);
    assert.match(host.messages[0].content[0].text, /2\. 画笔标注：请参考笔触范围/);
    assert.equal(host.messages[0].content.length, 1);
    assert.equal(host.modelContexts[0].content[1].mimeType, "image/png");
    assert.equal(host.modelContexts[0].content[1].data, "cG5nLXByZXZpZXc=");
    const saveCalls = host.toolCalls.filter(({ name }) => name === "save_image_annotations");
    assert.equal(saveCalls.length, 1);
    const saveCall = saveCalls[0];
    assert.equal(saveCall.arguments.imageId, IMAGE_ID);
    assert.equal(saveCall.arguments.items.length, 2);
    assert.equal(saveCall.arguments.items[0].text, "只修改箭头区域");
    assert.equal(host.displayModeRequests.at(-1), "inline");

    document.querySelector("[data-action=open-editor]").click();
    await waitFor(() => document.querySelector(".editor-app") !== null);
    assert.equal(document.querySelectorAll("[data-annotation-id]").length, 0);
    assert.equal(document.querySelector("[data-prompt]").value, "");
  } finally {
    document.querySelector("[data-action=back]")?.click();
    await waitFor(() => document.querySelector(".inline-result") !== null).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    assert.equal(host.toolCalls.filter(({ name }) => name === "save_image_annotations").length, 1);
    assert.equal(host.messages.length, 1);

    document.querySelector("[data-action=submit]").click();
    await waitFor(() => document.querySelector(".inline-result") !== null);
    assert.equal(host.toolCalls.filter(({ name }) => name === "save_image_annotations").length, 1);
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

    assert.equal(host.toolCalls.some(({ name }) => name === "save_image_annotations"), false);
    assert.equal(host.modelContexts.length, 1);
    const modelContext = host.modelContexts[0].structuredContent;
    assert.equal(modelContext.imageId, IMAGE_ID);
    assert.equal(modelContext.annotationId, null);
    assert.equal(modelContext.annotationCount, 0);
    assert.equal(modelContext.prompt, "保持构图不变，把整体色调调整得更温暖");
    assert.match(host.messages[0].content[0].text, /基于图片 .* 进行图改图/);
    assert.equal(host.messages[0].content.length, 1);
    assert.equal(host.modelContexts[0].content[1].type, "image");
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

test("submission continues after Codex applies model context without acknowledging the request", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor", deferModelContext: true });

  try {
    await import(`../web/editor-runtime.mjs?unacknowledged-context=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const prompt = document.querySelector("[data-prompt]");
    prompt.value = "保持构图并调整颜色";
    prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    document.querySelector("[data-action=submit]").click();
    await waitFor(() => host.modelContexts.length === 1);
    await waitFor(() => host.messages.length === 1, 2000);
    await waitFor(() => document.querySelector(".inline-result") !== null);
    assert.match(host.messages[0].content[0].text, /提交 ID：sub_/);
    assert.match(host.messages[0].content[0].text, /图片 ID：img_01J00000000000000000000000/);
    assert.doesNotMatch(document.body.textContent, /模型上下文更新失败/);
  } finally {
    host.releaseModelContext();
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

test("selecting a version loads its artifact before replacing the visible image", async () => {
  const childId = "img_01J00000000000000000000001";
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "open_image_editor",
    children: [{ id: childId, mimeType: "image/png", width: 1, height: 1, operation: "edit", parentIds: [IMAGE_ID] }],
  });

  try {
    await import(`../web/editor-runtime.mjs?version-load=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    document.querySelector(`[data-version-id="${childId}"]`).click();
    await waitFor(() => host.toolCalls.some(({ name, arguments: args }) => name === "get_image_artifact" && args.imageId === childId));
    await waitFor(() => document.querySelector("[data-image-id]")?.textContent === childId);
    assert.equal(document.querySelector("[data-image]").hidden, false);
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
    assert.equal(document.activeElement, document.querySelector("[data-annotation-text]"));
    assert.equal(document.querySelector("[data-layer] text")?.getAttribute("fill"), "#2563eb");
    assert.equal(document.querySelector("[data-layer] .annotation-index text")?.textContent, "1");

    const description = document.querySelector("[data-annotation-text]");
    description.value = "移除这里的文字";
    description.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(document.querySelector("[data-layer] text")?.textContent, "移除这里的文字");

    document.querySelector('[data-color="#111827"]').click();
    document.querySelector('[data-stroke="5"]').click();
    assert.equal(document.querySelector("[data-layer] text")?.getAttribute("fill"), "#111827");
    document.querySelector("[data-action=undo]").click();
    assert.equal(document.querySelector('[data-stroke="3"]').classList.contains("active"), true);
    document.querySelector("[data-action=undo]").click();
    assert.equal(document.querySelector("[data-layer] text")?.getAttribute("fill"), "#2563eb");
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

test("zoom transforms the image and annotation viewport together", async () => {
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
    assert.equal(viewport?.classList.contains("canvas-content"), true);
    const zoom = document.querySelector("[data-zoom-select]");
    zoom.value = "1.5";
    zoom.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(document.querySelector("[data-canvas]")?.style.transform, "scale(1.5)");
    document.querySelector("[data-action=fit]").click();
    assert.equal(document.querySelector("[data-canvas]")?.style.transform, "scale(1)");
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

function installHost(window, { toolName, editorSessionStatus = "active", canvasStatus = "available", deferModelContext = false, children = [], maskCapability = true, failMessageOnce = false, failOpenImageId = null, artifactOverride = null, initialArtifacts = null, initialResultIncludesImages = true, initialResultIncludesWidgetImages = false, rejectModelCatalog = false }) {
  const toolCalls = [];
  const resourceReads = [];
  const displayModeRequests = [];
  const messages = [];
  const modelContexts = [];
  let teardownRequests = 0;
  let pendingModelContextId = null;
  let shouldFailMessage = failMessageOnce;
  let editorSessionImageId = IMAGE_ID;
  const initialArtifactRecords = initialArtifacts?.map((item) => ({ ...item })) || null;
  const defaultArtifact = (id = IMAGE_ID) => ({
    id,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: id === IMAGE_ID ? "generate" : "edit",
    parentIds: id === IMAGE_ID ? [] : [IMAGE_ID],
    childIds: id === IMAGE_ID ? children.map((item) => item.id) : [],
  });
  const onMessage = (event) => {
    const message = event.data;
    if (message?.method === "ui/initialize") {
      sendToApp(window, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2026-01-26",
          hostInfo: { name: "widget-test-host", version: "0.1.0" },
          hostCapabilities: {},
          hostContext: {
            toolInfo: {
              tool: {
                name: toolName,
                inputSchema: { type: "object" },
              },
            },
            displayMode: "inline",
            availableDisplayModes: ["inline", "fullscreen"],
          },
        },
      });
    } else if (message?.method === "ui/notifications/initialized") {
      sendToApp(window, {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: initialArtifactRecords ? { imageIds: initialArtifactRecords.map((item) => item.id) } : { imageId: IMAGE_ID } },
      });
      if (initialArtifactRecords) {
        sendToApp(window, {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            content: initialResultIncludesImages
              ? initialArtifactRecords.map(() => ({ type: "image", mimeType: "image/png", data: PNG_BASE64 }))
              : [],
            structuredContent: { artifacts: initialArtifactRecords },
            _meta: {
              imageIds: initialArtifactRecords.map((item) => item.id),
              ...(initialResultIncludesWidgetImages
                ? { imageArtifacts: initialArtifactRecords.map((item) => ({ ...item, data: PNG_BASE64 })) }
                : {}),
            },
          },
        });
      } else if (toolName === "open_image_editor") {
        sendToApp(window, {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            content: [],
            structuredContent: {
              editorSession: { id: EDITOR_SESSION_ID, imageId: IMAGE_ID, status: "active" },
              artifact: defaultArtifact(),
            },
          },
        });
      }
    } else if (message?.method === "resources/read") {
      resourceReads.push(message.params.uri);
      sendToApp(window, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          contents: [{ uri: message.params.uri, mimeType: "image/png", blob: PNG_BASE64 }],
        },
      });
    } else if (message?.method === "tools/call") {
      toolCalls.push(message.params);
      const toolName = message.params.name;
      if (toolName === "list_image_models" && rejectModelCatalog) {
        sendToApp(window, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: "model catalog unavailable" },
        });
        return;
      }
      if (toolName === "open_image_editor") editorSessionImageId = message.params.arguments.imageId;
      const result = toolName === "read_image_artifact_data"
        ? {
            content: [],
            structuredContent: {
              id: message.params.arguments.imageId,
              mimeType: "image/png",
            },
            _meta: {
              widgetData: {
                id: message.params.arguments.imageId,
                mimeType: "image/png",
                dataBase64: PNG_BASE64,
              },
            },
          }
        : toolName === "list_image_models"
        ? {
            content: [],
            structuredContent: {
              models: [{ id: "primary/gpt-image-2", provider: "primary", model: "gpt-image-2", capabilities: { mask: maskCapability } }],
            },
          }
        : toolName === "report_imagegen_host_observation"
          ? {
              content: [],
              structuredContent: { accepted: message.params.arguments.observations.length },
            }
        : toolName === "get_image_editor_session"
        ? {
            content: [],
            structuredContent: {
              editorSession: { id: EDITOR_SESSION_ID, imageId: editorSessionImageId, status: editorSessionStatus },
            },
          }
        : toolName === "destroy_image_editor"
          ? {
              content: [],
              structuredContent: {
                editorSession: { id: EDITOR_SESSION_ID, imageId: IMAGE_ID, status: "destroyed" },
              },
            }
          : toolName === "finalize_image_editor_session"
            ? {
                content: [],
                structuredContent: {
                  editorSession: { id: EDITOR_SESSION_ID, imageId: IMAGE_ID, status: "released" },
                },
              }
          : toolName === "open_image_editor" && message.params.arguments.imageId === failOpenImageId
            ? {
                isError: true,
                content: [{ type: "text", text: "editor_session_open_failed" }],
              }
          : toolName === "open_image_editor"
            ? {
                content: [],
                structuredContent: {
                  editorSession: { id: EDITOR_SESSION_ID, imageId: editorSessionImageId, status: "active" },
                  artifact: defaultArtifact(editorSessionImageId),
                },
                _meta: { imageId: editorSessionImageId, editorSessionId: EDITOR_SESSION_ID },
              }
          : toolName === "save_image_annotations"
            ? {
                content: [],
                structuredContent: {
                  annotation: { id: "ann_01J00000000000000000000000", imageId: IMAGE_ID, itemCount: message.params.arguments.items.length },
                },
              }
          : {
                content: [{ type: "image", mimeType: "image/png", data: PNG_BASE64 }],
                structuredContent: {
                  artifact: artifactOverride || initialArtifactRecords?.find((item) => item.id === message.params.arguments.imageId) || defaultArtifact(message.params.arguments.imageId || IMAGE_ID),
                  canvasStatus,
                },
              };
      sendToApp(window, {
        jsonrpc: "2.0",
        id: message.id,
        result,
      });
    } else if (message?.method === "ui/request-display-mode") {
      displayModeRequests.push(message.params.mode);
      sendToApp(window, {
        jsonrpc: "2.0",
        id: message.id,
        result: { mode: message.params.mode },
      });
      sendToApp(window, {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { displayMode: message.params.mode },
      });
    } else if (message?.method === "ui/message") {
      messages.push(message.params);
      sendToApp(window, {
        jsonrpc: "2.0",
        id: message.id,
        result: shouldFailMessage ? { isError: true } : {},
      });
      shouldFailMessage = false;
    } else if (message?.method === "ui/update-model-context") {
      modelContexts.push(message.params);
      if (deferModelContext) {
        pendingModelContextId = message.id;
      } else {
        sendToApp(window, {
          jsonrpc: "2.0",
          id: message.id,
          result: {},
        });
      }
    } else if (message?.method === "ui/notifications/request-teardown") {
      teardownRequests += 1;
    }
  };
  window.addEventListener("message", onMessage);
  return {
    displayModeRequests,
    messages,
    modelContexts,
    resourceReads,
    toolCalls,
    get teardownRequests() {
      return teardownRequests;
    },
    notifyHostContext: (displayMode) => sendToApp(window, {
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode },
    }),
    notifyHostContextChanged: (params) => sendToApp(window, {
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params,
    }),
    releaseModelContext: () => {
      if (pendingModelContextId === null) return;
      sendToApp(window, { jsonrpc: "2.0", id: pendingModelContextId, result: {} });
      pendingModelContextId = null;
    },
    dispose: () => window.removeEventListener("message", onMessage),
  };
}

function sendToApp(window, data) {
  window.dispatchEvent(new window.MessageEvent("message", {
    data,
    origin: window.location.origin,
    source: window,
  }));
}

function pointerEvent(window, type, init) {
  const event = new window.MouseEvent(type, { bubbles: true, clientX: init.clientX, clientY: init.clientY });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  return event;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("widget runtime did not reach the expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function installDomGlobals(window) {
  window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,cG5nLXByZXZpZXc=";
  class LoadedImage {
    set src(value) {
      this._src = value;
      queueMicrotask(() => this.onload?.());
    }
    get src() {
      return this._src;
    }
  }
  const values = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    MutationObserver: window.MutationObserver,
    Image: LoadedImage,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return previous;
}

function restoreDomGlobals(previous) {
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}
