import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createImagegenServer } from "../../mcp/create-server.mjs";
import { createReleaseBundle, RELEASE_IDENTITY_PLACEHOLDER } from "../../mcp/release-identity.mjs";
import {
  containsAbsolutePath,
  createRuntimeObservation,
  fingerprintPath,
  pathRelation,
} from "../../mcp/runtime-diagnostics.mjs";
import { summarizeHostEnvelope } from "../../web/host-observation.mjs";
import {
  createFixtureProjectContext,
  FIXTURE_PROJECT_BINDING_ID,
} from "../support/fixture-project-context.mjs";


const RELEASE_IDENTITY = createReleaseBundle({
  pluginId: "openai-compatible-imagegen",
  pluginVersion: "0.1.0-test",
  serverBuildInputs: [{ path: "mcp/server.mjs", content: "diagnostic server" }],
  widgetHtml: `<html><head>${RELEASE_IDENTITY_PLACEHOLDER}</head></html>`,
}).releaseIdentity;
const LAUNCH_CONTEXT = {
  cwd: "F:/workspace/current-project",
  pluginRoot: "F:/plugin-cache/openai-compatible-imagegen",
};
const PROJECT_ROOT = "F:/workspace/current-project";
const DIAGNOSTIC_PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ROOTS = [
  { uri: pathToFileURL(PROJECT_ROOT).href, name: "current-project" },
  { uri: pathToFileURL(path.resolve(PROJECT_ROOT, "..", "private-project")).href },
];


test("runtime path fingerprints normalize only the macOS system var alias", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  try {
    assert.equal(
      fingerprintPath("/var/folders/runtime/plugin"),
      fingerprintPath("/private/var/folders/runtime/plugin"),
    );
    assert.notEqual(
      fingerprintPath("/Users/runner/workspace/project"),
      fingerprintPath("/users/runner/workspace/project"),
    );
  } finally {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  }
});


test("runtime diagnostics report unsupported roots without exposing launch paths", async () => {
  await withDiagnosticClient({}, async (client) => {
    const { tools } = await client.listTools();
    const diagnosticTool = tools.find((tool) => tool.name === "inspect_imagegen_runtime");
    assert.notEqual(diagnosticTool, undefined);
    assert.deepEqual(diagnosticTool.outputSchema.required.sort(), ["hostObservationReport", "releaseIdentity", "runtime"]);

    const result = await client.callTool({ name: "inspect_imagegen_runtime", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent.releaseIdentity, RELEASE_IDENTITY);
    assert.equal(result.structuredContent.hostObservationReport, null);
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
      truncated: false,
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
    assert.equal(result.structuredContent.runtime.roots.truncated, false);
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
    const firstRootFingerprint = result.structuredContent.runtime.roots.entries[0].fingerprint;
    assert.match(firstRootFingerprint, /^[a-f0-9]{20}$/);
    assert.deepEqual(result.structuredContent.runtime.roots.entries[0], {
      scheme: "file",
      fingerprint: firstRootFingerprint,
      hasName: true,
      comparable: true,
      relationToCwd: "same",
      relationToPlugin: "outside",
      relationToProject: null,
    });
    assertLaunchValuesHidden(result);
  }, ROOTS);
});


test("runtime diagnostics bound retained roots and scheme length", async () => {
  const oversizedScheme = "a".repeat(128);
  const roots = Array.from({ length: 40 }, (_, index) => ({
    uri: pathToFileURL(path.join(PROJECT_ROOT, `root-${index}`)).href,
    name: `root-${index}`,
  }));

  await withDiagnosticClient({ roots: {} }, async (client) => {
    const { tools } = await client.listTools();
    const diagnosticTool = tools.find((tool) => tool.name === "inspect_imagegen_runtime");
    const rootsSchema = diagnosticTool.outputSchema.properties.runtime.properties.roots;
    assert.equal(rootsSchema.properties.entries.maxItems, 32);
    assert.equal(rootsSchema.properties.entries.items.properties.scheme.maxLength, 32);
    assert.equal(rootsSchema.properties.count.maximum, 32);
    assert.equal(rootsSchema.required.includes("truncated"), true);

    const result = await client.callTool({ name: "inspect_imagegen_runtime", arguments: {} });
    const retained = result.structuredContent.runtime.roots;
    assert.equal(retained.status, "available");
    assert.equal(retained.count, 32);
    assert.equal(retained.entries.length, 32);
    assert.equal(retained.truncated, true);
    assert.equal(retained.entries.every(({ scheme }) => scheme.length <= 32), true);
  }, roots);

  const observation = createRuntimeObservation({
    ...LAUNCH_CONTEXT,
    projectRoot: null,
    projectRootSource: "unbound",
    clientVersion: null,
    clientCapabilities: { roots: {} },
    rootsSupported: true,
    roots: [{ uri: `${oversizedScheme}://example.test/root` }],
  });
  assert.equal(observation.roots.entries[0].scheme.length, 32);
  assert.equal(JSON.stringify(observation).includes(oversizedScheme), false);
});


test("runtime diagnostics omit fingerprints for path-like or token-like client identity", async () => {
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
    assert.equal(result.structuredContent.runtime.client.nameFingerprint, null);
    assert.equal(result.structuredContent.runtime.client.versionFingerprint, null);
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
      truncated: false,
    });
    assert.equal(JSON.stringify(result).includes(rootsError.message), false);
  }, [], { rootsError });
});


test("path diagnostics keep dot-prefixed descendants and detect absolute paths", () => {
  assert.equal(pathRelation(path.join(PROJECT_ROOT, "..cache"), PROJECT_ROOT), "descendant");
  assert.equal(pathRelation(path.join(PROJECT_ROOT, "..cache", "nested"), PROJECT_ROOT), "descendant");
  assert.equal(pathRelation(path.resolve(PROJECT_ROOT, "..", "sibling"), PROJECT_ROOT), "outside");
  assert.equal(containsAbsolutePath("EACCES: C:\\Users\\alice\\private.txt"), true);
  assert.equal(containsAbsolutePath("EACCES: c:/users/alice/private.txt"), true);
  assert.equal(containsAbsolutePath("EACCES: \\\\server\\share\\private.txt"), true);
  assert.equal(containsAbsolutePath("EACCES: '/home/alice/private.txt'"), true);
  assert.equal(containsAbsolutePath("ui://openai-compatible-imagegen/result.html"), false);
  assert.equal(containsAbsolutePath("https://example.test/image.png"), false);
});


test("runtime diagnostics retain only release-bound host envelope shapes", async () => {
  const observations = [
    {
      source: "ui/notifications/tool-result",
      fields: [
        { path: "$", type: "object", length: null },
        { path: "$.structuredContent", type: "object", length: null },
      ],
      errorCodes: [],
      truncated: false,
    },
    {
      source: "tools/call",
      fields: [
        { path: "$", type: "object", length: null },
        { path: "$.isError", type: "boolean", length: null },
      ],
      errorCodes: ["tools_call_rejected"],
      truncated: false,
    },
  ];
  await withDiagnosticClient({}, async (client) => {
    const { tools } = await client.listTools();
    const reportTool = tools.find((tool) => tool.name === "report_imagegen_host_observation");
    assert.deepEqual(reportTool?._meta?.ui?.visibility, ["app"]);
    assert.deepEqual(reportTool?.outputSchema?.required, ["accepted", "provenance", "scope"]);
    const projectBindingId = await bindDiagnosticProject(client);

    const report = await client.callTool({
      name: "report_imagegen_host_observation",
      arguments: { projectBindingId, releaseFingerprint: RELEASE_IDENTITY.fingerprint, observations },
    });
    assert.equal(report.isError, undefined);
    assert.deepEqual(report.structuredContent, {
      accepted: 2,
      provenance: "unverified_widget_report",
      scope: "project_binding_latest",
    });

    const diagnostic = await client.callTool({
      name: "inspect_imagegen_runtime",
      arguments: { projectBindingId },
    });
    assert.deepEqual(diagnostic.structuredContent.hostObservationReport, {
      provenance: "unverified_widget_report",
      scope: "project_binding_latest",
      observations,
    });

    const rejected = await client.callTool({
      name: "report_imagegen_host_observation",
      arguments: { projectBindingId, releaseFingerprint: "ffffffffffffffffffff", observations },
    });
    assert.equal(rejected.isError, true);
    assert.equal(rejected.structuredContent.error.code, "release_identity_mismatch");
  });
});


test("runtime diagnostics accept bounded widget-produced observations", async () => {
  let deepValue = "leaf";
  for (let index = 0; index < 8; index += 1) {
    deepValue = { [`field_${index}_${"x".repeat(54)}`]: deepValue };
  }
  const errorGroups = Array.from({ length: 8 }, (_, groupIndex) => Object.fromEntries(
    Array.from({ length: 32 }, (_, errorIndex) => [
      `error_${groupIndex}_${errorIndex}`,
      { code: `observed_error_${groupIndex}_${errorIndex}` },
    ]),
  ));
  const observations = [
    summarizeHostEnvelope("ui/notifications/tool-result", {
      structuredContent: { img_01J00000000000000000000000: deepValue },
    }),
    summarizeHostEnvelope("tools/call", { errorGroups }),
  ];

  await withDiagnosticClient({}, async (client) => {
    const projectBindingId = await bindDiagnosticProject(client);
    const report = await client.callTool({
      name: "report_imagegen_host_observation",
      arguments: { projectBindingId, releaseFingerprint: RELEASE_IDENTITY.fingerprint, observations },
    });
    assert.equal(report.isError, undefined);
    assert.deepEqual(report.structuredContent, {
      accepted: 2,
      provenance: "unverified_widget_report",
      scope: "project_binding_latest",
    });
    const diagnostic = await client.callTool({
      name: "inspect_imagegen_runtime",
      arguments: { projectBindingId },
    });
    assert.deepEqual(diagnostic.structuredContent.hostObservationReport.observations, observations);
    assert.equal(JSON.stringify(diagnostic).includes("img_01J00000000000000000000000"), false);
  });
});


test("runtime diagnostics reject host observation reports for an unknown project binding", async () => {
  const observations = [
    summarizeHostEnvelope("ui/notifications/tool-result", { structuredContent: { artifacts: [] } }),
    summarizeHostEnvelope("tools/call", { structuredContent: { models: [] } }),
  ];

  await withDiagnosticClient({}, async (client) => {
    const report = await client.callTool({
      name: "report_imagegen_host_observation",
      arguments: {
        projectBindingId: `pbind_${"e".repeat(64)}`,
        releaseFingerprint: RELEASE_IDENTITY.fingerprint,
        observations,
      },
    });
    assert.equal(report.isError, true);
    assert.match(report.content?.[0]?.text ?? "", /^project_binding_required:/);
    assert.equal(report.structuredContent, undefined);
    const diagnostic = await client.callTool({ name: "inspect_imagegen_runtime", arguments: {} });
    assert.equal(diagnostic.structuredContent.hostObservationReport, null);
  });
});


test("runtime diagnostics receive the explicit project binding through MCP tool calls", async () => {
  const observations = [
    summarizeHostEnvelope("ui/notifications/tool-result", { structuredContent: { artifacts: [] } }),
    summarizeHostEnvelope("tools/call", { structuredContent: { models: [] } }),
  ];
  await withDiagnosticClient({}, async (client) => {
    const projectBindingId = await bindDiagnosticProject(client);
    const report = await client.callTool({
      name: "report_imagegen_host_observation",
      arguments: { projectBindingId, releaseFingerprint: RELEASE_IDENTITY.fingerprint, observations },
    });
    assert.equal(report.structuredContent.scope, "project_binding_latest");

    const diagnostic = await client.callTool({
      name: "inspect_imagegen_runtime",
      arguments: { projectBindingId },
    });
    assert.equal(diagnostic.structuredContent.hostObservationReport.scope, "project_binding_latest");
    assert.equal(JSON.stringify(diagnostic).includes("shared-transport-session"), false);
  }, [], { sessionId: "shared-transport-session" });
});


test("runtime diagnostics correlate widget and model calls within one project binding", async () => {
  const server = createImagegenServer({
    releaseIdentity: RELEASE_IDENTITY,
    launchContext: LAUNCH_CONTEXT,
    projectContext: createFixtureProjectContext({ projectRoot: DIAGNOSTIC_PROJECT_ROOT }),
    readWidgetHtml: async () => "<html></html>",
    runTask: async () => {
      throw new Error("not used");
    },
    readArtifact: async () => {
      throw new Error("not used");
    },
  });
  const reportHandler = server._registeredTools.report_imagegen_host_observation.handler;
  const bindHandler = server._registeredTools.bind_imagegen_project.handler;
  const inspectHandler = server._registeredTools.inspect_imagegen_runtime.handler;
  const observations = [
    summarizeHostEnvelope("ui/notifications/tool-result", { structuredContent: { artifacts: [] } }),
    summarizeHostEnvelope("tools/call", { structuredContent: { models: [] } }),
  ];
  try {
    await bindHandler({ projectRoot: DIAGNOSTIC_PROJECT_ROOT });
    const report = await reportHandler({
      projectBindingId: FIXTURE_PROJECT_BINDING_ID,
      releaseFingerprint: RELEASE_IDENTITY.fingerprint,
      observations,
    }, { sessionId: "widget-transport-session", _meta: {} });
    assert.equal(report.structuredContent.scope, "project_binding_latest");

    const diagnostic = await inspectHandler({ projectBindingId: FIXTURE_PROJECT_BINDING_ID }, {
      sessionId: "model-transport-session",
      _meta: {},
    });
    assert.deepEqual(diagnostic.structuredContent.hostObservationReport, {
      provenance: "unverified_widget_report",
      scope: "project_binding_latest",
      observations,
    });

    const anotherCaller = await inspectHandler({ projectBindingId: FIXTURE_PROJECT_BINDING_ID }, {
      sessionId: "another-transport-session",
      _meta: { ignored: "conversation-metadata" },
    });
    assert.deepEqual(
      anotherCaller.structuredContent.hostObservationReport,
      diagnostic.structuredContent.hostObservationReport,
    );
    assert.equal(JSON.stringify(anotherCaller).includes("conversation-metadata"), false);
  } finally {
    await server.close();
  }
});


test("runtime diagnostics retain only the latest project-binding report", async () => {
  const server = createImagegenServer({
    releaseIdentity: RELEASE_IDENTITY,
    launchContext: LAUNCH_CONTEXT,
    projectContext: createFixtureProjectContext({ projectRoot: DIAGNOSTIC_PROJECT_ROOT }),
    readWidgetHtml: async () => "<html></html>",
    runTask: async () => {
      throw new Error("not used");
    },
    readArtifact: async () => {
      throw new Error("not used");
    },
  });
  const reportHandler = server._registeredTools.report_imagegen_host_observation.handler;
  const bindHandler = server._registeredTools.bind_imagegen_project.handler;
  const inspectHandler = server._registeredTools.inspect_imagegen_runtime.handler;
  const reportFor = async (structuredContent, sessionId) => {
    const report = await reportHandler({
      projectBindingId: FIXTURE_PROJECT_BINDING_ID,
      releaseFingerprint: RELEASE_IDENTITY.fingerprint,
      observations: [summarizeHostEnvelope("tools/call", { structuredContent })],
    }, { sessionId, _meta: {} });
    assert.equal(report.isError, undefined);
  };
  try {
    await bindHandler({ projectRoot: DIAGNOSTIC_PROJECT_ROOT });
    await reportFor({ imageId: "img_01J00000000000000000000000" }, "first-transport");
    await reportFor({ models: [] }, "second-transport");

    const updated = await inspectHandler(
      { projectBindingId: FIXTURE_PROJECT_BINDING_ID },
      { sessionId: "third-transport", _meta: {} },
    );
    assert.equal(
      updated.structuredContent.hostObservationReport.observations[0].fields.some(({ path }) => path === "$.structuredContent.models"),
      true,
    );
    assert.equal(
      updated.structuredContent.hostObservationReport.observations[0].fields.some(({ path }) => path === "$.structuredContent.imageId"),
      false,
    );
    assert.equal(JSON.stringify(updated).includes("second-transport"), false);
  } finally {
    await server.close();
  }
});


test("runtime diagnostics sanitize client-provided paths and error codes", async () => {
  const privateKey = "img_01J00000000000000000000000";
  const observations = [
    {
      source: "ui/notifications/tool-result",
      fields: [{ path: `$.structuredContent.${privateKey}`, type: "object", length: null }],
      errorCodes: ["user_123456"],
      truncated: false,
    },
    {
      source: "tools/call",
      fields: [{ path: "$.content", type: "array", length: 0 }],
      errorCodes: [],
      truncated: false,
    },
  ];

  await withDiagnosticClient({}, async (client) => {
    const projectBindingId = await bindDiagnosticProject(client);
    const report = await client.callTool({
      name: "report_imagegen_host_observation",
      arguments: { projectBindingId, releaseFingerprint: RELEASE_IDENTITY.fingerprint, observations },
    });
    assert.equal(report.isError, undefined);
    const diagnostic = await client.callTool({
      name: "inspect_imagegen_runtime",
      arguments: { projectBindingId },
    });
    const retained = diagnostic.structuredContent.hostObservationReport.observations[0];
    assert.deepEqual(retained.fields, [{ path: "$.structuredContent.field", type: "object", length: null }]);
    assert.deepEqual(retained.errorCodes, []);
    assert.equal(JSON.stringify(diagnostic).includes(privateKey), false);
    assert.equal(JSON.stringify(diagnostic).includes("user_123456"), false);
  });
});


test("runtime diagnostics reject host shapes outside widget production limits", async () => {
  const invalidObservations = [
    {
      source: "ui/notifications/tool-result",
      fields: [
        { path: "$.field.field.field.field.field.field.field.field.field", type: "object", length: null },
        { path: "$[32]", type: "array", length: 33 },
      ],
      errorCodes: [],
      truncated: true,
    },
    {
      source: "tools/call",
      fields: [
        { path: "$", type: "object", length: 1 },
        { path: "$.content", type: "string", length: 999_999_999 },
      ],
      errorCodes: [],
      truncated: true,
    },
  ];

  await withDiagnosticClient({}, async (client) => {
    const projectBindingId = await bindDiagnosticProject(client);
    const report = await client.callTool({
      name: "report_imagegen_host_observation",
      arguments: {
        projectBindingId,
        releaseFingerprint: RELEASE_IDENTITY.fingerprint,
        observations: invalidObservations,
      },
    });
    assert.equal(report.isError, true);

    const diagnostic = await client.callTool({
      name: "inspect_imagegen_runtime",
      arguments: { projectBindingId },
    });
    assert.equal(diagnostic.structuredContent.hostObservationReport, null);
  });
});


async function withDiagnosticClient(capabilities, callback, roots = [], options = {}) {
  const server = createImagegenServer({
    releaseIdentity: RELEASE_IDENTITY,
    launchContext: LAUNCH_CONTEXT,
    projectContext: createFixtureProjectContext({ projectRoot: DIAGNOSTIC_PROJECT_ROOT }),
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
  if (options.sessionId) serverTransport.sessionId = options.sessionId;
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}


async function bindDiagnosticProject(client) {
  const binding = await client.callTool({
    name: "bind_imagegen_project",
    arguments: { projectRoot: DIAGNOSTIC_PROJECT_ROOT },
  });
  assert.equal(binding.isError, undefined, binding.content?.[0]?.text);
  assert.deepEqual(binding.structuredContent, {
    status: "bound",
    projectBindingId: FIXTURE_PROJECT_BINDING_ID,
  });
  return binding.structuredContent.projectBindingId;
}


function assertSafeRuntime(runtime) {
  assert.match(runtime.cwdFingerprint, /^[a-f0-9]{20}$/);
  assert.match(runtime.pluginRootFingerprint, /^[a-f0-9]{20}$/);
  assert.equal(runtime.projectRootFingerprint, null);
  assert.equal(runtime.cwdRelationToPlugin, "outside");
  assert.equal(runtime.projectRootRelationToPlugin, null);
  assert.equal(runtime.projectRootSource, "unbound");
}


function assertLaunchValuesHidden(result) {
  const serialized = JSON.stringify(result);
  for (const value of [
    LAUNCH_CONTEXT.cwd,
    LAUNCH_CONTEXT.pluginRoot,
    PROJECT_ROOT,
    ...ROOTS.flatMap((root) => [root.uri, root.name].filter(Boolean)),
  ]) {
    assert.equal(serialized.includes(value), false, `diagnostic result exposed ${value}`);
  }
}
