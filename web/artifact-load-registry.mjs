import { ArtifactHydrationError } from "./result-state.mjs";
import { artifactLoadFailure } from "./result-errors.mjs";

export function createArtifactLoadRegistry({ timeoutMs, setTimeoutFn, clearTimeoutFn }) {
  const records = new Map();
  const latestAttempts = new Map();
  let attemptSequence = 0;

  function get(imageId) {
    return records.get(imageId);
  }

  function record(candidate) {
    if (!candidate?.id) return;
    const previous = records.get(candidate.id);
    const merged = { ...previous, ...candidate, id: candidate.id };
    if (candidate.data) {
      merged.data = candidate.data;
      merged.loadState = "ready";
      delete merged.loadError;
    } else if (candidate.loadState === "loading") {
      merged.loadState = "loading";
      delete merged.loadError;
    } else if (candidate.loadError) {
      merged.data = "";
      merged.loadState = "error";
      merged.loadError = candidate.loadError;
    } else if (!merged.loadState) {
      merged.loadState = "loading";
    }
    records.set(candidate.id, merged);
  }

  function capture(imageIds, results, metadata = []) {
    return imageIds.map((imageId, index) => {
      const result = results[index];
      if (result?.status === "fulfilled") {
        const current = { ...result.value, loadState: "ready" };
        record(current);
        return records.get(imageId) || current;
      }
      const existing = records.get(imageId);
      if (existing?.data && existing.loadState === "ready") {
        return existing;
      }
      const current = metadata[index] || { id: imageId };
      const failure = artifactLoadFailure(result?.reason || new ArtifactHydrationError("artifact_server_error", "MCP artifact tool returned an error"));
      const failed = { ...current, id: imageId, imageUrl: "", data: "", loadError: failure, loadState: "error" };
      record(failed);
      return failed;
    });
  }

  function begin(imageId) {
    const attempt = { imageId, sequence: ++attemptSequence };
    latestAttempts.set(imageId, attempt.sequence);
    return attempt;
  }

  function captureAttempt(attempt, result, metadata = null) {
    const imageId = attempt?.imageId;
    if (!imageId) return { accepted: false, candidate: null };
    const current = records.get(imageId);
    if (result?.status === "fulfilled") {
      if (current?.data && current.loadState === "ready") {
        return { accepted: false, candidate: current };
      }
      const candidate = { ...metadata, ...result.value, id: imageId, loadState: "ready" };
      record(candidate);
      return { accepted: true, candidate: records.get(imageId) || candidate };
    }
    const isLatestAttempt = latestAttempts.get(imageId) === attempt.sequence;
    if (!isLatestAttempt || (current?.data && current.loadState === "ready")) {
      return { accepted: false, candidate: current || null };
    }
    const failure = artifactLoadFailure(
      result?.reason || new ArtifactHydrationError("artifact_server_error", "MCP artifact tool returned an error"),
    );
    const candidate = {
      ...current,
      ...metadata,
      id: imageId,
      imageUrl: "",
      data: "",
      loadError: failure,
      loadState: "error",
    };
    record(candidate);
    return { accepted: true, candidate: records.get(imageId) || candidate };
  }

  function settle(load) {
    let timeoutId;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeoutFn(() => resolve({
        status: "rejected",
        reason: new ArtifactHydrationError("artifact_server_error", "MCP image artifact read timed out"),
      }), timeoutMs);
    });
    const settled = Promise.resolve(load).then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );
    return Promise.race([settled, timeout]).finally(() => clearTimeoutFn(timeoutId));
  }

  return { begin, capture, captureAttempt, get, record, settle };
}

export function uniqueImageIds(ids) {
  return [...new Set((ids || []).filter((id) => typeof id === "string" && id))];
}
