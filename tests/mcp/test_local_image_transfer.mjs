import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createLocalImageTransfer } from "../../mcp/local-image-transfer.mjs";
import { readImageArtifact } from "../../mcp/artifact-repository.mjs";
import { assertToolErrorCode, PNG_BASE64, withClient } from "../support/mcp-tool-client.mjs";

test("local transfer MCP tools import a reference, edit by stable ID, and export original bytes", async () => {
  let context;
  let editInputs;
  const transfer = createLocalImageTransfer();
  const trackingTransfer = {
    async importImage(input, bound) {
      context = bound;
      await writeFile(path.join(bound.projectRoot, "reference.png"), Buffer.from(PNG_BASE64, "base64"));
      return await transfer.importImage(input, bound);
    },
    exportImage: transfer.exportImage,
  };
  await withClient({
    localImageTransfer: trackingTransfer,
    readArtifact: readImageArtifact,
    runTask: async (task) => {
      editInputs = task.inputArtifactIds;
      // The provider boundary is mocked; source resolution and export use the real repository.
      return { ok: false, error: { code: "unsupported_capability" } };
    },
  }, async (client) => {
    const listing = await client.listTools();
    for (const name of ["import_local_image", "export_image_artifact"]) {
      const tool = listing.tools.find((entry) => entry.name === name);
      assert.ok(tool);
      assert.equal(tool.annotations.openWorldHint, false);
      assert.equal(tool.annotations.destructiveHint, false);
    }
    const imported = await client.callTool({name: "import_local_image", arguments: {sourcePath: "reference.png"}});
    assert.equal(imported.isError, undefined);
    const parent = imported.structuredContent.artifact;
    assert.equal(parent.operation, "import");
    assert.equal(parent.provider, "local-file");
    assert.equal(JSON.stringify(imported).includes(context.projectRoot), false);
    await client.callTool({name: "edit_image", arguments: {parentImageId: parent.id, prompt: "change pose"}});
    assert.deepEqual(editInputs, [parent.id]);
    const exported = await client.callTool({name: "export_image_artifact", arguments: {
      imageId: parent.id, destinationPath: "decoded/row.png",
    }});
    assert.equal(exported.isError, undefined);
    assert.equal(exported.structuredContent.destinationPath, "decoded/row.png");
    assert.deepEqual(await readFile(path.join(context.projectRoot, "decoded/row.png")), Buffer.from(PNG_BASE64, "base64"));
    const collision = await client.callTool({name: "export_image_artifact", arguments: {
      imageId: parent.id, destinationPath: "decoded/row.png",
    }});
    assertToolErrorCode(collision, "local_image_destination_exists");
  });
});

test("local transfer validates project binding before accessing any source", async () => {
  let calls = 0;
  await withClient({localImageTransfer: {importImage: async () => { calls++; }}}, async (client) => {
    const result = await client.callTool({name: "import_local_image", arguments: {
      projectBindingId: `pbind_${"f".repeat(64)}`, sourcePath: "reference.png",
    }});
    assertToolErrorCode(result, "project_binding_required");
    assert.equal(calls, 0);
  });
});

test("local transfer errors never echo unexpected runtime paths", async () => {
  const transfer = createLocalImageTransfer({runOperation: async () => { throw new Error("C:/private/secret"); }});
  await assert.rejects(transfer.importImage({sourcePath: "image.png"}, {
    projectRoot: "C:/project", artifactRoot: "C:/project/output/imagegen",
  }), (error) => error.code === "local_image_transfer_failed" && !error.message.includes("private"));
});

test("built Plugin imports, renders and exports without Standalone files or API credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-local-built-"));
  const project = path.join(root, "project");
  const userHome = path.join(root, "home");
  const client = new Client({name: "local-transfer-built-test", version: "1.0.0"});
  try {
    await Promise.all([mkdir(project), mkdir(userHome)]);
    await writeFile(path.join(project, "reference.png"), Buffer.from(PNG_BASE64, "base64"));
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../../dist/server.mjs", import.meta.url))],
      cwd: project,
      env: { HOME: userHome, USERPROFILE: userHome },
      stderr: "pipe",
    }));
    const initialized = await client.callTool({name: "initialize_image_config", arguments: {authMode: "chatgpt"}});
    assert.notEqual(initialized.isError, true);
    const binding = await client.callTool({name: "bind_imagegen_project", arguments: {projectRoot: project}});
    assert.notEqual(binding.isError, true);
    assert.equal(binding.structuredContent.defaultAuthMode, "chatgpt");
    const projectBindingId = binding.structuredContent.projectBindingId;
    const imported = await client.callTool({name: "import_local_image", arguments: {projectBindingId, sourcePath: "reference.png"}});
    assert.notEqual(imported.isError, true);
    const imageId = imported.structuredContent.artifact.id;
    const rendered = await client.callTool({name: "render_image_results", arguments: {projectBindingId, imageIds: [imageId]}});
    assert.notEqual(rendered.isError, true);
    assert.equal(rendered.content.find(item => item.type === "image").data, PNG_BASE64);
    const exported = await client.callTool({name: "export_image_artifact", arguments: {projectBindingId, imageId, destinationPath: "decoded/row.png"}});
    assert.notEqual(exported.isError, true);
    assert.deepEqual(await readFile(path.join(project, "decoded/row.png")), Buffer.from(PNG_BASE64, "base64"));
  } finally {
    await client.close();
    await rm(root, {recursive: true, force: true});
  }
});
