import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { readImageArtifact } from "./artifact-repository.mjs";


const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ANNOTATION_ID_PATTERN = /^ann_[0-9A-HJKMNP-TV-Z]{26}$/;

export async function saveImageAnnotations({ imageId, items }, { projectRoot } = {}) {
  if (!Array.isArray(items) || items.length === 0) throw new Error("at least one annotation is required");
  const resolvedProjectRoot = requireProjectRoot(projectRoot);
  const artifact = await readImageArtifact(imageId, { projectRoot: resolvedProjectRoot });
  const dataRoot = path.join(resolvedProjectRoot, "output", "imagegen");
  const annotationsRoot = path.join(dataRoot, "annotations");
  await mkdir(annotationsRoot, { recursive: true });
  await rejectLinksBetween(dataRoot, annotationsRoot);

  const annotationId = newAnnotationId();
  const annotationRoot = path.join(annotationsRoot, annotationId);
  await mkdir(annotationRoot);
  try {
    const previewFile = "preview.svg";
    const maskItems = items.filter((item) => item.type === "mask");
    const maskFile = maskItems.length ? "mask.png" : null;
    const preview = buildPreview(artifact, items);
    await writeFile(path.join(annotationRoot, previewFile), preview, { encoding: "utf8", flag: "wx" });
    if (maskFile) {
      const mask = buildMaskPng(artifact.metadata.width, artifact.metadata.height, maskItems);
      await writeFile(path.join(annotationRoot, maskFile), mask, { flag: "wx" });
    }

    const record = {
      id: annotationId,
      imageId,
      items,
      previewFile,
      previewMimeType: "image/svg+xml",
      maskFile,
      maskMimeType: maskFile ? "image/png" : null,
      createdAt: new Date().toISOString(),
    };
    const tempPath = path.join(annotationRoot, "annotation.json.tmp");
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, path.join(annotationRoot, "annotation.json"));
    return {
      id: annotationId,
      imageId,
      itemCount: items.length,
      previewMimeType: record.previewMimeType,
      hasMask: Boolean(maskFile),
      maskMimeType: record.maskMimeType,
    };
  } catch (error) {
    await rm(annotationRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function readImageAnnotation(annotationId, { projectRoot } = {}) {
  if (!ANNOTATION_ID_PATTERN.test(annotationId)) throw new Error(`invalid annotation ID: ${annotationId}`);
  const resolvedProjectRoot = requireProjectRoot(projectRoot);
  try {
    const dataRoot = path.join(resolvedProjectRoot, "output", "imagegen");
    const annotationRoot = path.join(dataRoot, "annotations", annotationId);
    const recordPath = path.join(annotationRoot, "annotation.json");
    await rejectLinksBetween(dataRoot, recordPath);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    if (record?.id !== annotationId || typeof record.imageId !== "string" || !Array.isArray(record.items)) {
      throw new Error(`annotation record is invalid: ${annotationId}`);
    }
    const previewPath = await resolveDerivativePath(dataRoot, annotationRoot, record.previewFile, annotationId, "preview");
    const maskPath = record.maskFile
      ? await resolveDerivativePath(dataRoot, annotationRoot, record.maskFile, annotationId, "mask")
      : null;
    return { ...record, previewPath, maskPath };
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`annotation not found: ${annotationId}`);
    if (error instanceof SyntaxError) throw new Error(`annotation record is not valid JSON: ${annotationId}`);
    throw error;
  }
}


function requireProjectRoot(projectRoot) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw new Error("project root is required");
  }
  return path.resolve(projectRoot);
}

async function resolveDerivativePath(dataRoot, annotationRoot, fileName, annotationId, label) {
  if (typeof fileName !== "string" || path.basename(fileName) !== fileName) {
    throw new Error(`annotation has invalid ${label} file: ${annotationId}`);
  }
  const derivativePath = path.join(annotationRoot, fileName);
  await rejectLinksBetween(dataRoot, derivativePath);
  return derivativePath;
}

function buildPreview(artifact, items) {
  const { width, height, mimeType } = artifact.metadata;
  const overlays = items.map((item, index) => annotationSvg(item, width, height, index)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<image href="data:${mimeType};base64,${artifact.data}" width="${width}" height="${height}"/>`
    + overlays
    + "</svg>";
}

function annotationSvg(item, width, height, index) {
  const stroke = annotationColor(item.color);
  const strokeWidth = annotationStrokeWidth(item.strokeWidth, width, height);
  const anchorX = labelX(item, width);
  const anchorY = labelY(item, height);
  const badgeRadius = Math.max(9, Math.round(Math.min(width, height) * 0.018));
  const badge = `<g class="annotation-index"><circle cx="${anchorX}" cy="${anchorY}" r="${badgeRadius}" fill="#ffffff" stroke="#17191d" stroke-width="2"/><text x="${anchorX}" y="${anchorY + Math.round(badgeRadius * 0.38)}" fill="#17191d" font-size="${Math.max(12, Math.round(badgeRadius * 1.05))}" font-family="sans-serif" font-weight="700" text-anchor="middle">${index + 1}</text></g>`;
  const label = item.text ? `<text x="${anchorX + badgeRadius + 5}" y="${anchorY}" fill="${stroke}" font-size="${Math.max(14, Math.round(height * 0.025))}">${escapeXml(item.text)}</text>` : "";
  if (item.type === "arrow") {
    const markerId = `arrowhead-${index}`;
    return `<defs><marker id="${markerId}" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="${stroke}"/></marker></defs><line x1="${item.from.x * width}" y1="${item.from.y * height}" x2="${item.to.x * width}" y2="${item.to.y * height}" stroke="${stroke}" stroke-width="${strokeWidth}" marker-end="url(#${markerId})"/>${badge}${label}`;
  }
  if (item.type === "rectangle") {
    return `<rect x="${item.x * width}" y="${item.y * height}" width="${item.width * width}" height="${item.height * height}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"/>${badge}${label}`;
  }
  if (item.type === "text") return `${badge}${label}`;
  const points = item.points.map((point) => `${point.x * width},${point.y * height}`).join(" ");
  const opacity = item.type === "mask" ? "0.55" : "1";
  const pathStrokeWidth = item.type === "mask" ? Math.max(strokeWidth, Math.round(Math.min(width, height) * 0.03)) : strokeWidth;
  return `<polyline points="${points}" fill="none" stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="${pathStrokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>${badge}${label}`;
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
  const pixels = Buffer.alloc(width * height);
  for (const item of items) {
    const normalizedWidth = Math.max(24, Math.max(1, Math.min(12, Number(item.strokeWidth) || 5)) * 5);
    const radius = Math.max(1, Math.round((Math.min(width, height) * normalizedWidth) / 2000));
    for (let index = 1; index < item.points.length; index += 1) {
      const start = item.points[index - 1];
      const end = item.points[index];
      drawLine(
        pixels,
        width,
        height,
        Math.round(start.x * (width - 1)),
        Math.round(start.y * (height - 1)),
        Math.round(end.x * (width - 1)),
        Math.round(end.y * (height - 1)),
        radius,
      );
    }
  }
  const rowLength = width * 4 + 1;
  const rows = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * rowLength + 1 + x * 4;
      rows[offset] = 255;
      rows[offset + 1] = 255;
      rows[offset + 2] = 255;
      rows[offset + 3] = 255 - pixels[y * width + x];
    }
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr(width, height)),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawLine(pixels, width, height, startX, startY, endX, endY, radius) {
  const steps = Math.max(Math.abs(endX - startX), Math.abs(endY - startY), 1);
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(startX + ((endX - startX) * step) / steps);
    const y = Math.round(startY + ((endY - startY) * step) / steps);
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        if (offsetX * offsetX + offsetY * offsetY > radius * radius) continue;
        const targetX = x + offsetX;
        const targetY = y + offsetY;
        if (targetX >= 0 && targetX < width && targetY >= 0 && targetY < height) pixels[targetY * width + targetX] = 255;
      }
    }
  }
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

async function rejectLinksBetween(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("annotation path escapes the project data root");
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`annotation path contains a reparse point: ${path.basename(current)}`);
  }
}
