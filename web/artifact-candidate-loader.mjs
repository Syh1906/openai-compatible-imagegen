import { ArtifactHydrationError, hydrateResultArtifacts } from "./result-state.mjs";

export function createArtifactCandidateLoader({ app, records }) {
  async function hydrate(metadata) {
    if (!metadata?.id) {
      throw new ArtifactHydrationError("artifact_payload_invalid", "MCP artifact metadata is invalid");
    }
    const [artifact] = await hydrateResultArtifacts(app, [metadata]);
    return artifact;
  }

  async function load(imageId) {
    return hydrate({ id: imageId });
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
