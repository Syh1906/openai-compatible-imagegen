const PROJECT_BINDING_ID_PATTERN = /^pbind_[0-9a-f]{64}$/;

export class ProjectBindingError extends Error {
  constructor(message, code = "project_binding_invalid") {
    super(message);
    this.name = "ProjectBindingError";
    this.code = code;
  }
}

export function createBoundToolClient(app) {
  let projectBindingId = "";
  let bindingError = new ProjectBindingError("Project binding is missing from the tool input");

  return {
    observeToolInput(input) {
      if (bindingError?.code === "project_binding_conflict") return false;

      const candidate = input?.arguments?.projectBindingId;
      if (!PROJECT_BINDING_ID_PATTERN.test(candidate || "")) {
        bindingError = new ProjectBindingError(
          candidate === undefined
            ? "Project binding is missing from the tool input"
            : "Project binding in the tool input is invalid",
        );
        return false;
      }
      if (projectBindingId && candidate !== projectBindingId) {
        bindingError = new ProjectBindingError(
          "Project binding conflicts with the binding already established for this widget",
          "project_binding_conflict",
        );
        return false;
      }
      projectBindingId ||= candidate;
      bindingError = null;
      return true;
    },

    isBound: () => Boolean(projectBindingId) && !bindingError,

    async callServerTool(request) {
      if (bindingError) throw bindingError;
      return await app.callServerTool({
        ...request,
        arguments: { ...(request?.arguments || {}), projectBindingId },
      });
    },

    getHostCapabilities: (...args) => app.getHostCapabilities(...args),
    requestDisplayMode: (...args) => app.requestDisplayMode(...args),
    sendMessage: (...args) => app.sendMessage(...args),
    updateModelContext(request) {
      if (bindingError) throw bindingError;
      return app.updateModelContext({
        ...request,
        structuredContent: {
          ...(request?.structuredContent || {}),
          projectBindingId,
        },
      });
    },
  };
}
