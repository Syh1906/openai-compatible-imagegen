import { createHash } from "node:crypto";


export const RELEASE_IDENTITY_META_NAME = "openai-compatible-imagegen-release";
export const RELEASE_IDENTITY_PLACEHOLDER = "    <!-- RELEASE_IDENTITY -->";


export function createReleaseBundle({ pluginId, pluginVersion, serverBuildInputs, widgetHtml }) {
  requireText(pluginId, "pluginId");
  requireText(pluginVersion, "pluginVersion");
  requireText(widgetHtml, "widgetHtml");
  if (!Array.isArray(serverBuildInputs) || serverBuildInputs.length === 0) {
    throw new Error("serverBuildInputs must contain at least one build input");
  }
  if (countOccurrences(widgetHtml, RELEASE_IDENTITY_PLACEHOLDER) !== 1) {
    throw new Error("widgetHtml must contain exactly one release identity placeholder");
  }

  const serverBuildDigest = digestBuildInputs(serverBuildInputs);
  const widgetAssetDigest = sha256(widgetHtml);
  const fingerprint = sha256(JSON.stringify([
    pluginId,
    pluginVersion,
    serverBuildDigest,
    widgetAssetDigest,
  ])).slice(0, 20);
  const resourceUris = Object.freeze({
    result: `ui://${pluginId}/result.html`,
    editor: `ui://${pluginId}/editor.html`,
  });
  const releaseIdentity = Object.freeze({
    pluginId,
    pluginVersion,
    serverBuildDigest,
    widgetAssetDigest,
    fingerprint,
    resourceUris,
  });
  const marker = `    <meta name="${RELEASE_IDENTITY_META_NAME}" content="${fingerprint}">`;

  return {
    releaseIdentity,
    widgetHtml: widgetHtml.replace(RELEASE_IDENTITY_PLACEHOLDER, marker),
  };
}


function digestBuildInputs(inputs) {
  const normalized = inputs.map((input) => {
    if (!input || typeof input !== "object") {
      throw new Error("each server build input must be an object");
    }
    requireText(input.path, "serverBuildInputs[].path");
    const content = typeof input.content === "string"
      ? Buffer.from(input.content, "utf8")
      : Buffer.from(input.content ?? []);
    return { path: input.path.replaceAll("\\", "/"), content };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const paths = normalized.map((input) => input.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("serverBuildInputs paths must be unique");
  }

  const hash = createHash("sha256");
  for (const input of normalized) {
    hash.update(`${Buffer.byteLength(input.path, "utf8")}:`);
    hash.update(input.path, "utf8");
    hash.update(`${input.content.byteLength}:`);
    hash.update(input.content);
  }
  return hash.digest("hex");
}


function requireText(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}


function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}


function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
