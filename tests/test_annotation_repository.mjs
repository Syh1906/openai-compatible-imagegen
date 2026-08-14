import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";

import { deleteImageAnnotation, readImageAnnotation, saveImageAnnotations } from "../mcp/annotation-repository.mjs";


const IMAGE_ID = "img_01J00000000000000000000000";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL1WQAAAABJRU5ErkJggg==";

test("annotation CRUD requires an explicit absolute artifact root", async () => {
  const request = {
    imageId: IMAGE_ID,
    items: [{ id: "rect-1", type: "rectangle", x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
  };
  await assert.rejects(saveImageAnnotations(request), /artifact root is required/i);
  await assert.rejects(readImageAnnotation("ann_01J00000000000000000000000"), /artifact root is required/i);
  await assert.rejects(
    deleteImageAnnotation("ann_01J00000000000000000000000", { artifactRoot: "output/imagegen" }),
    /artifact root is required/i,
  );
});

test("annotations are stored together with a preview and no implicit mask", async () => {
  await withArtifact(async (artifactRoot) => {
    const result = await saveImageAnnotations(
      {
        imageId: IMAGE_ID,
        items: [
          { id: "mark-1", type: "arrow", from: { x: 0.8, y: 0.2 }, to: { x: 0.5, y: 0.4 }, text: "Move this lower", color: "#2563eb", strokeWidth: 3 },
          { id: "mark-2", type: "text", x: 0.1, y: 0.2, text: "Use a warmer color", color: "#111827", strokeWidth: 5 },
        ],
      },
      { artifactRoot },
    );

    assert.match(result.id, /^ann_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(result.imageId, IMAGE_ID);
    assert.equal(result.itemCount, 2);
    assert.equal(result.previewMimeType, "image/svg+xml");
    assert.equal(result.hasMask, false);
    assert.equal(JSON.stringify(result).includes(artifactRoot), false);

    const annotationRoot = path.join(artifactRoot, "annotations", result.id);
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

test("a saved annotation can be deleted through its validated stable ID", async () => {
  await withArtifact(async (artifactRoot) => {
    const saved = await saveImageAnnotations(
      {
        imageId: IMAGE_ID,
        items: [{ id: "rect-1", type: "rectangle", x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
      },
      { artifactRoot },
    );

    await deleteImageAnnotation(saved.id, { artifactRoot });
    await assert.rejects(readImageAnnotation(saved.id, { artifactRoot }), /annotation not found/);
  });
});

test("an explicit mask annotation creates an original-size PNG mask", async () => {
  await withArtifact(async (artifactRoot) => {
    const result = await saveImageAnnotations(
      {
        imageId: IMAGE_ID,
        items: [{ id: "mask-1", type: "mask", mode: "edit", brushRadius: 0.1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], text: "Replace this area" }],
      },
      { artifactRoot },
    );

    assert.equal(result.hasMask, true);
    const mask = await readFile(path.join(artifactRoot, "annotations", result.id, "mask.png"));
    assert.equal(mask.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(mask.readUInt32BE(16), 1);
    assert.equal(mask.readUInt32BE(20), 1);
    assert.equal(mask[25], 6);
    const idatTypeOffset = mask.indexOf(Buffer.from("IDAT"));
    const idatLength = mask.readUInt32BE(idatTypeOffset - 4);
    const scanline = inflateSync(mask.subarray(idatTypeOffset + 4, idatTypeOffset + 4 + idatLength));
    assert.deepEqual([...scanline], [0, 255, 255, 255, 0]);
    assert.deepEqual(result.maskPolicy, {
      policyVersion: "mask-policy-v2",
      modelProfileId: "primary/gpt-image-2",
      requiredCapabilities: { mask: true },
      strategy: "edit-only",
      parentImageId: IMAGE_ID,
      annotationId: result.id,
      width: 1,
      height: 1,
      masks: [{ id: "mask-1", mode: "edit", operation: "paint", radiusPx: 0.1 }],
      hardBoundary: { source: "edit-strokes", postprocess: "parent-blend" },
      semanticProtection: {
        enabled: false,
        source: "protect-strokes",
        preserve: ["identity", "geometry", "text", "texture"],
        allowAdaptation: ["lighting", "shadow", "tone"],
      },
      transitionBand: { kind: "outer-feather", featherRatio: 0.35, minimumWidthPx: 1 },
      maskSha256: createHash("sha256").update(mask).digest("hex"),
      policySha256: policySha256(result.maskPolicy),
    });
    assert.equal(JSON.stringify(result.maskPolicy).includes(artifactRoot), false);
  });
});

test("mask annotations require an explicit valid mode and normalized brush radius", async () => {
  await withArtifact(async (artifactRoot) => {
    const base = { id: "mask-1", type: "mask", points: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }] };
    await assert.rejects(
      saveImageAnnotations({ imageId: IMAGE_ID, items: [{ ...base, brushRadius: 0.1 }] }, { artifactRoot }),
      /mask mode must be edit or protect/,
    );
    await assert.rejects(
      saveImageAnnotations({ imageId: IMAGE_ID, items: [{ ...base, mode: "keep", brushRadius: 0.1 }] }, { artifactRoot }),
      /mask mode must be edit or protect/,
    );
    await assert.rejects(
      saveImageAnnotations({ imageId: IMAGE_ID, items: [{ ...base, mode: "edit" }] }, { artifactRoot }),
      /mask brushRadius must be a normalized number/,
    );
    await assert.rejects(
      saveImageAnnotations({ imageId: IMAGE_ID, items: [{ ...base, mode: "edit", brushRadius: 0 }] }, { artifactRoot }),
      /mask brushRadius must be a normalized number/,
    );
    await assert.rejects(
      saveImageAnnotations({ imageId: IMAGE_ID, items: [{ ...base, mode: "edit", brushRadius: 0.6 }] }, { artifactRoot }),
      /mask brushRadius must be a normalized number/,
    );
    await assert.rejects(
      saveImageAnnotations({ imageId: IMAGE_ID, items: [{ ...base, mode: "edit", brushRadius: 0.000001 }] }, { artifactRoot }),
      /mask brushRadius must be a normalized number/,
    );
    await assert.rejects(
      saveImageAnnotations({ imageId: IMAGE_ID, items: [{ ...base, mode: "edit", operation: "replace", brushRadius: 0.1 }] }, { artifactRoot }),
      /mask operation must be paint or erase/,
    );
    await assert.rejects(
      saveImageAnnotations({
        imageId: IMAGE_ID,
        items: [{
          ...base,
          mode: "edit",
          brushRadius: 0.1,
          points: Array.from({ length: 4097 }, () => ({ x: 0.5, y: 0.5 })),
        }],
      }, { artifactRoot }),
      /mask points must contain between 1 and 4096 entries/,
    );
    await assert.rejects(
      saveImageAnnotations({
        imageId: IMAGE_ID,
        items: [
          { ...base, mode: "edit", brushRadius: 0.1 },
          { ...base, mode: "protect", brushRadius: 0.1 },
        ],
      }, { artifactRoot }),
      /mask annotation IDs must be unique/,
    );
  });
});

test("mask rasterization rejects submissions above the bounded work budget", async () => {
  await withArtifact(async (artifactRoot) => {
    const items = Array.from({ length: 17 }, (_, index) => ({
      id: `mask-${index}`,
      type: "mask",
      mode: "edit",
      brushRadius: 0.5,
      points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    }));
    await assert.rejects(
      saveImageAnnotations({ imageId: IMAGE_ID, items }, { artifactRoot }),
      /mask raster work budget/,
    );
  }, { width: 100, height: 100 });
});

test("mask rasterization rejects an image above the total pixel budget before allocation", async () => {
  await withArtifact(async (artifactRoot) => {
    await assert.rejects(
      saveImageAnnotations({
        imageId: IMAGE_ID,
        items: [{
          id: "oversized-image-mask",
          type: "mask",
          mode: "protect",
          brushRadius: 0.1,
          points: [{ x: 0.5, y: 0.5 }],
        }],
      }, { artifactRoot }),
      /mask pixel budget exceeded/,
    );
  }, { width: 4097, height: 4096 });
});

test("mask rasterization enforces the absolute work cap for large valid images", async () => {
  await withArtifact(async (artifactRoot) => {
    const points = Array.from({ length: 4096 }, (_, index) => index % 2 === 0
      ? { x: 0.45, y: 0.45 }
      : { x: 0.55, y: 0.55 });
    await assert.rejects(
      saveImageAnnotations({
        imageId: IMAGE_ID,
        items: [{
          id: "absolute-work-cap-mask",
          type: "mask",
          mode: "edit",
          brushRadius: 0.001,
          points,
        }],
      }, { artifactRoot }),
      /mask raster work budget exceeded/,
    );
  }, { width: 2000, height: 2000 });
});

test("ten large sparse mask strokes stay within the spatial raster budget", async () => {
  await withArtifact(async (artifactRoot) => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      id: `sparse-diagonal-${index}`,
      type: "mask",
      mode: "edit",
      brushRadius: 0.001,
      points: index % 2 === 0
        ? [{ x: 0, y: 0 }, { x: 1, y: 1 }]
        : [{ x: 0, y: 1 }, { x: 1, y: 0 }],
    }));

    const result = await saveImageAnnotations({ imageId: IMAGE_ID, items }, { artifactRoot });
    assert.equal(result.hasMask, true);
  }, { width: 2048, height: 2048 });
});

test("mask rasterization preserves a short curved detour instead of flattening it", async () => {
  await withArtifact(async (artifactRoot) => {
    const densePoints = [
      { x: 0.2, y: 0.5 },
      { x: 0.3, y: 0.4985 },
      { x: 0.4, y: 0.5015 },
      { x: 0.5, y: 0.4985 },
      { x: 0.6, y: 0.5015 },
      { x: 0.7, y: 0.4985 },
      { x: 0.8, y: 0.5 },
    ];
    const curvedResult = await saveImageAnnotations({
      imageId: IMAGE_ID,
      items: [{ id: "curved-mask", type: "mask", mode: "edit", brushRadius: 0.2, points: densePoints }],
    }, { artifactRoot });
    const straightResult = await saveImageAnnotations({
      imageId: IMAGE_ID,
      items: [{ id: "straight-mask", type: "mask", mode: "edit", brushRadius: 0.2, points: [densePoints[0], densePoints.at(-1)] }],
    }, { artifactRoot });
    const curvedMask = await readFile(path.join(artifactRoot, "annotations", curvedResult.id, "mask.png"));
    const straightMask = await readFile(path.join(artifactRoot, "annotations", straightResult.id, "mask.png"));
    assert.notDeepEqual(curvedMask, straightMask);
  }, { width: 2000, height: 2000 });
});

test("oversized erase-only mask strokes do not consume raster budget", async () => {
  await withArtifact(async (artifactRoot) => {
    const items = [
      { id: "protect-paint", type: "mask", mode: "protect", operation: "paint", brushRadius: 0.05, points: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }] },
      ...Array.from({ length: 17 }, (_, index) => ({
        id: `empty-edit-erase-${index}`,
        type: "mask",
        mode: "edit",
        operation: "erase",
        brushRadius: 0.5,
        points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      })),
    ];
    const result = await saveImageAnnotations({ imageId: IMAGE_ID, items }, { artifactRoot });
    assert.equal(result.maskPolicy.strategy, "protect-only");
    const mask = await readFile(path.join(artifactRoot, "annotations", result.id, "mask.png"));
    const baseline = await saveImageAnnotations({
      imageId: IMAGE_ID,
      items: [items[0]],
    }, { artifactRoot });
    const baselineMask = await readFile(path.join(artifactRoot, "annotations", baseline.id, "mask.png"));
    assert.deepEqual(mask, baselineMask);
  }, { width: 100, height: 100 });
});

test("a schema-limit dense mask path stays within the geometric raster budget", async () => {
  await withArtifact(async (artifactRoot) => {
    const points = Array.from({ length: 4096 }, (_, index) => index <= 2047
      ? { x: 0.3 + ((0.2 * index) / 2047), y: 0.4 }
      : { x: 0.5, y: 0.4 + ((0.2 * (index - 2047)) / 2048) });

    const result = await saveImageAnnotations({
      imageId: IMAGE_ID,
      items: [{
        id: "dense-local-mask",
        type: "mask",
        mode: "edit",
        brushRadius: 0.035,
        points,
      }],
    }, { artifactRoot });

    const sparseResult = await saveImageAnnotations({
      imageId: IMAGE_ID,
      items: [{
        id: "sparse-local-mask",
        type: "mask",
        mode: "edit",
        brushRadius: 0.035,
        points: [points[0], points[2047], points.at(-1)],
      }],
    }, { artifactRoot });

    const annotationRoot = path.join(artifactRoot, "annotations", result.id);
    const stored = JSON.parse(await readFile(path.join(annotationRoot, "annotation.json"), "utf8"));
    const denseMask = await readFile(path.join(annotationRoot, "mask.png"));
    const sparseMask = await readFile(path.join(artifactRoot, "annotations", sparseResult.id, "mask.png"));
    assert.equal(result.hasMask, true);
    assert.equal(stored.items[0].points.length, points.length);
    assert.deepEqual(denseMask, sparseMask);
  }, { width: 1536, height: 1024 });
});

test("a schema-limit smooth mask curve is not rejected for device sample density", async () => {
  await withArtifact(async (artifactRoot) => {
    const points = Array.from({ length: 4096 }, (_, index) => {
      const progress = index / 4095;
      return {
        x: 0.2 + (0.6 * progress),
        y: 0.5 + (0.12 * Math.sin(progress * Math.PI * 2)),
      };
    });

    const result = await saveImageAnnotations({
      imageId: IMAGE_ID,
      items: [{
        id: "dense-smooth-mask",
        type: "mask",
        mode: "edit",
        brushRadius: 0.035,
        points,
      }],
    }, { artifactRoot });

    assert.equal(result.hasMask, true);
  }, { width: 1536, height: 1024 });
});

test("the hard edit mask path index matches brute-force polyline coverage pixel for pixel", async () => {
  const width = 37;
  const height = 29;
  const brushRadius = 0.09;
  const points = [
    { x: 0.08, y: 0.12 },
    { x: 0.41, y: 0.18 },
    { x: 0.37, y: 0.74 },
    { x: 0.82, y: 0.63 },
    { x: 0.9, y: 0.9 },
  ];
  await withArtifact(async (artifactRoot) => {
    const result = await saveImageAnnotations({
      imageId: IMAGE_ID,
      items: [{ id: "indexed-mask", type: "mask", mode: "edit", brushRadius, points }],
    }, { artifactRoot });
    const mask = await readFile(path.join(artifactRoot, "annotations", result.id, "mask.png"));

    assert.deepEqual(
      decodeAlpha(mask),
      bruteForceEditAlpha({ width, height, brushRadius, points }),
    );
  }, { width, height });
});

test("mask policy v2 separates hard edit boundaries from semantic protection", async () => {
  await withArtifact(async (artifactRoot) => {
    const cases = [
      { modes: ["edit"], strategy: "edit-only" },
      { modes: ["protect"], strategy: "protect-only" },
      { modes: ["edit", "protect"], strategy: "mixed" },
    ];
    for (const { modes, strategy } of cases) {
      const result = await saveImageAnnotations(
        {
          imageId: IMAGE_ID,
          items: modes.map((mode, index) => ({
            id: `mask-${index + 1}`,
            type: "mask",
            mode,
            brushRadius: mode === "edit" ? 0.28 : 0.12,
            points: [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }],
          })),
        },
        { artifactRoot },
      );
      assert.equal(result.maskPolicy.policyVersion, "mask-policy-v2");
      assert.equal(result.maskPolicy.strategy, strategy);
      assert.deepEqual(
        result.maskPolicy.masks,
        modes.map((mode, index) => ({
          id: `mask-${index + 1}`,
          mode,
          operation: "paint",
          radiusPx: Number(((mode === "edit" ? 0.28 : 0.12) * 9).toFixed(6)),
        })),
      );
      assert.deepEqual(result.maskPolicy.hardBoundary, {
        source: strategy === "protect-only" ? "none" : "edit-strokes",
        postprocess: strategy === "protect-only" ? "none" : "parent-blend",
      });
      assert.deepEqual(result.maskPolicy.semanticProtection, {
        enabled: strategy !== "edit-only",
        source: "protect-strokes",
        preserve: ["identity", "geometry", "text", "texture"],
        allowAdaptation: ["lighting", "shadow", "tone"],
      });
      assert.deepEqual(result.maskPolicy.transitionBand, { kind: "outer-feather", featherRatio: 0.35, minimumWidthPx: 1 });
      const mask = await readFile(path.join(artifactRoot, "annotations", result.id, "mask.png"));
      assert.equal(result.maskPolicy.maskSha256, createHash("sha256").update(mask).digest("hex"));
      assert.equal(result.maskPolicy.policySha256, policySha256(result.maskPolicy));
      const alpha = decodeAlpha(mask);
      assert.equal(
        alpha[0],
        strategy === "protect-only" ? 0 : 255,
        `${strategy} should apply the correct unpainted-area policy`,
      );
      if (strategy === "edit-only") assert.equal(alpha[4 * 9 + 4], 0);
      if (strategy === "protect-only") {
        assert.deepEqual(alpha, new Array(9 * 9).fill(0), "protect-only must leave the whole image model-editable");
      }
      if (strategy === "mixed") assert.equal(alpha[4 * 9 + 4], 0, "protect strokes must not overwrite the hard edit boundary");
    }
  }, { width: 9, height: 9 });
});

test("local edit erasers change the hard boundary while protect operations remain semantic", async () => {
  await withArtifact(async (artifactRoot) => {
    const editResult = await saveImageAnnotations({
      imageId: IMAGE_ID,
      items: [
        { id: "edit-paint", type: "mask", mode: "edit", operation: "paint", brushRadius: 0.08, points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] },
        { id: "edit-erase", type: "mask", mode: "edit", operation: "erase", brushRadius: 0.035, points: [{ x: 0.45, y: 0.5 }, { x: 0.55, y: 0.5 }] },
      ],
    }, { artifactRoot });
    const editMask = await readFile(path.join(artifactRoot, "annotations", editResult.id, "mask.png"));
    const editAlpha = decodeAlpha(editMask);
    assert.equal(editAlpha[20 * 41 + 20], 255, "edit eraser restores the protected base");
    assert.equal(editAlpha[20 * 41 + 8], 0, "untouched edit paint stays editable");
    assert.deepEqual(editResult.maskPolicy.masks.map(({ operation }) => operation), ["paint", "erase"]);

    const protectResult = await saveImageAnnotations({
      imageId: IMAGE_ID,
      items: [
        { id: "edit-base", type: "mask", mode: "edit", operation: "paint", brushRadius: 0.08, points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] },
        { id: "protect-paint", type: "mask", mode: "protect", operation: "paint", brushRadius: 0.08, points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] },
        { id: "protect-erase", type: "mask", mode: "protect", operation: "erase", brushRadius: 0.035, points: [{ x: 0.45, y: 0.5 }, { x: 0.55, y: 0.5 }] },
      ],
    }, { artifactRoot });
    const protectMask = await readFile(path.join(artifactRoot, "annotations", protectResult.id, "mask.png"));
    const protectAlpha = decodeAlpha(protectMask);
    assert.equal(protectAlpha[20 * 41 + 20], 0, "protect erase must not alter the edit-derived boundary");
    assert.equal(protectAlpha[20 * 41 + 8], 0, "protect paint must not alter the edit-derived boundary");
  }, { width: 41, height: 41 });
});

test("erase-only mask modes are no-ops and do not change the painted-layer strategy", async () => {
  await withArtifact(async (artifactRoot) => {
    const protectResult = await saveImageAnnotations({
      imageId: IMAGE_ID,
      items: [
        { id: "protect-paint", type: "mask", mode: "protect", operation: "paint", brushRadius: 0.08, points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] },
        { id: "empty-edit-erase", type: "mask", mode: "edit", operation: "erase", brushRadius: 0.035, points: [{ x: 0.45, y: 0.5 }, { x: 0.55, y: 0.5 }] },
      ],
    }, { artifactRoot });
    const protectMask = await readFile(path.join(artifactRoot, "annotations", protectResult.id, "mask.png"));
    const protectAlpha = decodeAlpha(protectMask);
    assert.equal(protectResult.maskPolicy.strategy, "protect-only");
    assert.equal(protectAlpha[0], 0, "an erase-only edit layer must not protect the unpainted image");
    assert.equal(protectAlpha[20 * 41 + 8], 0, "protect-only remains fully model-editable");

    const editResult = await saveImageAnnotations({
      imageId: IMAGE_ID,
      items: [
        { id: "edit-paint", type: "mask", mode: "edit", operation: "paint", brushRadius: 0.08, points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] },
        { id: "empty-protect-erase", type: "mask", mode: "protect", operation: "erase", brushRadius: 0.035, points: [{ x: 0.45, y: 0.5 }, { x: 0.55, y: 0.5 }] },
      ],
    }, { artifactRoot });
    assert.equal(editResult.maskPolicy.strategy, "edit-only");

    await assert.rejects(
      saveImageAnnotations({
        imageId: IMAGE_ID,
        items: [{ id: "erase-only", type: "mask", mode: "edit", operation: "erase", brushRadius: 0.035, points: [{ x: 0.4, y: 0.5 }, { x: 0.6, y: 0.5 }] }],
      }, { artifactRoot }),
      /at least one paint stroke/,
    );
  }, { width: 41, height: 41 });
});

test("edit masks keep the full core transparent and feather only outside the brush radius", async () => {
  await withArtifact(async (artifactRoot) => {
    const result = await saveImageAnnotations(
      {
        imageId: IMAGE_ID,
        items: [{
          id: "edit-1",
          type: "mask",
          mode: "edit",
          brushRadius: 0.2,
          points: [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }],
        }],
      },
      { artifactRoot },
    );
    const mask = await readFile(path.join(artifactRoot, "annotations", result.id, "mask.png"));
    const alpha = decodeAlpha(mask);

    assert.equal(result.maskPolicy.masks[0].radiusPx, 4.2);
    assert.equal(alpha[10 * 21 + 14], 0, "the outer edge of the edit core must remain transparent");
    assert.ok(alpha[10 * 21 + 15] > 0 && alpha[10 * 21 + 15] < 255, "the band outside the core must be partial alpha");
    assert.equal(alpha[10 * 21 + 16], 255, "pixels beyond the outer feather must remain parent-locked");
  }, { width: 21, height: 21 });
});

test("mask policy hashes are canonical and reject persisted policy tampering", async () => {
  await withArtifact(async (artifactRoot) => {
    const saved = await saveImageAnnotations(
      {
        imageId: IMAGE_ID,
        items: [{ id: "mask-1", type: "mask", mode: "protect", brushRadius: 0.1, points: [{ x: 0.5, y: 0.5 }] }],
      },
      { artifactRoot },
    );
    assert.equal(saved.maskPolicy.policySha256, policySha256(saved.maskPolicy));

    const recordPath = path.join(artifactRoot, "annotations", saved.id, "annotation.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.maskPolicy = Object.fromEntries(Object.entries(record.maskPolicy).reverse());
    await writeFile(recordPath, JSON.stringify(record));
    await assert.doesNotReject(readImageAnnotation(saved.id, { artifactRoot }));

    record.maskPolicy.strategy = "edit-only";
    await writeFile(recordPath, JSON.stringify(record));
    await assert.rejects(
      readImageAnnotation(saved.id, { artifactRoot }),
      /mask policy hash mismatch/,
    );
  }, { width: 10, height: 8 });
});

test("a saved annotation can be read with validated internal derivative paths", async () => {
  await withArtifact(async (artifactRoot) => {
    const saved = await saveImageAnnotations(
      {
        imageId: IMAGE_ID,
        items: [{ id: "mask-1", type: "mask", mode: "edit", brushRadius: 0.1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], text: "Replace this area" }],
      },
      { artifactRoot },
    );

    const annotation = await readImageAnnotation(saved.id, { artifactRoot });
    assert.equal(annotation.id, saved.id);
    assert.equal(annotation.imageId, IMAGE_ID);
    assert.deepEqual(annotation.items.map((item) => item.id), ["mask-1"]);
    assert.equal(annotation.maskPath, path.join(artifactRoot, "annotations", saved.id, "mask.png"));
    assert.equal(annotation.previewPath, path.join(artifactRoot, "annotations", saved.id, "preview.svg"));
    assert.deepEqual(annotation.maskPolicy, saved.maskPolicy);
  });
});

test("legacy mask records remain readable without inferring a mask policy", async () => {
  await withArtifact(async (artifactRoot) => {
    const saved = await saveImageAnnotations(
      {
        imageId: IMAGE_ID,
        items: [{ id: "mask-1", type: "mask", mode: "edit", brushRadius: 0.1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
      },
      { artifactRoot },
    );
    const recordPath = path.join(artifactRoot, "annotations", saved.id, "annotation.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    delete record.maskPolicy;
    await writeFile(recordPath, JSON.stringify(record));

    const annotation = await readImageAnnotation(saved.id, { artifactRoot });
    assert.equal(annotation.maskFile, "mask.png");
    assert.equal(annotation.maskPolicy, null);
  });
});

function decodeAlpha(mask) {
  const width = mask.readUInt32BE(16);
  const height = mask.readUInt32BE(20);
  const chunks = [];
  let offset = 8;
  while (offset < mask.length) {
    const length = mask.readUInt32BE(offset);
    const type = mask.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") chunks.push(mask.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const rows = inflateSync(Buffer.concat(chunks));
  const alpha = [];
  for (let y = 0; y < height; y += 1) {
    assert.equal(rows[y * (width * 4 + 1)], 0);
    for (let x = 0; x < width; x += 1) alpha.push(rows[y * (width * 4 + 1) + 1 + x * 4 + 3]);
  }
  return alpha;
}

function bruteForceEditAlpha({ width, height, brushRadius, points }) {
  const pixelPoints = points.map((point) => ({ x: point.x * (width - 1), y: point.y * (height - 1) }));
  const segments = pixelPoints.slice(1).map((end, index) => ({ start: pixelPoints[index], end }));
  const radius = brushRadius * Math.min(width, height);
  const feather = Math.max(1, radius * 0.35);
  const outerRadius = radius + feather;
  return Array.from({ length: width * height }, (_, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const distance = Math.min(...segments.map((segment) => pointToSegmentDistance(x, y, segment.start, segment.end)));
    if (distance >= outerRadius) return 255;
    const coverage = distance <= radius ? 1 : (outerRadius - distance) / feather;
    return 255 - Math.round(coverage * 255);
  });
}

function pointToSegmentDistance(x, y, start, end) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = (deltaX * deltaX) + (deltaY * deltaY);
  const position = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, (((x - start.x) * deltaX) + ((y - start.y) * deltaY)) / lengthSquared));
  return Math.hypot(x - (start.x + (position * deltaX)), y - (start.y + (position * deltaY)));
}

function policySha256(policy) {
  const unsignedPolicy = { ...policy };
  delete unsignedPolicy.policySha256;
  return createHash("sha256").update(canonicalJson(unsignedPolicy)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function withArtifact(callback, { width = 1, height = 1 } = {}) {
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-annotations-"));
  const imageRoot = path.join(artifactRoot, "artifacts", IMAGE_ID);
  await mkdir(imageRoot, { recursive: true });
  const entry = {
    id: IMAGE_ID,
    parentIds: [],
    mimeType: "image/png",
    width,
    height,
    provider: "test",
    model: "gpt-image-2",
    operation: "generate",
    prompt: "fixture",
    parameters: {},
    annotationId: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    imageFile: "image.png",
  };
  await writeFile(path.join(imageRoot, "image.png"), Buffer.from(PNG_BASE64, "base64"));
  await writeFile(path.join(imageRoot, "meta.json"), JSON.stringify(entry));
  await writeFile(
    path.join(artifactRoot, "index.json"),
    JSON.stringify({ version: 1, artifacts: { [IMAGE_ID]: entry } }),
  );
  try {
    await callback(artifactRoot);
  } finally {
    await rm(artifactRoot, { recursive: true });
  }
}
