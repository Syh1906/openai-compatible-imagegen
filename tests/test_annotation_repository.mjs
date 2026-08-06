import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";

import { readImageAnnotation, saveImageAnnotations } from "../mcp/annotation-repository.mjs";


const IMAGE_ID = "img_01J00000000000000000000000";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL1WQAAAABJRU5ErkJggg==";

test("annotations are stored together with a preview and no implicit mask", async () => {
  await withArtifact(async (projectRoot) => {
    const result = await saveImageAnnotations(
      {
        imageId: IMAGE_ID,
        items: [
          { id: "mark-1", type: "arrow", from: { x: 0.8, y: 0.2 }, to: { x: 0.5, y: 0.4 }, text: "Move this lower", color: "#2563eb", strokeWidth: 3 },
          { id: "mark-2", type: "text", x: 0.1, y: 0.2, text: "Use a warmer color", color: "#111827", strokeWidth: 5 },
        ],
      },
      { projectRoot },
    );

    assert.match(result.id, /^ann_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(result.imageId, IMAGE_ID);
    assert.equal(result.itemCount, 2);
    assert.equal(result.previewMimeType, "image/svg+xml");
    assert.equal(result.hasMask, false);
    assert.equal(JSON.stringify(result).includes(projectRoot), false);

    const annotationRoot = path.join(projectRoot, "output", "imagegen", "annotations", result.id);
    const stored = JSON.parse(await readFile(path.join(annotationRoot, "annotation.json"), "utf8"));
    const preview = await readFile(path.join(annotationRoot, "preview.svg"), "utf8");
    assert.deepEqual(stored.items.map((item) => item.id), ["mark-1", "mark-2"]);
    assert.equal(stored.maskFile, null);
    assert.match(preview, /Move this lower/);
    assert.match(preview, /Use a warmer color/);
    assert.match(preview, /stroke="#2563eb"/);
    assert.match(preview, /fill="#111827"/);
    assert.match(preview, />1<\/text>/);
    assert.match(preview, />2<\/text>/);
  });
});

test("an explicit mask annotation creates an original-size PNG mask", async () => {
  await withArtifact(async (projectRoot) => {
    const result = await saveImageAnnotations(
      {
        imageId: IMAGE_ID,
        items: [{ id: "mask-1", type: "mask", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], text: "Replace this area" }],
      },
      { projectRoot },
    );

    assert.equal(result.hasMask, true);
    const mask = await readFile(path.join(projectRoot, "output", "imagegen", "annotations", result.id, "mask.png"));
    assert.equal(mask.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(mask.readUInt32BE(16), 1);
    assert.equal(mask.readUInt32BE(20), 1);
    assert.equal(mask[25], 6);
    const idatTypeOffset = mask.indexOf(Buffer.from("IDAT"));
    const idatLength = mask.readUInt32BE(idatTypeOffset - 4);
    const scanline = inflateSync(mask.subarray(idatTypeOffset + 4, idatTypeOffset + 4 + idatLength));
    assert.deepEqual([...scanline], [0, 255, 255, 255, 0]);
  });
});

test("a saved annotation can be read with validated internal derivative paths", async () => {
  await withArtifact(async (projectRoot) => {
    const saved = await saveImageAnnotations(
      {
        imageId: IMAGE_ID,
        items: [{ id: "mask-1", type: "mask", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], text: "Replace this area" }],
      },
      { projectRoot },
    );

    const annotation = await readImageAnnotation(saved.id, { projectRoot });
    assert.equal(annotation.id, saved.id);
    assert.equal(annotation.imageId, IMAGE_ID);
    assert.deepEqual(annotation.items.map((item) => item.id), ["mask-1"]);
    assert.equal(annotation.maskPath, path.join(projectRoot, "output", "imagegen", "annotations", saved.id, "mask.png"));
    assert.equal(annotation.previewPath, path.join(projectRoot, "output", "imagegen", "annotations", saved.id, "preview.svg"));
  });
});

async function withArtifact(callback) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-annotations-"));
  const artifactRoot = path.join(projectRoot, "output", "imagegen", "artifacts", IMAGE_ID);
  await mkdir(artifactRoot, { recursive: true });
  const entry = {
    id: IMAGE_ID,
    parentIds: [],
    mimeType: "image/png",
    width: 1,
    height: 1,
    provider: "test",
    model: "gpt-image-2",
    operation: "generate",
    prompt: "fixture",
    parameters: {},
    annotationId: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    imageFile: "image.png",
  };
  await writeFile(path.join(artifactRoot, "image.png"), Buffer.from(PNG_BASE64, "base64"));
  await writeFile(path.join(artifactRoot, "meta.json"), JSON.stringify(entry));
  await writeFile(
    path.join(projectRoot, "output", "imagegen", "index.json"),
    JSON.stringify({ version: 1, artifacts: { [IMAGE_ID]: entry } }),
  );
  try {
    await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true });
  }
}
