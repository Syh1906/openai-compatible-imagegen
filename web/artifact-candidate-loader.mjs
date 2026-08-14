import { ArtifactHydrationError, extractResultArtifacts, hydrateResultArtifacts } from "./result-state.mjs";

export function createArtifactCandidateLoader({ app, records }) {
  async function hydrate(metadata) {
    if (!metadata?.id) {
      throw new ArtifactHydrationError("artifact_payload_invalid", "MCP artifact metadata is invalid");
    }
    const [artifact] = await hydrateResultArtifacts(app, [metadata]);
    return artifact;
  }

  async function load(imageId) {
    const result = await app.callServerTool({ name: "get_image_artifact", arguments: { imageId } });
    if (result.isError) {
      throw new ArtifactHydrationError("artifact_server_error", "MCP artifact tool returned an error");
    }
    const metadata = {
      ...extractResultArtifacts(result)[0],
      canvasStatus: result?.structuredContent?.canvasStatus || "available",
    };
    if (metadata.id !== imageId) {
      throw new ArtifactHydrationError("artifact_payload_invalid", "MCP artifact ID does not match the requested image");
    }
    return hydrate(metadata);
  }

  function start(imageId, metadata = null) {
    const cached = records.get(imageId);
    if (cached?.data && cached.loadState === "ready") {
      return { attempt: null, load: Promise.resolve(cached) };
    }
    return {
      attempt: records.begin(imageId),
      load: metadata ? hydrate(metadata) : load(imageId),
    };
  }

  return { start };
}
