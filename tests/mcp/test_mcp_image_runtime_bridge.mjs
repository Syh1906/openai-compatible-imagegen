import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer, request as requestHttp } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runImageTask } from "../../mcp/image-runtime.mjs";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEElEQVR4nGNgaPj/H4xhDABS0gn5PEa22gAAAABJRU5ErkJggg==";

test("Node bridge runs the Python generate and edit path end to end", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-runtime-"));
  const artifactRoot = path.join(projectRoot, "custom-output", "imagegen");
  const requests = [];
  const proxyRequests = [];
  const api = createServer((request, response) => {
    let body = Buffer.alloc(0);
    request.on("data", (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    request.on("end", () => {
      requests.push({ url: request.url, headers: request.headers, body });
      if (request.url === "/generated.png") {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.end(Buffer.from(PNG_BASE64, "base64"));
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ url: "http://provider.example.test/generated.png" }] }));
      }
    });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const apiAddress = api.address();
  const proxy = createServer((request, response) => {
    let body = Buffer.alloc(0);
    request.on("data", (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    request.on("end", () => {
      proxyRequests.push(request.url);
      const target = new URL(request.url);
      const upstream = requestHttp({
        hostname: "127.0.0.1",
        port: apiAddress.port,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers: request.headers,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on("error", (error) => response.destroy(error));
      upstream.end(body);
    });
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const proxyAddress = proxy.address();
    const effectiveConfigJson = JSON.stringify({
      config_version: 1,
      active_profile: "primary/gpt-image-2",
      providers: {
        primary: {
          protocol: "openai-compatible",
          base_url: "http://provider.example.test/v1",
          api_key: "integration-secret",
          user_agent: "Imagegen-Integration/1.0",
          proxy: { url: `http://127.0.0.1:${proxyAddress.port}` },
        },
      },
      models: {
        "primary/gpt-image-2": {
          provider: "primary",
          model: "gpt-image-2",
          capabilities: { generate: true, edit: true },
        },
      },
      defaults: { output_format: "png" },
    });
    const effectiveConfigSha256 = createHash("sha256").update(effectiveConfigJson).digest("hex");
    const output = { size: "1024x1024", quality: "high", format: "png", count: 1, background: "opaque" };
    const generated = await runImageTask(
      {
        operation: "generate",
        modelProfileId: "primary/gpt-image-2",
        prompt: "integration candidate",
        inputArtifactIds: [],
        annotationId: null,
        output,
      },
      { projectRoot, effectiveConfigJson, effectiveConfigSha256, artifactRoot },
    );
    assert.equal(generated.ok, true);
    const parentId = generated.artifacts[0].id;

    const edited = await runImageTask(
      {
        operation: "edit",
        modelProfileId: "primary/gpt-image-2",
        prompt: "保持极简白色构图并调整中央区域",
        inputArtifactIds: [parentId],
        annotationId: null,
        output,
      },
      { projectRoot, effectiveConfigJson, effectiveConfigSha256, artifactRoot },
    );
    assert.equal(edited.ok, true);
    assert.deepEqual(edited.artifacts[0].parentIds, [parentId]);
    assert.deepEqual(
      requests.map((request) => request.url),
      [
        "/v1/images/generations",
        "/generated.png",
        "/v1/images/edits",
        "/generated.png",
      ],
    );
    assert.deepEqual(
      proxyRequests,
      [
        "http://provider.example.test/v1/images/generations",
        "http://provider.example.test/generated.png",
        "http://provider.example.test/v1/images/edits",
        "http://provider.example.test/generated.png",
      ],
    );
    assert.equal(requests.every((request) => request.headers["user-agent"] === "Imagegen-Integration/1.0"), true);
    assert.equal(requests[0].headers.authorization, "Bearer integration-secret");
    assert.equal(requests[2].headers.authorization, "Bearer integration-secret");
    assert.equal(requests[1].headers.authorization, undefined);
    assert.equal(requests[3].headers.authorization, undefined);
    assert.equal(requests[2].body.includes(Buffer.from("保持极简白色构图并调整中央区域", "utf8")), true);
    assert.equal(await fileExists(path.join(artifactRoot, "index.json")), true);
    assert.equal(await fileExists(path.join(projectRoot, "output", "imagegen")), false);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => api.close(resolve));
    await rm(projectRoot, { recursive: true });
  }
});

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
