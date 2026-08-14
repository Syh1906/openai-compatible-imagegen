import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createImagegenServer } from "../mcp/create-server.mjs";
import { createReleaseBundle } from "../mcp/release-identity.mjs";


const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = fileURLToPath(new URL("../.codex-plugin/plugin.json", import.meta.url));
const widgetOutput = fileURLToPath(new URL("../dist/widget/index.html", import.meta.url));
const serverOutput = fileURLToPath(new URL("../dist/server.mjs", import.meta.url));
const runtimeOutput = fileURLToPath(new URL("../dist/scripts/imagegen.py", import.meta.url));
const resultStateSource = fileURLToPath(new URL("../web/result-state.mjs", import.meta.url));
const IMAGE_ID = "img_01J00000000000000000000000";
const RELEASE_IDENTITY_PLACEHOLDER = "    <!-- RELEASE_IDENTITY -->";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL1WQAAAABJRU5ErkJggg==",
  "base64",
);
const CALL_META = {};
const EXPECTED_RUNTIME_FILES = [
  "artifact_repository.py",
  "image_alpha.py",
  "image_batch.py",
  "image_cli.py",
  "image_download.py",
  "image_emissive_alpha.py",
  "image_mask_alpha.py",
  "image_png.py",
  "image_postprocess.py",
  "image_preview.py",
  "image_qa.py",
  "image_reference.py",
  "image_resize.py",
  "image_response.py",
  "image_transaction.py",
  "image_transparency.py",
  "image_transparency_runtime.py",
  "image_transport.py",
  "image_webp.py",
  "imagegen.py",
  "imagegen_cli.py",
  "mask_policy.py",
  "image_runtime.py",
  "provider_config.py",
  "repository_fs_helper.py",
  "reveal_in_explorer.py",
  "windows_repository_fs.py",
];


test("release-bound widget URIs declare the Codex development cache opt-out", async () => {
  const previousRelease = createReleaseBundle({
    pluginId: "openai-compatible-imagegen-v2",
    pluginVersion: "0.1.0-test",
    serverBuildInputs: [{ path: "mcp/server.mjs", content: "previous server" }],
    widgetHtml: `<html><head>${RELEASE_IDENTITY_PLACEHOLDER}</head><body>previous widget</body></html>`,
  }).releaseIdentity;
  const currentRelease = createReleaseBundle({
    pluginId: "openai-compatible-imagegen-v2",
    pluginVersion: "0.1.0-test",
    serverBuildInputs: [{ path: "mcp/server.mjs", content: "current server" }],
    widgetHtml: `<html><head>${RELEASE_IDENTITY_PLACEHOLDER}</head><body>current widget</body></html>`,
  }).releaseIdentity;

  assert.notEqual(previousRelease.resourceUris.result, currentRelease.resourceUris.result);

  await withReleaseClient(currentRelease, async (client) => {
    const cachePolicy = client.getServerCapabilities()?.experimental?.["codex/tool-catalog-cache"];
    const { tools } = await client.listTools();
    const resourceUri = tools.find((tool) => tool.name === "render_image_results")._meta.ui.resourceUri;
    const resource = await client.readResource({ uri: resourceUri });
    assert.equal(resource.contents[0].uri, currentRelease.resourceUris.result);
    assert.deepEqual(cachePolicy, { cacheable: false });
    await assert.rejects(
      client.readResource({ uri: previousRelease.resourceUris.result }),
      /not found/i,
    );
  });
});


test("the built plugin exposes one content-bound release identity", async () => {
  const { RELEASE_IDENTITY_META_NAME } = await import("../mcp/release-identity.mjs");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const baseInput = {
    pluginId: manifest.name,
    pluginVersion: manifest.version,
    serverBuildInputs: [{ path: "mcp/server.mjs", content: "server-a" }],
    widgetHtml: `<!doctype html><html><head>${RELEASE_IDENTITY_PLACEHOLDER}</head><body>widget-a</body></html>`,
  };
  const first = createReleaseBundle(baseInput);
  const changedServer = createReleaseBundle({
    ...baseInput,
    serverBuildInputs: [{ path: "mcp/server.mjs", content: "server-b" }],
  });
  const changedWidget = createReleaseBundle({
    ...baseInput,
    widgetHtml: `<!doctype html><html><head>${RELEASE_IDENTITY_PLACEHOLDER}</head><body>widget-b</body></html>`,
  });

  assert.notEqual(first.releaseIdentity.fingerprint, changedServer.releaseIdentity.fingerprint);
  assert.notEqual(first.releaseIdentity.fingerprint, changedWidget.releaseIdentity.fingerprint);
  assert.match(first.releaseIdentity.serverBuildDigest, /^[a-f0-9]{64}$/);
  assert.match(first.releaseIdentity.widgetAssetDigest, /^[a-f0-9]{64}$/);

  await writeFile(path.join(projectRoot, "dist", "obsolete.txt"), "obsolete", "utf8");
  await mkdir(path.join(projectRoot, "dist", "scripts", "stale"), { recursive: true });
  await writeFile(path.join(projectRoot, "dist", "scripts", "stale", "secret.txt"), "secret", "utf8");
  const { stdout } = await execFileAsync(process.execPath, ["scripts/build.mjs"], {
    cwd: projectRoot,
  });
  const buildResult = JSON.parse(stdout.trim());
  const releaseIdentity = buildResult.releaseIdentity;
  assertReleaseIdentity(releaseIdentity, manifest);
  assert.equal(buildResult.root, undefined);
  assert.deepEqual(buildResult.outputs, [
    "dist/server.mjs",
    "dist/widget/index.html",
    ...EXPECTED_RUNTIME_FILES.map((name) => `dist/scripts/${name}`),
  ]);
  assert.deepEqual(await listFiles(path.join(projectRoot, "dist")), [
    ...EXPECTED_RUNTIME_FILES.map((name) => `scripts/${name}`),
    "server.mjs",
    "widget/index.html",
  ].sort());

  const { stdout: runtimeHelp } = await execFileAsync("python", [runtimeOutput, "--help"], {
    cwd: projectRoot,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.match(runtimeHelp, /usage: imagegen /);

  const widgetHtml = await readFile(widgetOutput, "utf8");
  assert.equal(count(widgetHtml, "<!doctype html>"), 1);
  assert.equal(count(widgetHtml, '<body data-tool="open_image_editor">'), 1);
  assert.equal(widgetHtml.includes("<!-- WIDGET_SCRIPT -->"), false);
  assert.equal(widgetHtml.includes("read_image_artifact_data"), true);
  assert.equal(widgetHtml.includes("imageArtifacts"), false);
  const marker = `    <meta name="${RELEASE_IDENTITY_META_NAME}" content="${releaseIdentity.fingerprint}">`;
  assert.equal(widgetHtml.includes(marker), true);
  assert.equal(
    sha256(widgetHtml.replace(marker, RELEASE_IDENTITY_PLACEHOLDER)),
    releaseIdentity.widgetAssetDigest,
  );
  const imageLoader = await readFile(resultStateSource, "utf8");
  assert.equal(imageLoader.includes("readServerResource"), false);
  assert.equal(imageLoader.includes("resources/read"), false);

  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-identity-"));
  await writeArtifactFixture(fixtureRoot);
  const client = new Client({ name: "release-identity-test", version: "0.1.0" });
  let toolListChangedCount = 0;
  let resourceListChangedCount = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    toolListChangedCount += 1;
  });
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
    resourceListChangedCount += 1;
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverOutput],
    cwd: fixtureRoot,
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    await waitFor(
      () => toolListChangedCount > 0 && resourceListChangedCount > 0,
      "MCP startup did not refresh the host tool and resource catalogs",
    );
    assert.deepEqual(client.getServerVersion(), {
      name: manifest.name,
      version: manifest.version,
    });
    assert.deepEqual(
      client.getServerCapabilities()?.experimental?.["codex/tool-catalog-cache"],
      { cacheable: false },
    );
    assert.equal(client.getServerCapabilities()?.tools?.listChanged, true);
    assert.equal(client.getServerCapabilities()?.resources?.listChanged, true);

    const { resources } = await client.listResources();
    assert.deepEqual(
      resources.map((resource) => resource.uri).sort(),
      Object.values(releaseIdentity.resourceUris).sort(),
    );
    for (const uri of Object.values(releaseIdentity.resourceUris)) {
      const resource = await client.readResource({ uri });
      assert.equal(resource.contents[0].uri, uri);
      assert.deepEqual(resource.contents[0]._meta.releaseIdentity, releaseIdentity);
      assert.equal(resource.contents[0].text.includes(marker), true);
    }

    const { tools } = await client.listTools();
    const resultTool = tools.find((tool) => tool.name === "render_image_results");
    const editorTool = tools.find((tool) => tool.name === "open_image_editor");
    assert.equal(resultTool._meta.ui.resourceUri, releaseIdentity.resourceUris.result);
    assert.equal(editorTool._meta.ui.resourceUri, releaseIdentity.resourceUris.editor);
    assert.deepEqual(resultTool._meta.releaseIdentity, releaseIdentity);
    assert.deepEqual(editorTool._meta.releaseIdentity, releaseIdentity);

    const unbound = await client.callTool({
      name: "render_image_results",
      arguments: { imageIds: [IMAGE_ID] },
      _meta: CALL_META,
    });
    assert.equal(unbound.isError, true);
    assert.equal(unbound.structuredContent, undefined);
    assert.match(unbound.content?.[0]?.text ?? "", /^project_binding_required:/);

    const binding = await client.callTool({
      name: "bind_imagegen_project",
      arguments: { projectRoot: fixtureRoot },
      _meta: CALL_META,
    });
    assert.deepEqual(binding.structuredContent, { status: "bound" });

    const rendered = await client.callTool({
      name: "render_image_results",
      arguments: { imageIds: [IMAGE_ID] },
      _meta: CALL_META,
    });
    assert.equal(rendered.isError, undefined);
    assert.equal(rendered._meta.ui.resourceUri, releaseIdentity.resourceUris.result);
    assert.deepEqual(rendered._meta.releaseIdentity, releaseIdentity);

    const opened = await client.callTool({
      name: "open_image_editor",
      arguments: { imageId: IMAGE_ID },
      _meta: CALL_META,
    });
    assert.equal(opened.isError, undefined);
    assert.equal(opened._meta.ui.resourceUri, releaseIdentity.resourceUris.editor);
    assert.deepEqual(opened._meta.releaseIdentity, releaseIdentity);

    const { stdout: probeStdout } = await execFileAsync(process.execPath, [
      "scripts/probe-plugin.mjs",
      "--plugin-root",
      projectRoot,
      "--project-root",
      fixtureRoot,
      "--image-id",
      IMAGE_ID,
    ], { cwd: projectRoot });
    const probeResult = JSON.parse(probeStdout.trim());
    assert.equal(probeResult.pluginRoot, undefined);
    assert.equal(probeResult.projectRoot, undefined);
    assert.equal(probeResult.sourceRoot, undefined);
    assert.match(probeResult.pluginRootFingerprint, /^[a-f0-9]{20}$/);
    assert.match(probeResult.projectRootFingerprint, /^[a-f0-9]{20}$/);
    assert.equal(probeResult.sourceRootFingerprint, null);
    assert.equal(probeResult.projectRootRelationToPlugin, "outside");
    assert.equal(probeResult.runtimeDiagnostic.projectRootSource, "explicit_tool");
    assert.equal(
      probeResult.runtimeDiagnostic.pluginRootFingerprint,
      probeResult.pluginRootFingerprint,
    );
    assert.equal(
      probeResult.runtimeDiagnostic.projectRootFingerprint,
      probeResult.projectRootFingerprint,
    );
    assert.equal(probeResult.runtimeDiagnostic.roots.status, "unsupported");
    assert.deepEqual(probeResult.artifactReads, [IMAGE_ID]);
    assert.deepEqual(probeResult.resultRender, {
      imageIds: [IMAGE_ID],
      artifactCount: 1,
      imageDataCount: 1,
    });
  } finally {
    await client.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});


async function withReleaseClient(releaseIdentity, callback) {
  const server = createImagegenServer({
    releaseIdentity,
    launchContext: { cwd: projectRoot, pluginRoot: projectRoot },
    readWidgetHtml: async () => "<html>current widget</html>",
    runTask: async () => {
      throw new Error("not used");
    },
    readArtifact: async () => {
      throw new Error("not used");
    },
    readAnnotation: async () => {
      throw new Error("not used");
    },
    saveAnnotations: async () => {
      throw new Error("not used");
    },
  });
  const client = new Client({ name: "release-upgrade-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}


function assertReleaseIdentity(releaseIdentity, manifest) {
  assert.equal(releaseIdentity.pluginId, manifest.name);
  assert.equal(releaseIdentity.pluginVersion, manifest.version);
  assert.match(releaseIdentity.fingerprint, /^[a-f0-9]{20}$/);
  assert.match(releaseIdentity.serverBuildDigest, /^[a-f0-9]{64}$/);
  assert.match(releaseIdentity.widgetAssetDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(releaseIdentity.resourceUris, {
    result: `ui://${manifest.name}/result-${releaseIdentity.fingerprint}.html`,
    editor: `ui://${manifest.name}/editor-${releaseIdentity.fingerprint}.html`,
  });
}


async function writeArtifactFixture(root) {
  const configDirectory = path.join(root, ".codex", "openai-compatible-imagegen-v2");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(path.join(configDirectory, "config.json"), `${JSON.stringify({
    base_url: "https://example.test/v1",
    api_key: "test-only-key",
    model: "gpt-image-2",
    capabilities: { mask: true },
    defaults: { size: "1024x1024", quality: "low", output_format: "png" },
    postprocess: { enabled: false },
  })}\n`);
  const artifactDirectory = path.join(root, "output", "imagegen", "artifacts", IMAGE_ID);
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(path.join(artifactDirectory, "image.png"), PNG_BYTES);
  const metadata = {
    id: IMAGE_ID,
    parentIds: [],
    mimeType: "image/png",
    width: 1,
    height: 1,
    provider: "primary",
    model: "gpt-image-2",
    operation: "generate",
    prompt: "fixture image",
    parameters: {},
    annotationId: null,
    createdAt: "2026-08-06T00:00:00.000Z",
    imageFile: "image.png",
  };
  await writeFile(
    path.join(root, "output", "imagegen", "index.json"),
    `${JSON.stringify({ version: 1, artifacts: { [IMAGE_ID]: metadata } }, null, 2)}\n`,
  );
}


function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}


function count(value, needle) {
  return value.split(needle).length - 1;
}


async function listFiles(root, relativeDirectory = "") {
  const files = [];
  const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, relativePath));
    else files.push(relativePath.replaceAll("\\", "/"));
  }
  return files.sort();
}


async function waitFor(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}
