import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { readImageArtifact } from "./artifact-repository.mjs";
import { runRepositoryFsOperation } from "./repository-fs-client.mjs";


const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ANNOTATION_ID_PATTERN = /^ann_[0-9A-HJKMNP-TV-Z]{26}$/;
const MIN_MASK_BRUSH_RADIUS = 0.001;
const MAX_MASK_POINTS = 4096;
const MAX_MASK_PIXELS = 4096 * 4096;
const MAX_MASK_RASTER_PASSES = 16;
const MAX_MASK_RASTER_WORK = 32_000_000;
const MASK_SEGMENT_LEAF_SIZE = 8;
const MASK_RASTER_TILE_SIZE = 64;

export async function saveImageAnnotations({ imageId, items }, {
  artifactRoot,
  modelProfileId = undefined,
  activeProfile = "primary/gpt-image-2",
  runRepositoryOperation = runRepositoryFsOperation,
} = {}) {
  if (!Array.isArray(items) || items.length === 0) throw new Error("at least one annotation is required");
  const dataRoot = requireArtifactRoot(artifactRoot);
  const artifact = await readImageArtifact(imageId, { artifactRoot: dataRoot });
  validateMaskItems(items);
  const annotationId = newAnnotationId();
  const previewFile = "preview.svg";
  const maskItems = items.filter((item) => item.type === "mask");
  const maskFile = maskItems.length ? "mask.png" : null;
  let maskPolicy = null;
  const preview = buildPreview(artifact, items);
  let mask = null;
  if (maskFile) {
      mask = buildMaskPng(artifact.metadata.width, artifact.metadata.height, maskItems);
      const strategy = maskStrategy(maskItems);
      const unsignedPolicy = {
        policyVersion: "mask-policy-v2",
        modelProfileId: modelProfileId || activeProfile,
        requiredCapabilities: { mask: true },
        strategy,
        parentImageId: imageId,
        annotationId,
        width: artifact.metadata.width,
        height: artifact.metadata.height,
        masks: maskItems.map((item) => ({
          id: item.id,
          mode: item.mode,
          operation: item.operation || "paint",
          radiusPx: maskRadiusPx(item, artifact.metadata.width, artifact.metadata.height),
        })),
        hardBoundary: {
          source: strategy === "protect-only" ? "none" : "edit-strokes",
          postprocess: strategy === "protect-only" ? "none" : "parent-blend",
        },
        semanticProtection: {
          enabled: strategy !== "edit-only",
          source: "protect-strokes",
          preserve: ["identity", "geometry", "text", "texture"],
          allowAdaptation: ["lighting", "shadow", "tone"],
        },
        transitionBand: { kind: "outer-feather", featherRatio: 0.35, minimumWidthPx: 1 },
        maskSha256: createHash("sha256").update(mask).digest("hex"),
      };
      maskPolicy = Object.freeze({ ...unsignedPolicy, policySha256: sha256CanonicalJson(unsignedPolicy) });
  }

  const record = {
      id: annotationId,
      imageId,
      items,
      previewFile,
      previewMimeType: "image/svg+xml",
      maskFile,
      maskMimeType: maskFile ? "image/png" : null,
      maskPolicy,
      createdAt: new Date().toISOString(),
  };
  await runRepositoryOperation({
    operation: "save-annotation-files",
    artifactRoot: dataRoot,
    annotationId,
    previewBase64: Buffer.from(preview, "utf8").toString("base64"),
    maskBase64: mask ? mask.toString("base64") : null,
    record,
  });
  return {
      id: annotationId,
      imageId,
      itemCount: items.length,
      previewMimeType: record.previewMimeType,
      hasMask: Boolean(maskFile),
      maskMimeType: record.maskMimeType,
      maskPolicy,
  }
}

export async function readImageAnnotation(annotationId, {
  artifactRoot,
  runRepositoryOperation = runRepositoryFsOperation,
} = {}) {
  if (!ANNOTATION_ID_PATTERN.test(annotationId)) throw new Error(`invalid annotation ID: ${annotationId}`);
  const dataRoot = requireArtifactRoot(artifactRoot);
  try {
    const record = await runRepositoryOperation({
      operation: "read-annotation",
      artifactRoot: dataRoot,
      annotationId,
    });
    if (record?.id !== annotationId || typeof record.imageId !== "string" || !Array.isArray(record.items)) {
      throw new Error(`annotation record is invalid: ${annotationId}`);
    }
    const previewPath = path.join(dataRoot, "annotations", annotationId, record.previewFile);
    const maskPath = record.maskFile ? path.join(dataRoot, "annotations", annotationId, record.maskFile) : null;
    validateMaskPolicyHash(record.maskPolicy, annotationId);
    return { ...record, maskPolicy: record.maskPolicy ?? null, previewPath, maskPath };
  } catch (error) {
    if (error?.code === "ENOENT" || /repository entry not found/i.test(error?.message || "")) {
      throw new Error(`annotation not found: ${annotationId}`);
    }
    if (error instanceof SyntaxError) throw new Error(`annotation record is not valid JSON: ${annotationId}`);
    throw error;
  }
}

export async function deleteImageAnnotation(annotationId, {
  artifactRoot,
  runRepositoryOperation = runRepositoryFsOperation,
} = {}) {
  if (!ANNOTATION_ID_PATTERN.test(annotationId)) throw new Error(`invalid annotation ID: ${annotationId}`);
  const dataRoot = requireArtifactRoot(artifactRoot);
  await runRepositoryOperation({
    operation: "delete-annotation",
    artifactRoot: dataRoot,
    annotationId,
  });
}


function requireArtifactRoot(artifactRoot) {
  if (typeof artifactRoot !== "string" || !path.isAbsolute(artifactRoot)) {
    throw new Error("artifact root is required");
  }
  return path.resolve(artifactRoot);
}

function validateMaskItems(items) {
  const maskIds = new Set();
  for (const item of items) {
    if (item.type !== "mask") continue;
    if (maskIds.has(item.id)) throw new Error("mask annotation IDs must be unique");
    maskIds.add(item.id);
    if (item.mode !== "edit" && item.mode !== "protect") {
      throw new Error("mask mode must be edit or protect");
    }
    if (item.operation !== undefined && item.operation !== "paint" && item.operation !== "erase") {
      throw new Error("mask operation must be paint or erase");
    }
    if (!Number.isFinite(item.brushRadius) || item.brushRadius < MIN_MASK_BRUSH_RADIUS || item.brushRadius > 0.5) {
      throw new Error("mask brushRadius must be a normalized number from 0.001 to 0.5");
    }
    if (!Array.isArray(item.points) || item.points.length === 0 || item.points.length > MAX_MASK_POINTS) {
      throw new Error(`mask points must contain between 1 and ${MAX_MASK_POINTS} entries`);
    }
  }
}

function maskStrategy(items) {
  const paintedModes = maskPaintModes(items);
  const hasEdit = paintedModes.has("edit");
  const hasProtect = paintedModes.has("protect");
  if (hasEdit && hasProtect) return "mixed";
  return hasEdit ? "edit-only" : "protect-only";
}

function maskPaintModes(items) {
  const paintedModes = new Set(
    items
      .filter((item) => (item.operation || "paint") === "paint")
      .map((item) => item.mode),
  );
  if (!paintedModes.size) throw new Error("mask annotations must include at least one paint stroke");
  return paintedModes;
}

function maskRadiusPx(item, width, height) {
  return Number((item.brushRadius * Math.min(width, height)).toFixed(6));
}

function validateMaskPolicyHash(policy, annotationId) {
  if (policy == null) return;
  if (typeof policy !== "object" || typeof policy.policySha256 !== "string") {
    throw new Error(`annotation mask policy hash mismatch: ${annotationId}`);
  }
  const { policySha256, ...unsignedPolicy } = policy;
  if (policySha256 !== sha256CanonicalJson(unsignedPolicy)) {
    throw new Error(`annotation mask policy hash mismatch: ${annotationId}`);
  }
}

function sha256CanonicalJson(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildPreview(artifact, items) {
  const { width, height, mimeType } = artifact.metadata;
  const maskOverlay = maskPreviewOverlay(items.filter((item) => item.type === "mask"), width, height);
  const overlays = items.map((item, index) => annotationSvg(item, width, height, index)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<image href="data:${mimeType};base64,${artifact.data}" width="${width}" height="${height}"/>`
    + maskOverlay + overlays
    + "</svg>";
}

function annotationSvg(item, width, height, index) {
  const stroke = item.type === "mask" && !item.color
    ? (item.mode === "protect" ? "#2563eb" : "#ef4444")
    : annotationColor(item.color);
  const strokeWidth = annotationStrokeWidth(item.strokeWidth, width, height);
  const anchorX = labelX(item, width);
  const anchorY = labelY(item, height);
  const badgeRadius = Math.max(9, Math.round(Math.min(width, height) * 0.018));
  const badge = `<g class="annotation-index"><circle cx="${anchorX}" cy="${anchorY}" r="${badgeRadius}" fill="#ffffff" stroke="#17191d" stroke-width="2"/><text x="${anchorX}" y="${anchorY + Math.round(badgeRadius * 0.38)}" fill="#17191d" font-size="${Math.max(12, Math.round(badgeRadius * 1.05))}" font-family="sans-serif" font-weight="700" text-anchor="middle">${index + 1}</text></g>`;
  const label = item.text ? `<text x="${anchorX + badgeRadius + 5}" y="${anchorY}" fill="${stroke}" font-size="${Math.max(14, Math.round(height * 0.025))}">${escapeXml(item.text)}</text>` : "";
  if (item.type === "mask") return `${badge}${label}`;
  if (item.type === "arrow") {
    const markerId = `arrowhead-${index}`;
    return `<defs><marker id="${markerId}" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="${stroke}"/></marker></defs><line x1="${item.from.x * width}" y1="${item.from.y * height}" x2="${item.to.x * width}" y2="${item.to.y * height}" stroke="${stroke}" stroke-width="${strokeWidth}" marker-end="url(#${markerId})"/>${badge}${label}`;
  }
  if (item.type === "rectangle") {
    return `<rect x="${item.x * width}" y="${item.y * height}" width="${item.width * width}" height="${item.height * height}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"/>${badge}${label}`;
  }
  if (item.type === "text") return `${badge}${label}`;
  const points = item.points.map((point) => `${point.x * width},${point.y * height}`).join(" ");
  return `<polyline points="${points}" fill="none" stroke="${stroke}" stroke-opacity="1" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>${badge}${label}`;
}

function maskPreviewOverlay(items, width, height) {
  return ["edit", "protect"].map((mode) => {
    const strokes = items.filter((item) => item.mode === mode);
    if (!strokes.length) return "";
    const maskId = `annotation-preview-mask-${mode}`;
    const paths = strokes.map((item) => {
      const points = item.points.map((point) => `${point.x * width},${point.y * height}`).join(" ");
      const stroke = (item.operation || "paint") === "erase" ? "#000000" : "#ffffff";
      const strokeWidth = Math.max(1, item.brushRadius * Math.min(width, height) * 2);
      return `<polyline data-mask-operation="${item.operation || "paint"}" points="${points}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }).join("");
    const fill = mode === "protect" ? "#2563eb" : "#ef4444";
    return `<defs><mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#000000"/>${paths}</mask></defs><rect data-mask-layer="${mode}" width="${width}" height="${height}" fill="${fill}" fill-opacity="0.55" mask="url(#${maskId})"/>`;
  }).join("");
}

function labelX(item, width) {
  if (item.type === "arrow") return item.from.x * width;
  if (typeof item.x === "number") return item.x * width;
  return item.points?.[0]?.x * width || 0;
}

function labelY(item, height) {
  if (item.type === "arrow") return item.from.y * height;
  if (typeof item.y === "number") return item.y * height;
  return item.points?.[0]?.y * height || 0;
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function annotationColor(value) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || "")) ? String(value) : "#ef4444";
}

function annotationStrokeWidth(value, width, height) {
  const normalized = Math.max(1, Math.min(12, Number(value) || 5));
  return Math.max(1, Math.round((normalized * Math.min(width, height)) / 1000));
}

function buildMaskPng(width, height, items) {
  const paintedModes = maskPaintModes(items);
  const rasterItems = paintedModes.has("edit") ? items.filter((item) => item.mode === "edit") : [];
  const rasterBudget = createMaskRasterBudget(width, height);
  const editAlpha = Buffer.alloc(width * height, paintedModes.has("edit") ? 255 : 0);
  for (const item of rasterItems) {
    drawFeatheredPath(editAlpha, width, height, item, rasterBudget);
  }
  const rowLength = width * 4 + 1;
  const rows = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * rowLength + 1 + x * 4;
      rows[offset] = 255;
      rows[offset + 1] = 255;
      rows[offset + 2] = 255;
      rows[offset + 3] = editAlpha[y * width + x];
    }
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr(width, height)),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createMaskRasterBudget(width, height) {
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_MASK_PIXELS) {
    throw new Error("mask pixel budget exceeded");
  }
  return { used: 0, limit: Math.min(pixelCount * MAX_MASK_RASTER_PASSES, MAX_MASK_RASTER_WORK) };
}

function spendMaskRasterWork(budget, amount = 1) {
  budget.used += amount;
  if (budget.used > budget.limit) throw new Error("mask raster work budget exceeded");
}

function drawFeatheredPath(pixels, width, height, item, budget) {
  const radius = maskRadiusPx(item, width, height);
  const feather = Math.max(1, radius * 0.35);
  const outerRadius = radius + feather;
  const segments = maskPathSegments(item.points, width, height);
  const segmentIndex = buildMaskSegmentIndex(segments);
  const { tiles, tileColumns } = maskRasterTiles(segments, width, height, outerRadius, budget);
  const radiusSquared = radius * radius;
  const outerRadiusSquared = outerRadius * outerRadius;
  for (const tileIndex of tiles) {
    const tileX = tileIndex % tileColumns;
    const tileY = Math.floor(tileIndex / tileColumns);
    const minX = tileX * MASK_RASTER_TILE_SIZE;
    const minY = tileY * MASK_RASTER_TILE_SIZE;
    const maxX = Math.min(width, minX + MASK_RASTER_TILE_SIZE);
    const maxY = Math.min(height, minY + MASK_RASTER_TILE_SIZE);
    for (let y = minY; y < maxY; y += 1) {
      for (let x = minX; x < maxX; x += 1) {
        const distanceSquared = nearestPathDistanceSquared(
          segmentIndex,
          x,
          y,
          radiusSquared,
          outerRadiusSquared,
          budget,
        );
        if (distanceSquared >= outerRadiusSquared) continue;
        const distance = Math.sqrt(distanceSquared);
        const coverage = distance <= radius ? 1 : (outerRadius - distance) / feather;
        const value = Math.round(coverage * 255);
        const index = y * width + x;
        if (item.mode === "protect") {
          pixels[index] = (item.operation || "paint") === "erase"
            ? Math.min(pixels[index], 255 - value)
            : Math.max(pixels[index], value);
        } else {
          pixels[index] = (item.operation || "paint") === "erase"
            ? Math.max(pixels[index], value)
            : Math.min(pixels[index], 255 - value);
        }
      }
    }
  }
}

function maskPathSegments(points, width, height) {
  const pixelPoints = points.map((point) => ({ x: point.x * (width - 1), y: point.y * (height - 1) }));
  const simplified = [];
  for (const point of pixelPoints) {
    const previous = simplified.at(-1);
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    const beforePrevious = simplified.at(-2);
    if (beforePrevious && collinearForward(beforePrevious, previous, point)) simplified[simplified.length - 1] = point;
    else simplified.push(point);
  }
  if (simplified.length === 1) simplified.push(simplified[0]);
  return simplified.slice(1).map((end, index) => ({
    startX: simplified[index].x,
    startY: simplified[index].y,
    endX: end.x,
    endY: end.y,
  }));
}

function collinearForward(start, middle, end) {
  const firstX = middle.x - start.x;
  const firstY = middle.y - start.y;
  const secondX = end.x - middle.x;
  const secondY = end.y - middle.y;
  return (firstX * secondY) - (firstY * secondX) === 0 && (firstX * secondX) + (firstY * secondY) >= 0;
}

function maskRasterTiles(segments, width, height, outerRadius, budget) {
  const tileColumns = Math.ceil(width / MASK_RASTER_TILE_SIZE);
  const tileRows = Math.ceil(height / MASK_RASTER_TILE_SIZE);
  const sampleStep = MASK_RASTER_TILE_SIZE / 2;
  const tiles = new Set();
  for (const segment of segments) {
    const length = Math.hypot(segment.endX - segment.startX, segment.endY - segment.startY);
    const steps = Math.max(1, Math.ceil(length / sampleStep));
    const coverageRadius = outerRadius + (length / (2 * steps));
    for (let step = 0; step <= steps; step += 1) {
      const ratio = step / steps;
      const sampleX = segment.startX + ((segment.endX - segment.startX) * ratio);
      const sampleY = segment.startY + ((segment.endY - segment.startY) * ratio);
      const minTileX = Math.max(0, Math.floor((sampleX - coverageRadius) / MASK_RASTER_TILE_SIZE));
      const minTileY = Math.max(0, Math.floor((sampleY - coverageRadius) / MASK_RASTER_TILE_SIZE));
      const maxTileX = Math.min(tileColumns - 1, Math.floor((sampleX + coverageRadius) / MASK_RASTER_TILE_SIZE));
      const maxTileY = Math.min(tileRows - 1, Math.floor((sampleY + coverageRadius) / MASK_RASTER_TILE_SIZE));
      for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
        for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
          spendMaskRasterWork(budget);
          tiles.add((tileY * tileColumns) + tileX);
        }
      }
    }
  }
  return { tiles, tileColumns };
}

function buildMaskSegmentIndex(segments) {
  const indexed = segments.map((segment) => ({
    ...segment,
    minX: Math.min(segment.startX, segment.endX),
    minY: Math.min(segment.startY, segment.endY),
    maxX: Math.max(segment.startX, segment.endX),
    maxY: Math.max(segment.startY, segment.endY),
  }));
  return buildMaskSegmentNode(indexed);
}

function buildMaskSegmentNode(segments) {
  const bounds = segmentBounds(segments);
  if (segments.length <= MASK_SEGMENT_LEAF_SIZE) return { ...bounds, segments };
  const axis = (bounds.maxX - bounds.minX) >= (bounds.maxY - bounds.minY) ? "x" : "y";
  const ordered = [...segments].sort((left, right) => segmentMidpoint(left, axis) - segmentMidpoint(right, axis));
  const middle = Math.floor(ordered.length / 2);
  return {
    ...bounds,
    left: buildMaskSegmentNode(ordered.slice(0, middle)),
    right: buildMaskSegmentNode(ordered.slice(middle)),
  };
}

function segmentBounds(segments) {
  return segments.reduce((bounds, segment) => ({
    minX: Math.min(bounds.minX, segment.minX),
    minY: Math.min(bounds.minY, segment.minY),
    maxX: Math.max(bounds.maxX, segment.maxX),
    maxY: Math.max(bounds.maxY, segment.maxY),
  }), {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  });
}

function segmentMidpoint(segment, axis) {
  return axis === "x"
    ? (segment.startX + segment.endX) / 2
    : (segment.startY + segment.endY) / 2;
}

function nearestPathDistanceSquared(root, x, y, radiusSquared, outerRadiusSquared, budget) {
  let best = outerRadiusSquared;
  const stack = [{ node: root, lowerBound: 0 }];
  while (stack.length) {
    const { node, lowerBound } = stack.pop();
    if (lowerBound >= best) continue;
    if (node.segments) {
      for (const segment of node.segments) {
        spendMaskRasterWork(budget);
        best = Math.min(best, pointToSegmentDistanceSquared(
          x,
          y,
          segment.startX,
          segment.startY,
          segment.endX,
          segment.endY,
        ));
        if (best <= radiusSquared) return radiusSquared;
      }
      continue;
    }
    spendMaskRasterWork(budget);
    const leftBound = pointToBoundsDistanceSquared(x, y, node.left);
    const rightBound = pointToBoundsDistanceSquared(x, y, node.right);
    const nearest = leftBound <= rightBound
      ? [{ node: node.right, lowerBound: rightBound }, { node: node.left, lowerBound: leftBound }]
      : [{ node: node.left, lowerBound: leftBound }, { node: node.right, lowerBound: rightBound }];
    for (const candidate of nearest) {
      if (candidate.lowerBound < best) stack.push(candidate);
    }
  }
  return best;
}

function pointToBoundsDistanceSquared(x, y, bounds) {
  const deltaX = x < bounds.minX ? bounds.minX - x : x > bounds.maxX ? x - bounds.maxX : 0;
  const deltaY = y < bounds.minY ? bounds.minY - y : y > bounds.maxY ? y - bounds.maxY : 0;
  return (deltaX * deltaX) + (deltaY * deltaY);
}

function pointToSegmentDistanceSquared(x, y, startX, startY, endX, endY) {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const position = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((x - startX) * deltaX + (y - startY) * deltaY) / lengthSquared));
  const offsetX = x - (startX + position * deltaX);
  const offsetY = y - (startY + position * deltaY);
  return (offsetX * offsetX) + (offsetY * offsetY);
}

function ihdr(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  return data;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), data.length + 8);
  return chunk;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function newAnnotationId() {
  const value = (BigInt(Date.now()) << 80n) | BigInt(`0x${randomBytes(10).toString("hex")}`);
  let encoded = "";
  for (let shift = 125n; shift >= 0n; shift -= 5n) encoded += CROCKFORD_BASE32[Number((value >> shift) & 31n)];
  return `ann_${encoded}`;
}
