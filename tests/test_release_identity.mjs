import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";


const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = fileURLToPath(new URL("../.codex-plugin/plugin.json", import.meta.url));
const widgetOutput = fileURLToPath(new URL("../dist/widget/index.html", import.meta.url));
const serverOutput = fileURLToPath(new URL("../dist/server.mjs", import.meta.url));
const resultStateSource = fileURLToPath(new URL("../web/result-state.mjs", import.meta.url));
const IMAGE_ID = "img_01J00000000000000000000000";
const RELEASE_IDENTITY_PLACEHOLDER = "    <!-- RELEASE_IDENTITY -->";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL1WQAAAABJRU5ErkJggg==",
  "base64",
);


test("the built plugin exposes one content-bound release identity", async () => {
  const {
    createReleaseBundle,
    RELEASE_IDENTITY_META_NAME,
  } = await import("../mcp/release-identity.mjs");
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
    "dist/scripts/imagegen.py",
    "dist/scripts/artifact_repository.py",
    "dist/scripts/image_download.py",
    "dist/scripts/provider_config.py",
  ]);

  const widgetHtml = await readFile(widgetOutput, "utf8");
  assert.equal(count(widgetHtml, "<!doctype html>"), 1);
  assert.equal(count(widgetHtml, '<body data-tool="open_image_editor">'), 1);
  assert.equal(widgetHtml.includes("<!-- WIDGET_SCRIPT -->"), false);
  assert.equal(widgetHtml.includes("read_image_artifact_data"), true);
  assert.equal(widgetHtml.includes("imageArtifacts"), false);
  const marker = `    <meta name="${RELEASE_IDENTITY_META_NAME}" content="${releaseIdentity.fingerprint}">\n`;
  assert.equal(widgetHtml.includes(marker), true);
  assert.equal(
    sha256(widgetHtml.replace(marker.trimEnd(), RELEASE_IDENTITY_PLACEHOLDER)),
    releaseIdentity.widgetAssetDigest,
  );
  const imageLoader = await readFile(resultStateSource, "utf8");
  assert.equal(imageLoader.includes("readServerResource"), false);
  assert.equal(imageLoader.includes("resources/read"), false);

  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-release-identity-"));
  await writeArtifactFixture(fixtureRoot);
  const client = new Client({ name: "release-identity-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverOutput],
    cwd: fixtureRoot,
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    assert.deepEqual(client.getServerVersion(), {
      name: manifest.name,
      version: manifest.version,
    });

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

    const rendered = await client.callTool({
      name: "render_image_results",
      arguments: { imageIds: [IMAGE_ID] },
    });
    assert.equal(rendered.isError, undefined);
    assert.equal(rendered._meta.ui.resourceUri, releaseIdentity.resourceUris.result);
    assert.deepEqual(rendered._meta.releaseIdentity, releaseIdentity);

    const opened = await client.callTool({
      name: "open_image_editor",
      arguments: { imageId: IMAGE_ID },
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
    ], { cwd: projectRoot });
    const probeResult = JSON.parse(probeStdout.trim());
    assert.equal(probeResult.pluginRoot, undefined);
    assert.equal(probeResult.projectRoot, undefined);
    assert.equal(probeResult.sourceRoot, undefined);
    assert.match(probeResult.pluginRootFingerprint, /^[a-f0-9]{20}$/);
    assert.match(probeResult.projectRootFingerprint, /^[a-f0-9]{20}$/);
    assert.equal(probeResult.sourceRootFingerprint, null);
    assert.equal(probeResult.projectRootRelationToPlugin, "outside");
    assert.equal(probeResult.runtimeDiagnostic.projectRootSource, "process.cwd");
    assert.equal(
      probeResult.runtimeDiagnostic.pluginRootFingerprint,
      probeResult.pluginRootFingerprint,
    );
    assert.equal(
      probeResult.runtimeDiagnostic.projectRootFingerprint,
      probeResult.projectRootFingerprint,
    );
    assert.equal(probeResult.runtimeDiagnostic.roots.status, "unsupported");
  } finally {
    await client.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});


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
