const IMAGE_ID_PATTERN = /^img_[0-9A-HJKMNP-TV-Z]{26}$/;

export function extractResultInputImageIds(input) {
  const imageIds = input?.arguments?.imageIds;
  if (
    !Array.isArray(imageIds)
    || imageIds.length < 1
    || imageIds.length > 10
    || !imageIds.every((imageId) => typeof imageId === "string" && IMAGE_ID_PATTERN.test(imageId))
    || new Set(imageIds).size !== imageIds.length
  ) return [];
  return [...imageIds];
}

export function extractResultArtifacts(result) {
  const structured = result?.structuredContent || {};
  const metadata = Array.isArray(structured.artifacts) && structured.artifacts.length
    ? structured.artifacts
    : structured.artifact
      ? [structured.artifact]
      : [];

  return metadata
    .map((item) => item?.id ? { ...item } : null)
    .filter(Boolean);
}

export async function hydrateResultArtifacts(app, artifacts) {
  if (typeof app?.callServerTool !== "function") {
    throw new ArtifactHydrationError("artifact_bridge_unavailable", "MCP tool bridge is unavailable");
  }
  return await Promise.all(artifacts.map(async (artifact) => {
    if (!artifact.id) throw new Error("missing image artifact ID");
    let result;
    try {
      result = await app.callServerTool({
        name: "read_image_artifact_data",
        arguments: { imageId: artifact.id },
      });
    } catch (cause) {
      throw new ArtifactHydrationError("artifact_tool_call_failed", "MCP image data call failed", { cause });
    }
    if (result?.isError) {
      throw new ArtifactHydrationError("artifact_server_error", "MCP image data tool returned an error");
    }
    const publicPayload = result?.structuredContent;
    const publicArtifact = publicPayload?.artifact;
    const privatePayload = result?._meta?.widgetData;
    const publicMimeType = publicArtifact?.mimeType;
    if (
      publicArtifact?.id !== artifact.id
      || privatePayload?.id !== artifact.id
      || !["image/png", "image/jpeg", "image/webp"].includes(publicMimeType)
      || privatePayload?.mimeType !== publicMimeType
      || !["available", "destroyed"].includes(publicPayload?.canvasStatus)
      || typeof privatePayload?.dataBase64 !== "string"
      || !privatePayload.dataBase64
    ) {
      throw new ArtifactHydrationError("artifact_payload_invalid", "MCP image data payload is invalid");
    }
    return {
      ...artifact,
      ...publicArtifact,
      canvasStatus: publicPayload.canvasStatus,
      mimeType: publicMimeType,
      data: privatePayload.dataBase64,
    };
  }));
}

export class ArtifactHydrationError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ArtifactHydrationError";
    this.code = code;
  }
}

export function toImageUrl(image) {
  return image?.data ? `data:${image.mimeType || "image/png"};base64,${image.data}` : "";
}

export function artifactLineage(artifact, records = null) {
  return artifactLineageWithRecords(artifact, records);
}

export function artifactLineageWithRecords(artifact, records = null) {
  const parentId = Array.isArray(artifact?.parentIds) ? artifact.parentIds[0] : null;
  const childIds = Array.isArray(artifact?.childIds) ? artifact.childIds : [];
  const resolve = (id) => {
    if (!id) return null;
    const record = typeof records?.get === "function" ? records.get(id) : records?.[id];
    return record ? { ...record, id } : { id };
  };
  return {
    parent: parentId ? resolve(parentId) : null,
    children: childIds.filter((id) => id && id !== artifact?.id).map(resolve).filter(Boolean),
  };
}

export function artifactLineageImageIds(artifact) {
  const parentId = Array.isArray(artifact?.parentIds) ? artifact.parentIds[0] : null;
  const childIds = Array.isArray(artifact?.childIds) ? artifact.childIds : [];
  return [...new Set([parentId, artifact?.id, ...childIds].filter(Boolean))];
}

export function lineageSeedFor(imageId, lineage = []) {
  if (!imageId) return { id: "" };
  return {
    id: imageId,
    parentIds: lineage.filter((item) => item.role === "parent").map((item) => item.id),
    childIds: lineage.filter((item) => item.role === "child").map((item) => item.id),
  };
}

export function mergeLineageRecords(previous, next, currentId) {
  const byId = new Map();
  for (const item of [...previous, ...next]) {
    if (!item?.id) continue;
    const existing = byId.get(item.id);
    const merged = {
      ...existing,
      ...item,
      role: item.id === currentId ? "current" : (item.role || existing?.role || "child"),
    };
    if (item.loadState === "loading" || item.data) delete merged.loadError;
    byId.set(item.id, merged);
  }
  const previousIsCurrentPlaceholder = previous.length === 1
    && previous[0]?.id === currentId
    && next.length > 1;
  const orderSource = previousIsCurrentPlaceholder ? [...next, ...previous] : [...previous, ...next];
  const order = orderSource.map((item) => item?.id)
    .filter((id, index, ids) => id && ids.indexOf(id) === index);
  return order.map((id) => byId.get(id)).filter(Boolean).map((item) => ({
    ...item,
    role: item.id === currentId ? "current" : item.role === "current" ? "child" : item.role,
  }));
}
