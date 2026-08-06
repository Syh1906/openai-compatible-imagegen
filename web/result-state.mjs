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
    const privatePayload = result?._meta?.widgetData;
    if (
      publicPayload?.id !== artifact.id
      || privatePayload?.id !== artifact.id
      || typeof privatePayload?.dataBase64 !== "string"
      || !privatePayload.dataBase64
    ) {
      throw new ArtifactHydrationError("artifact_payload_invalid", "MCP image data payload is invalid");
    }
    return {
      ...artifact,
      mimeType: privatePayload.mimeType || publicPayload.mimeType || artifact.mimeType || "image/png",
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

export function artifactLineage(artifact) {
  const parentId = Array.isArray(artifact?.parentIds) ? artifact.parentIds[0] : null;
  const childIds = Array.isArray(artifact?.childIds) ? artifact.childIds : [];
  return {
    parent: parentId ? { id: parentId } : null,
    children: childIds.filter((id) => id && id !== artifact?.id).map((id) => ({ id })),
  };
}
