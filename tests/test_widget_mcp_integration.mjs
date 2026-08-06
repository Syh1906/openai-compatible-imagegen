import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { JSDOM } from "jsdom";

import { createImagegenServer } from "../mcp/create-server.mjs";
import { createReleaseBundle } from "../mcp/release-identity.mjs";


const IMAGE_ID = "img_01J00000000000000000000000";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL1WQAAAABJRU5ErkJggg==";
const WIDGET_SOURCE_PATH = fileURLToPath(new URL("../web/index.html", import.meta.url));


test("widget consumes real MCP declarations and tool results through one integration seam", async () => {
  const pluginRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
  const projectRoot = path.dirname(pluginRoot);
  const widgetSource = await readFile(WIDGET_SOURCE_PATH, "utf8");
  const releaseBundle = createReleaseBundle({
    pluginId: "openai-compatible-imagegen-v2",
    pluginVersion: "0.1.0-integration-test",
    serverBuildInputs: [{ path: "test-server.mjs", content: "test server" }],
    widgetHtml: widgetSource,
  });
  const { releaseIdentity } = releaseBundle;
  const metadata = {
    id: IMAGE_ID,
    parentIds: [],
    childIds: [],
    mimeType: "image/png",
    width: 1,
    height: 1,
    provider: "primary",
    model: "gpt-image-2",
    operation: "generate",
    prompt: "integration fixture",
    parameters: {},
    annotationId: null,
    createdAt: "2026-08-06T00:00:00.000Z",
  };
  const server = createImagegenServer({
    releaseIdentity,
    launchContext: { cwd: pluginRoot, pluginRoot },
    readWidgetHtml: async () => releaseBundle.widgetHtml,
    runTask: async (task) => task.operation === "list_models"
      ? { ok: true, models: [{ id: "primary/gpt-image-2", provider: "primary", model: "gpt-image-2", capabilities: { mask: true } }] }
      : { ok: false, error: { code: "image_task_failed", message: "not used" } },
    readArtifact: async () => ({ metadata, data: PNG_BASE64 }),
    readAnnotation: async () => { throw new Error("not used"); },
    saveAnnotations: async () => { throw new Error("not used"); },
  });
  const client = new Client({ name: "widget-integration-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let clientConnected = false;
  let serverConnected = false;
  let dom = null;
  let previousGlobals = null;
  let host = null;
  let testFailure = null;

  try {
    const connectionResults = await Promise.allSettled([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    serverConnected = connectionResults[0].status === "fulfilled";
    clientConnected = connectionResults[1].status === "fulfilled";
    const connectionFailure = connectionResults.find(({ status }) => status === "rejected");
    if (connectionFailure) throw connectionFailure.reason;
    const toolCatalog = await client.listTools();
    const resultTool = toolCatalog.tools.find(({ name }) => name === "render_image_results");
    assert.ok(resultTool);
    const bindingResult = await client.callTool({
      name: "bind_imagegen_project",
      arguments: { projectRoot },
    });
    assert.equal(bindingResult.structuredContent.status, "bound");
    const initialToolArguments = { imageIds: [IMAGE_ID] };
    const initialToolResult = await client.callTool({
      name: "render_image_results",
      arguments: initialToolArguments,
    });
    assert.equal(initialToolResult.isError, undefined);
    const resourceUri = resultTool._meta?.ui?.resourceUri;
    assert.equal(resourceUri, releaseIdentity.resourceUris.result);
    assert.equal(initialToolResult._meta?.ui?.resourceUri, resourceUri);
    assert.equal(initialToolResult._meta?.releaseIdentity?.resourceUris?.result, resourceUri);
    const widgetResource = await client.readResource({ uri: resourceUri });
    const widgetResourceContent = widgetResource.contents.find((content) => content.uri === resourceUri);
    assert.equal(widgetResourceContent?._meta?.releaseIdentity?.resourceUris?.result, resourceUri);
    assert.equal(widgetResourceContent?.mimeType, RESOURCE_MIME_TYPE);
    assert.equal(typeof widgetResourceContent?.text, "string");

    dom = new JSDOM(
      "<!doctype html><html><body><iframe title=\"widget\"></iframe></body></html>",
      { pretendToBeVisual: true, url: "https://host.local/" },
    );
    const hostWindow = dom.window;
    const widgetWindow = hostWindow.document.querySelector("iframe").contentWindow;
    widgetWindow.document.open();
    widgetWindow.document.write(widgetResourceContent.text);
    widgetWindow.document.close();
    assert.equal(widgetWindow.parent, hostWindow);
    assert.notEqual(widgetWindow.parent, widgetWindow);
    assert.equal(
      widgetWindow.document.querySelector('meta[name="openai-compatible-imagegen-release"]')?.content,
      releaseIdentity.fingerprint,
    );
    previousGlobals = installDomGlobals(widgetWindow);
    host = installHost(hostWindow, widgetWindow, {
      tool: resultTool,
      initialToolArguments,
      initialToolResult,
      toolCaller: async ({ name, arguments: toolArguments }) => await client.callTool({
        name,
        arguments: toolArguments,
      }),
    });

    await import(`../web/editor-runtime.mjs?mcp-widget-integration=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const requiredToolNames = new Set([
      "list_image_models",
      "read_image_artifact_data",
      "report_imagegen_host_observation",
    ]);
    await waitFor(() => requiredToolNames.isSubsetOf(new Set(
      host.completedToolCalls.map(({ name }) => name),
    )));
    await host.settle();
    assert.equal(document.querySelector("[data-image-id]")?.textContent, IMAGE_ID);
    assert.equal(document.querySelector("[data-action=open-editor]")?.textContent.trim(), "打开画布");
    assert.equal(document.querySelector("[data-image]")?.src, `data:image/png;base64,${PNG_BASE64}`);
    assert.equal(host.pendingToolCallCount, 0);
    assert.equal(host.failedToolCalls.length, 0);
    assert.equal(host.unexpectedSourceMessages.length, 0);
    assert.equal(host.attemptedToolCalls.length, 3);
    const completedToolNames = host.completedToolCalls.map(({ name }) => name);
    assert.equal(completedToolNames.length, 3);
    assert.deepEqual(new Set(completedToolNames), requiredToolNames);
    const diagnostic = await client.callTool({ name: "inspect_imagegen_runtime", arguments: {} });
    assert.deepEqual(
      diagnostic.structuredContent.hostObservationReport.observations.map(({ source }) => source),
      ["ui/notifications/tool-result", "tools/call"],
    );
  } catch (error) {
    testFailure = error;
  }

  const cleanupErrors = await collectCleanupErrors([
    async () => {
      if (host) await withTimeout(host.settle(), 1000, "widget tool cleanup timed out");
    },
    () => host?.dispose(),
    async () => {
      if (clientConnected) await withTimeout(client.close(), 1000, "MCP client cleanup timed out");
    },
    async () => {
      if (serverConnected) await withTimeout(server.close(), 1000, "MCP server cleanup timed out");
    },
    () => {
      if (previousGlobals) restoreDomGlobals(previousGlobals);
    },
    () => dom?.window.close(),
  ]);
  if (testFailure && cleanupErrors.length === 0) throw testFailure;
  if (testFailure || cleanupErrors.length > 0) {
    throw new AggregateError(
      [...(testFailure ? [testFailure] : []), ...cleanupErrors],
      "widget integration test or cleanup failed",
    );
  }
});


function installHost(hostWindow, widgetWindow, { tool, initialToolArguments, initialToolResult, toolCaller }) {
  const attemptedToolCalls = [];
  const completedToolCalls = [];
  const failedToolCalls = [];
  const unexpectedSourceMessages = [];
  const pendingToolCalls = new Set();
  const originalPostMessage = hostWindow.postMessage;
  hostWindow.postMessage = (data) => hostWindow.dispatchEvent(new hostWindow.MessageEvent("message", {
    data,
    origin: hostWindow.location.origin,
    source: widgetWindow,
  }));
  const onMessage = (event) => {
    if (event.source !== widgetWindow) {
      unexpectedSourceMessages.push(event.data);
      return;
    }
    const message = event.data;
    if (message?.method === "ui/initialize") {
      sendToApp(hostWindow, widgetWindow, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2026-01-26",
          hostInfo: { name: "widget-integration-test-host", version: "0.1.0" },
          hostCapabilities: {},
          hostContext: {
            toolInfo: { tool },
            displayMode: "inline",
            availableDisplayModes: ["inline", "fullscreen"],
          },
        },
      });
      return;
    }
    if (message?.method === "ui/notifications/initialized") {
      sendToApp(hostWindow, widgetWindow, {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: initialToolArguments },
      });
      sendToApp(hostWindow, widgetWindow, {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: initialToolResult,
      });
      return;
    }
    if (message?.method !== "tools/call") return;

    attemptedToolCalls.push(message.params);
    const operation = Promise.resolve()
      .then(() => toolCaller(message.params))
      .then((result) => {
        completedToolCalls.push(message.params);
        sendToApp(hostWindow, widgetWindow, {
          jsonrpc: "2.0",
          id: message.id,
          result,
        });
      })
      .catch((error) => {
        failedToolCalls.push({ params: message.params, error });
        sendToApp(hostWindow, widgetWindow, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
      })
      .finally(() => pendingToolCalls.delete(operation));
    pendingToolCalls.add(operation);
  };
  hostWindow.addEventListener("message", onMessage);
  return {
    attemptedToolCalls,
    completedToolCalls,
    failedToolCalls,
    unexpectedSourceMessages,
    get pendingToolCallCount() {
      return pendingToolCalls.size;
    },
    dispose: () => {
      hostWindow.removeEventListener("message", onMessage);
      hostWindow.postMessage = originalPostMessage;
    },
    settle: async () => {
      let previousAttemptCount = -1;
      for (let turn = 0; turn < 20; turn += 1) {
        await withTimeout(
          Promise.allSettled([...pendingToolCalls]),
          1000,
          "widget tool call did not finish",
        );
        await new Promise((resolve) => setImmediate(resolve));
        if (pendingToolCalls.size === 0 && attemptedToolCalls.length === previousAttemptCount) return;
        previousAttemptCount = attemptedToolCalls.length;
      }
      throw new Error("widget tool calls did not settle");
    },
  };
}


async function collectCleanupErrors(actions) {
  const errors = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}


async function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}


function sendToApp(hostWindow, widgetWindow, data) {
  widgetWindow.dispatchEvent(new widgetWindow.MessageEvent("message", {
    data,
    origin: hostWindow.location.origin,
    source: hostWindow,
  }));
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
