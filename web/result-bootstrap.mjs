export function createResultBootstrap() {
  let active = true;
  let inputObserved = false;
  let imageIds = null;
  let hostReady = false;
  let started = false;

  return Object.freeze({ observe });

  function observe(event) {
    if (!active) return [];

    if (event?.type === "dispose") {
      active = false;
      return [];
    }
    if (event?.type === "server-error") {
      active = false;
      return [{ type: "fail", code: "artifact_server_error" }];
    }

    const effects = [];
    if (event?.type === "tool-input") {
      if (inputObserved) return [];
      inputObserved = true;
      if (!event.valid || !Array.isArray(event.imageIds) || event.imageIds.length === 0) {
        active = false;
        return [{ type: "fail", code: "artifact_schema_missing" }];
      }
      imageIds = Object.freeze([...event.imageIds]);
      effects.push({ type: "bind", imageIds });
    } else if (event?.type === "tool-result") {
      // The standard tool input already contains the stable image IDs needed to read the artifact.
    } else if (event?.type === "host-ready") {
      hostReady = true;
    } else {
      return [];
    }

    if (!started && hostReady && imageIds) {
      started = true;
      effects.push({ type: "start", imageIds });
    }
    return effects;
  }
}
