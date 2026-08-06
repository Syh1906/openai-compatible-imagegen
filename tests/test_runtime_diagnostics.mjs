import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createImagegenServer } from "../mcp/create-server.mjs";
import { createReleaseBundle, RELEASE_IDENTITY_PLACEHOLDER } from "../mcp/release-identity.mjs";
import { containsAbsolutePath, pathRelation } from "../mcp/runtime-diagnostics.mjs";


const RELEASE_IDENTITY = createReleaseBundle({
  pluginId: "openai-compatible-imagegen-v2",
  pluginVersion: "0.1.0-test",
  serverBuildInputs: [{ path: "mcp/server.mjs", content: "diagnostic server" }],
  widgetHtml: `<html><head>${RELEASE_IDENTITY_PLACEHOLDER}</head></html>`,
}).releaseIdentity;
const LAUNCH_CONTEXT = {
  cwd: "F:/workspace/current-project",
  pluginRoot: "F:/plugin-cache/openai-compatible-imagegen-v2",
  projectRoot: "F:/workspace/current-project",
  projectRootSource: "process.cwd",
};
const ROOTS = [
  { uri: pathToFileURL(LAUNCH_CONTEXT.projectRoot).href, name: "current-project" },
  { uri: pathToFileURL(path.resolve(LAUNCH_CONTEXT.projectRoot, "..", "private-project")).href },
];


test("runtime diagnostics report unsupported roots without exposing launch paths", async () => {
  await withDiagnosticClient({}, async (client) => {
    const { tools } = await client.listTools();
    const diagnosticTool = tools.find((tool) => tool.name === "inspect_imagegen_runtime");
    assert.notEqual(diagnosticTool, undefined);
    assert.deepEqual(diagnosticTool.outputSchema.required.sort(), ["releaseIdentity", "runtime"]);

    const result = await client.callTool({ name: "inspect_imagegen_runtime", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent.releaseIdentity, RELEASE_IDENTITY);
    assertSafeRuntime(result.structuredContent.runtime);
    assert.deepEqual(result.structuredContent.runtime.client, {
      reported: true,
      nameFingerprint: "b3b52a270639009d6637",
      nameLength: 22,
      versionFingerprint: "6ad9613a455798d6d92e",
      versionLength: 5,
      capabilityCount: 0,
      rootsDeclared: false,
    });
    assert.deepEqual(result.structuredContent.runtime.roots, {
      status: "unsupported",
      count: 0,
      entries: [],
      errorCode: null,
    });
    assert.deepEqual(result._meta.releaseIdentity, RELEASE_IDENTITY);
    assertLaunchValuesHidden(result);
  });
});


test("runtime diagnostics request declared roots and return only their safe shape", async () => {
  await withDiagnosticClient({ roots: { listChanged: true } }, async (client) => {
    const result = await client.callTool({ name: "inspect_imagegen_runtime", arguments: {} });
    assert.equal(result.isError, undefined);
    assertSafeRuntime(result.structuredContent.runtime);
    assert.equal(result.structuredContent.runtime.client.capabilityCount, 1);
    assert.equal(result.structuredContent.runtime.client.rootsDeclared, true);
    assert.equal(result.structuredContent.runtime.roots.status, "available");
    assert.equal(result.structuredContent.runtime.roots.count, 2);
    assert.equal(result.structuredContent.runtime.roots.errorCode, null);
    assert.deepEqual(
      result.structuredContent.runtime.roots.entries.map(({ scheme, hasName }) => ({ scheme, hasName })),
      [
        { scheme: "file", hasName: true },
        { scheme: "file", hasName: false },
      ],
    );
    assert.equal(
      result.structuredContent.runtime.roots.entries.every((entry) => /^[a-f0-9]{20}$/.test(entry.fingerprint)),
      true,
    );
    assert.deepEqual(result.structuredContent.runtime.roots.entries[0], {
      scheme: "file",
      fingerprint: result.structuredContent.runtime.projectRootFingerprint,
      hasName: true,
      comparable: true,
      relationToCwd: "same",
      relationToPlugin: "outside",
      relationToProject: "same",
    });
    assertLaunchValuesHidden(result);
  }, ROOTS);
});


test("runtime diagnostics fingerprint unsafe client identity instead of returning it", async () => {
  const clientInfo = {
    name: "C:/Users/alice/private",
    version: "secret-token",
  };
  await withDiagnosticClient({}, async (client) => {
    const result = await client.callTool({ name: "inspect_imagegen_runtime", arguments: {} });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(clientInfo.name), false);
    assert.equal(serialized.includes(clientInfo.version), false);
    assert.equal(result.structuredContent.runtime.client.nameLength, clientInfo.name.length);
    assert.equal(result.structuredContent.runtime.client.versionLength, clientInfo.version.length);
    assert.match(result.structuredContent.runtime.client.nameFingerprint, /^[a-f0-9]{20}$/);
    assert.match(result.structuredContent.runtime.client.versionFingerprint, /^[a-f0-9]{20}$/);
  }, [], { clientInfo });
});


test("runtime diagnostics reduce roots request failures to one stable error code", async () => {
  const rootsError = new Error("EACCES: C:/Users/alice/private-project");
  await withDiagnosticClient({ roots: {} }, async (client) => {
    const result = await client.callTool({ name: "inspect_imagegen_runtime", arguments: {} });
    assert.deepEqual(result.structuredContent.runtime.roots, {
      status: "error",
      count: 0,
      entries: [],
      errorCode: "roots_list_failed",
    });
    assert.equal(JSON.stringify(result).includes(rootsError.message), false);
  }, [], { rootsError });
});


test("path diagnostics keep dot-prefixed descendants and detect absolute paths", () => {
  assert.equal(pathRelation(path.join(LAUNCH_CONTEXT.projectRoot, "..cache"), LAUNCH_CONTEXT.projectRoot), "descendant");
  assert.equal(pathRelation(path.resolve(LAUNCH_CONTEXT.projectRoot, "..", "sibling"), LAUNCH_CONTEXT.projectRoot), "outside");
  assert.equal(containsAbsolutePath("EACCES: C:\\Users\\alice\\private.txt"), true);
  assert.equal(containsAbsolutePath("EACCES: c:/users/alice/private.txt"), true);
  assert.equal(containsAbsolutePath("EACCES: \\\\server\\share\\private.txt"), true);
  assert.equal(containsAbsolutePath("EACCES: '/home/alice/private.txt'"), true);
  assert.equal(containsAbsolutePath("ui://openai-compatible-imagegen-v2/result.html"), false);
  assert.equal(containsAbsolutePath("https://example.test/image.png"), false);
});


async function withDiagnosticClient(capabilities, callback, roots = [], options = {}) {
  const server = createImagegenServer({
    releaseIdentity: RELEASE_IDENTITY,
    launchContext: LAUNCH_CONTEXT,
    readWidgetHtml: async () => "<html></html>",
    runTask: async () => {
      throw new Error("not used");
    },
    readArtifact: async () => {
      throw new Error("not used");
    },
  });
  const client = new Client(
    options.clientInfo ?? { name: "diagnostic-test-client", version: "0.1.0" },
    { capabilities },
  );
  if (capabilities.roots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      if (options.rootsError) throw options.rootsError;
      return { roots };
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}


function assertSafeRuntime(runtime) {
  assert.match(runtime.cwdFingerprint, /^[a-f0-9]{20}$/);
  assert.match(runtime.pluginRootFingerprint, /^[a-f0-9]{20}$/);
  assert.match(runtime.projectRootFingerprint, /^[a-f0-9]{20}$/);
  assert.equal(runtime.cwdRelationToPlugin, "outside");
  assert.equal(runtime.projectRootRelationToPlugin, "outside");
  assert.equal(runtime.projectRootSource, "process.cwd");
}


function assertLaunchValuesHidden(result) {
  const serialized = JSON.stringify(result);
  for (const value of [
    LAUNCH_CONTEXT.cwd,
    LAUNCH_CONTEXT.pluginRoot,
    LAUNCH_CONTEXT.projectRoot,
    ...ROOTS.flatMap((root) => [root.uri, root.name].filter(Boolean)),
  ]) {
    assert.equal(serialized.includes(value), false, `diagnostic result exposed ${value}`);
  }
}
