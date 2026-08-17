import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createImagegenServer } from "../../mcp/create-server.mjs";
import { createReleaseBundle, RELEASE_IDENTITY_PLACEHOLDER } from "../../mcp/release-identity.mjs";


export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEElEQVR4nGNgaPj/H4xhDABS0gn5PEa22gAAAABJRU5ErkJggg==";
const TEST_RELEASE_IDENTITY = createReleaseBundle({
  pluginId: "openai-compatible-imagegen",
  pluginVersion: "0.1.0-test",
  serverBuildInputs: [{ path: "test-server.mjs", content: "test server" }],
  widgetHtml: `<html><head>${RELEASE_IDENTITY_PLACEHOLDER}</head></html>`,
}).releaseIdentity;
export const RESULT_WIDGET_URI = TEST_RELEASE_IDENTITY.resourceUris.result;
export const EDITOR_WIDGET_URI = TEST_RELEASE_IDENTITY.resourceUris.editor;
const PROJECT_BINDING_ID = `pbind_${"0".repeat(64)}`;

export function artifact(id, parentIds = []) {
  return {
    id,
    parentIds,
    childIds: [],
    mimeType: "image/png",
    width: 1,
    height: 1,
    provider: "primary",
    model: "gpt-image-2",
    operation: parentIds.length ? "edit" : "generate",
    prompt: "test prompt",
    parameters: {},
    annotationId: null,
    createdAt: "2026-08-06T00:00:00.000Z",
  };
}

export function assertToolErrorCode(result, code, message = "") {
  assert.equal(result.isError, true, message);
  assert.equal(result.structuredContent, undefined, message);
  assert.match(result.content?.[0]?.text ?? "", new RegExp(`^${code}:`), message);
}

export async function withClient(dependencies, callback) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-mcp-context-"));
  const pluginRoot = path.join(fixtureRoot, "plugin-cache");
  const projectRoot = path.join(fixtureRoot, "workspace");
  await Promise.all([mkdir(pluginRoot), mkdir(projectRoot)]);
  const artifactRoot = path.join(projectRoot, "output", "imagegen");
  let bound = false;
  const projectContext = {
    async bind() {
      bound = true;
      return { status: "bound", projectBindingId: PROJECT_BINDING_ID };
    },
    async require(projectBindingId) {
      if (!bound || projectBindingId !== PROJECT_BINDING_ID) {
        const error = new Error("project_binding_required");
        error.code = "project_binding_required";
        throw error;
      }
      return {
        bindingKey: "0".repeat(64),
        projectRoot,
        artifactRoot,
        effectiveConfigJson: JSON.stringify({
          config_version: 1,
          active_profile: "primary/gpt-image-2",
          providers: {},
          models: {},
        }),
        effectiveConfigSha256: "0".repeat(64),
      };
    },
  };
  const server = createImagegenServer({
    releaseIdentity: TEST_RELEASE_IDENTITY,
    launchContext: { cwd: pluginRoot, pluginRoot },
    readWidgetHtml: async () => "<html>editor</html>",
    deleteAnnotation: async () => {},
    projectContext,
    ...dependencies,
  });
  const client = new Client({ name: "mcp-contract-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const requestMeta = {};
    const originalCallTool = client.callTool.bind(client);
    await client.listTools();
    const binding = await originalCallTool({
      name: "bind_imagegen_project",
      arguments: { projectRoot },
      _meta: requestMeta,
    });
    assert.deepEqual(binding.structuredContent, { status: "bound", projectBindingId: PROJECT_BINDING_ID });
    client.callTool = async (request, ...rest) => await originalCallTool(
      {
        ...request,
        arguments: { projectBindingId: PROJECT_BINDING_ID, ...request.arguments },
        _meta: request._meta ?? requestMeta,
      },
      ...rest,
    );
    await callback(client);
  } finally {
    await client.close();
    await server.close();
    await rm(fixtureRoot, { recursive: true });
  }
}
