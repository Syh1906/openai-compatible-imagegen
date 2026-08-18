export const IMAGE_ID = "img_01J00000000000000000000000";
export const EDITOR_SESSION_ID = "eds_01J00000000000000000000000";
export const PROJECT_BINDING_ID = `pbind_${"a".repeat(64)}`;
export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL1WQAAAABJRU5ErkJggg==";
export const FULL_MESSAGE_HOST_CAPABILITIES = { message: { text: {}, image: {} }, updateModelContext: { structuredContent: {} } };
export const CODEX_COMPOSER_HOST_CAPABILITIES = { message: {}, updateModelContext: { text: {}, image: {}, structuredContent: {} } };

export function installHost(window, { toolName, editorSessionStatus = "active", destroySessionStatus = "destroyed", canvasStatus = "available", initialDisplayMode = "inline", initialHostContext = { locale: "zh-CN" }, deferModelContext = false, deferDisplayModeRequests = false, deferOpenImageEditor = false, deferDestroyImageEditor = false, deferArtifactDataImageIds = [], children = [], maskCapability = true, failMessageOnce = false, failOpenImageId = null, artifactOverride = null, initialEditorDraft = null, initialEditorResultIncludesArtifact = true, initialArtifacts = null, initialResultIncludesToolInput = true, initialResultToolInputArguments = null, initialResultText = null, initialResultNotificationOrder = "result-first", initialResultIsError = false, initialResultIncludesImages = true, initialResultIncludesStructuredContent = true, initialResultIncludesWidgetImages = false, rejectModelCatalog = false, rejectDisplayMode = null, rejectFinalizeImageEditor = false, saveDraftIsError = false, uniqueEditorSessionIds = false, artifactDataIsError = false, revealArtifactIsError = false, failArtifactDataImageId = null, failArtifactDataImageIds = [], artifactDataPayloadInvalid = false, hostCapabilities = FULL_MESSAGE_HOST_CAPABILITIES }) {
  const toolCalls = [];
  const resourceReads = [];
  const displayModeRequests = [];
  const messages = [];
  const modelContexts = [];
  const pendingDisplayModeRequests = [];
  const pendingOpenImageEditorRequests = [];
  const pendingDestroyImageEditorRequests = [];
  const pendingArtifactDataRequests = [];
  let teardownRequests = 0;
  let pendingModelContextId = null;
  let shouldFailMessage = failMessageOnce;
  let editorSessionImageId = IMAGE_ID;
  let currentEditorSessionStatus = editorSessionStatus;
  let openEditorCount = 0;
  let activeEditorSessionId = EDITOR_SESSION_ID;
  const editorDrafts = new Map(initialEditorDraft ? [[IMAGE_ID, structuredClone(initialEditorDraft)]] : []);
  const editorSessionImages = new Map([[EDITOR_SESSION_ID, IMAGE_ID]]);
  const initialArtifactRecords = initialArtifacts?.map((item) => ({ ...item })) || null;
  const runtimeArtifacts = new Map((initialArtifactRecords || []).map((item) => [item.id, item]));
  const defaultArtifact = (id = IMAGE_ID) => ({
    id,
    mimeType: "image/png",
    width: 1,
    height: 1,
    operation: id === IMAGE_ID ? "generate" : "edit",
    parentIds: id === IMAGE_ID ? [] : [IMAGE_ID],
    childIds: id === IMAGE_ID ? children.map((item) => item.id) : [],
  });
  const artifactFor = (imageId) => (
    artifactOverride?.id === imageId ? artifactOverride : runtimeArtifacts.get(imageId) || defaultArtifact(imageId)
  );
  const onMessage = (event) => {
    const message = event.data;
    if (message?.method === "ui/initialize") {
      sendToApp(window, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2026-01-26",
          hostInfo: { name: "widget-test-host", version: "0.1.0" },
          hostCapabilities,
          hostContext: {
            ...initialHostContext,
            toolInfo: {
              tool: {
                name: toolName,
                inputSchema: { type: "object" },
              },
            },
            displayMode: initialDisplayMode,
            availableDisplayModes: ["inline", "fullscreen"],
          },
        },
      });
    } else if (message?.method === "ui/notifications/initialized") {
      if (toolName === "open_image_editor") {
        sendToApp(window, {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: { imageId: IMAGE_ID, projectBindingId: PROJECT_BINDING_ID } },
        });
      }
      if (initialArtifactRecords) {
        const imageIds = initialArtifactRecords.map((item) => item.id);
        const resultNotification = {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            ...(initialResultIsError ? { isError: true } : {}),
            content: [
              { type: "text", text: initialResultText || `已显示 ${imageIds.length} 张图片。` },
              ...(initialResultIncludesImages
                ? initialArtifactRecords.map(() => ({ type: "image", mimeType: "image/png", data: PNG_BASE64 }))
                : []),
            ],
            ...(initialResultIncludesStructuredContent
              ? { structuredContent: { imageIds, artifacts: initialArtifactRecords } }
              : {}),
            _meta: {
              imageIds,
              ...(initialResultIncludesWidgetImages
                ? { imageArtifacts: initialArtifactRecords.map((item) => ({ ...item, data: PNG_BASE64 })) }
                : {}),
            },
          },
        };
        const inputNotification = {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: {
            arguments: initialResultToolInputArguments || { imageIds, projectBindingId: PROJECT_BINDING_ID },
          },
        };
        const notifications = initialResultNotificationOrder === "input-first"
          ? [inputNotification, resultNotification]
          : [resultNotification, inputNotification];
        for (const notification of notifications) {
          if (notification === inputNotification && (!initialResultIncludesToolInput || toolName !== "render_image_results")) continue;
          sendToApp(window, notification);
        }
      } else if (toolName === "open_image_editor") {
        const initialArtifact = artifactOverride || defaultArtifact();
        sendToApp(window, {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            content: [],
            structuredContent: {
              editorSession: {
                id: EDITOR_SESSION_ID,
                imageId: IMAGE_ID,
                status: "active",
                ...(editorDrafts.has(IMAGE_ID) ? { draft: structuredClone(editorDrafts.get(IMAGE_ID)) } : {}),
              },
              ...(initialEditorResultIncludesArtifact ? { artifact: initialArtifact } : {}),
            },
          },
        });
      }
    } else if (message?.method === "resources/read") {
      resourceReads.push(message.params.uri);
      sendToApp(window, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          contents: [{ uri: message.params.uri, mimeType: "image/png", blob: PNG_BASE64 }],
        },
      });
    } else if (message?.method === "tools/call") {
      toolCalls.push(message.params);
      const toolName = message.params.name;
      if (toolName === "save_image_editor_draft" && !saveDraftIsError) {
        const draftImageId = editorSessionImages.get(message.params.arguments.editorSessionId);
        const draft = structuredClone(message.params.arguments.draft);
        if (draft.annotations.length || draft.prompt.trim()) editorDrafts.set(draftImageId, draft);
        else editorDrafts.delete(draftImageId);
      }
      if (toolName === "list_image_models" && rejectModelCatalog) {
        sendToApp(window, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: "model catalog unavailable" },
        });
        return;
      }
      if (toolName === "open_image_editor") {
        editorSessionImageId = message.params.arguments.imageId;
        openEditorCount += 1;
        activeEditorSessionId = uniqueEditorSessionIds
          ? `eds_01J0000000000000000000000${openEditorCount}`
          : EDITOR_SESSION_ID;
        editorSessionImages.set(activeEditorSessionId, editorSessionImageId);
        message.editorSessionSnapshot = {
          id: activeEditorSessionId,
          imageId: editorSessionImageId,
        };
      }
      if (toolName === "open_image_editor" && deferOpenImageEditor) {
        pendingOpenImageEditorRequests.push(message);
        return;
      }
      if (toolName === "destroy_image_editor" && deferDestroyImageEditor) {
        pendingDestroyImageEditorRequests.push(message);
        return;
      }
      if (toolName === "read_image_artifact_data" && deferArtifactDataImageIds.includes(message.params.arguments.imageId)) {
        pendingArtifactDataRequests.push(message);
        return;
      }
      const result = toolName === "reveal_image_artifact" && revealArtifactIsError
        ? {
            isError: true,
            content: [{ type: "text", text: "artifact_reveal_failed: 无法在文件夹中显示图片。" }],
          }
        : toolName === "reveal_image_artifact"
          ? {
              content: [{ type: "text", text: `已在文件夹中显示图片 ${message.params.arguments.imageId}。` }],
              structuredContent: { status: "revealed", imageId: message.params.arguments.imageId },
            }
      : toolName === "read_image_artifact_data" && (
        artifactDataIsError
        || message.params.arguments.imageId === failArtifactDataImageId
        || failArtifactDataImageIds.includes(message.params.arguments.imageId)
      )
        ? {
            isError: true,
            content: [{ type: "text", text: "image_task_failed: artifact data unavailable" }],
          }
        : toolName === "read_image_artifact_data" && artifactDataPayloadInvalid
          ? {
              content: [],
              structuredContent: {
                artifact: artifactFor(message.params.arguments.imageId),
                canvasStatus,
              },
            }
        : toolName === "read_image_artifact_data"
        ? {
            content: [],
            structuredContent: {
              artifact: artifactFor(message.params.arguments.imageId),
              canvasStatus: artifactFor(message.params.arguments.imageId).canvasStatus || canvasStatus,
            },
            _meta: {
              widgetData: {
                id: message.params.arguments.imageId,
                mimeType: "image/png",
                dataBase64: PNG_BASE64,
              },
            },
          }
        : toolName === "list_image_models"
        ? {
            content: [],
            structuredContent: {
              models: [{ id: "primary/gpt-image-2", provider: "primary", model: "gpt-image-2", capabilities: { mask: maskCapability } }],
            },
          }
        : toolName === "report_imagegen_host_observation"
          ? {
              content: [],
              structuredContent: { accepted: message.params.arguments.observations.length },
            }
        : toolName === "get_image_editor_session"
        ? {
            content: [],
            structuredContent: {
              editorSession: {
                id: message.params.arguments.editorSessionId,
                imageId: editorSessionImages.get(message.params.arguments.editorSessionId),
                status: currentEditorSessionStatus,
              },
            },
          }
        : toolName === "save_image_editor_draft"
          ? {
              content: saveDraftIsError ? [{ type: "text", text: "editor_state_invalid" }] : [],
              ...(saveDraftIsError ? { isError: true } : {}),
              structuredContent: {
                editorSession: {
                  id: message.params.arguments.editorSessionId,
                  imageId: editorSessionImages.get(message.params.arguments.editorSessionId),
                  status: "active",
                },
              },
            }
        : toolName === "destroy_image_editor"
          ? {
              content: [],
              structuredContent: {
                editorSession: {
                  id: message.params.arguments.editorSessionId,
                  imageId: editorSessionImages.get(message.params.arguments.editorSessionId),
                  status: destroySessionStatus,
                },
              },
            }
          : toolName === "finalize_image_editor_session" && rejectFinalizeImageEditor
            ? {
                isError: true,
                content: [{ type: "text", text: "editor_session_release_failed" }],
              }
          : toolName === "finalize_image_editor_session"
            ? {
                content: [],
                structuredContent: {
                  editorSession: {
                    id: message.params.arguments.editorSessionId,
                    imageId: editorSessionImages.get(message.params.arguments.editorSessionId),
                    status: "released",
                  },
                },
              }
          : toolName === "open_image_editor" && message.params.arguments.imageId === failOpenImageId
            ? {
                isError: true,
                content: [{ type: "text", text: "editor_session_open_failed" }],
              }
          : toolName === "open_image_editor"
            ? {
                content: [],
                structuredContent: {
                  editorSession: {
                    id: activeEditorSessionId,
                    imageId: editorSessionImageId,
                    status: "active",
                    ...(editorDrafts.has(editorSessionImageId) ? { draft: structuredClone(editorDrafts.get(editorSessionImageId)) } : {}),
                  },
                  artifact: defaultArtifact(editorSessionImageId),
                },
                _meta: { imageId: editorSessionImageId, editorSessionId: activeEditorSessionId },
              }
          : toolName === "prepare_image_edit_submission"
            ? {
                content: [],
                structuredContent: {
                  annotation: message.params.arguments.items.length ? { id: "ann_01J00000000000000000000000", imageId: message.params.arguments.parentImageId, itemCount: message.params.arguments.items.length } : null,
                  submission: {
                    id: `sub_${toolCalls.filter(({ name }) => name === "prepare_image_edit_submission").length.toString(16).padStart(32, "0")}`,
                    parentImageId: message.params.arguments.parentImageId,
                    annotationId: message.params.arguments.items.length ? "ann_01J00000000000000000000000" : null,
                    revisionSha256: "a".repeat(64),
                  },
                },
              }
          : {
                content: [{ type: "image", mimeType: "image/png", data: PNG_BASE64 }],
                structuredContent: {
                  artifact: artifactFor(message.params.arguments.imageId || IMAGE_ID),
                  canvasStatus: artifactFor(message.params.arguments.imageId || IMAGE_ID).canvasStatus || canvasStatus,
                },
              };
      if (toolName === "open_image_editor" && !result.isError) editorDrafts.delete(editorSessionImageId);
      sendToApp(window, {
        jsonrpc: "2.0",
        id: message.id,
        result,
      });
    } else if (message?.method === "ui/request-display-mode") {
      displayModeRequests.push(message.params.mode);
      if (deferDisplayModeRequests) {
        pendingDisplayModeRequests.push(message);
        return;
      }
      if (message.params.mode === rejectDisplayMode) {
        sendToApp(window, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: "display mode unavailable" },
        });
        return;
      }
      sendToApp(window, {
        jsonrpc: "2.0",
        id: message.id,
        result: { mode: message.params.mode },
      });
      sendToApp(window, {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { displayMode: message.params.mode },
      });
    } else if (message?.method === "ui/message") {
      messages.push(message.params);
      sendToApp(window, {
        jsonrpc: "2.0",
        id: message.id,
        result: shouldFailMessage ? { isError: true } : {},
      });
      shouldFailMessage = false;
    } else if (message?.method === "ui/update-model-context") {
      modelContexts.push(message.params);
      if (deferModelContext) {
        pendingModelContextId = message.id;
      } else {
        sendToApp(window, {
          jsonrpc: "2.0",
          id: message.id,
          result: {},
        });
      }
    } else if (message?.method === "ui/notifications/request-teardown") {
      teardownRequests += 1;
    }
  };
  window.addEventListener("message", onMessage);
  return {
    displayModeRequests,
    messages,
    modelContexts,
    resourceReads,
    toolCalls,
    get teardownRequests() {
      return teardownRequests;
    },
    get pendingDisplayModeRequestCount() {
      return pendingDisplayModeRequests.length;
    },
    get pendingOpenImageEditorRequestCount() {
      return pendingOpenImageEditorRequests.length;
    },
    get pendingDestroyImageEditorRequestCount() {
      return pendingDestroyImageEditorRequests.length;
    },
    get pendingArtifactDataRequestCount() {
      return pendingArtifactDataRequests.length;
    },
    resolveOpenImageEditor: (imageId = null) => {
      const index = imageId === null
        ? 0
        : pendingOpenImageEditorRequests.findIndex((item) => item.params.arguments.imageId === imageId);
      if (index < 0) throw new Error(`No pending open_image_editor request for ${imageId}`);
      const message = pendingOpenImageEditorRequests.splice(index, 1)[0];
      if (!message) throw new Error("No pending open_image_editor request");
      const snapshot = message.editorSessionSnapshot;
      sendToApp(window, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [],
          structuredContent: {
            editorSession: { id: snapshot.id, imageId: snapshot.imageId, status: "active" },
            artifact: defaultArtifact(message.params.arguments.imageId),
          },
          _meta: { imageId: snapshot.imageId, editorSessionId: snapshot.id },
        },
      });
    },
    rejectOpenImageEditor: () => {
      const message = pendingOpenImageEditorRequests.shift();
      if (!message) throw new Error("No pending open_image_editor request");
      sendToApp(window, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "editor session unavailable" },
      });
    },
    resolveDestroyImageEditor: () => {
      const message = pendingDestroyImageEditorRequests.shift();
      if (!message) throw new Error("No pending destroy_image_editor request");
      const requestedSessionId = message.params.arguments.editorSessionId;
      sendToApp(window, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [],
          structuredContent: {
            editorSession: {
              id: requestedSessionId,
              imageId: editorSessionImages.get(requestedSessionId),
              status: destroySessionStatus,
            },
          },
        },
      });
    },
    rejectDestroyImageEditor: () => {
      const message = pendingDestroyImageEditorRequests.shift();
      if (!message) throw new Error("No pending destroy_image_editor request");
      sendToApp(window, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "editor session destroy unavailable" },
      });
    },
    resolveArtifactData: (imageId) => {
      const index = pendingArtifactDataRequests.findIndex((message) => message.params.arguments.imageId === imageId);
      if (index < 0) throw new Error(`No pending artifact data request for ${imageId}`);
      const message = pendingArtifactDataRequests.splice(index, 1)[0];
      const artifact = artifactFor(imageId);
      sendToApp(window, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [],
          structuredContent: {
            artifact,
            canvasStatus: artifact.canvasStatus || canvasStatus,
          },
          _meta: { widgetData: { id: imageId, mimeType: artifact.mimeType, dataBase64: PNG_BASE64 } },
        },
      });
    },
    rejectArtifactData: (imageId) => {
      const index = pendingArtifactDataRequests.findIndex((message) => message.params.arguments.imageId === imageId);
      if (index < 0) throw new Error(`No pending artifact data request for ${imageId}`);
      const message = pendingArtifactDataRequests.splice(index, 1)[0];
      sendToApp(window, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "artifact data unavailable" },
      });
    },
    resolveDisplayModeRequest: (mode, { responseMode = mode, notifyAfter = true } = {}) => {
      const message = takePendingDisplayModeRequest(pendingDisplayModeRequests, mode);
      sendToApp(window, { jsonrpc: "2.0", id: message.id, result: { mode: responseMode } });
      if (notifyAfter) {
        sendToApp(window, {
          jsonrpc: "2.0",
          method: "ui/notifications/host-context-changed",
          params: { displayMode: responseMode },
        });
      }
    },
    rejectDisplayModeRequest: (mode) => {
      const message = takePendingDisplayModeRequest(pendingDisplayModeRequests, mode);
      sendToApp(window, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "display mode unavailable" },
      });
    },
    rejectPendingDisplayModeRequests: () => {
      for (const message of pendingDisplayModeRequests.splice(0)) {
        sendToApp(window, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: "display mode unavailable" },
        });
      }
    },
    notifyHostContext: (displayMode) => sendToApp(window, {
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode },
    }),
    notifyHostContextChanged: (params) => sendToApp(window, {
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params,
    }),
    setEditorSessionStatus: (status) => {
      currentEditorSessionStatus = status;
    },
    setEditorSession: ({ id, imageId, status = "active" }) => {
      activeEditorSessionId = id;
      editorSessionImageId = imageId;
      currentEditorSessionStatus = status;
      editorSessionImages.set(id, imageId);
    },
    notifyResultToolInput: (imageIds) => sendToApp(window, {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { imageIds, projectBindingId: PROJECT_BINDING_ID } },
    }),
    notifyResultArtifacts: (artifacts) => {
      for (const artifact of artifacts) runtimeArtifacts.set(artifact.id, { ...artifact });
      if (toolName === "render_image_results") {
        sendToApp(window, {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: { imageIds: artifacts.map((item) => item.id), projectBindingId: PROJECT_BINDING_ID } },
        });
      }
      sendToApp(window, {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          content: [
            { type: "text", text: `已显示 ${artifacts.length} 张图片。` },
            ...artifacts.map(() => ({ type: "image", mimeType: "image/png", data: PNG_BASE64 })),
          ],
          structuredContent: { imageIds: artifacts.map((item) => item.id), artifacts },
          _meta: { imageIds: artifacts.map((item) => item.id) },
        },
      });
    },
    releaseModelContext: () => {
      if (pendingModelContextId === null) return;
      sendToApp(window, { jsonrpc: "2.0", id: pendingModelContextId, result: {} });
      pendingModelContextId = null;
    },
    rejectModelContext: () => {
      if (pendingModelContextId === null) return;
      sendToApp(window, {
        jsonrpc: "2.0",
        id: pendingModelContextId,
        error: { code: -32603, message: "model context unavailable" },
      });
      pendingModelContextId = null;
    },
    dispose: () => window.removeEventListener("message", onMessage),
  };
}

function takePendingDisplayModeRequest(pendingRequests, mode) {
  const index = pendingRequests.findIndex((message) => message.params.mode === mode);
  if (index < 0) throw new Error(`no pending display mode request for ${mode}`);
  return pendingRequests.splice(index, 1)[0];
}

export function sendToApp(window, data) {
  window.dispatchEvent(new window.MessageEvent("message", {
    data,
    origin: window.location.origin,
    source: window,
  }));
}

export function pointerEvent(window, type, init) {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    button: init.button ?? 0,
    buttons: init.buttons ?? (type === "pointerup" ? 0 : 1),
    clientX: init.clientX,
    clientY: init.clientY,
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  Object.defineProperty(event, "pointerType", { value: init.pointerType || "mouse" });
  return event;
}

export function triggerResizeObservers(window, target) {
  for (const observer of window.__widgetResizeObservers || []) {
    if (!observer.targets.has(target)) continue;
    const rect = target.getBoundingClientRect();
    observer.callback([{ target, contentRect: rect }], observer);
  }
}

export async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("widget runtime did not reach the expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function installDomGlobals(window) {
  window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,cG5nLXByZXZpZXc=";
  class LoadedImage {
    set src(value) {
      this._src = value;
      queueMicrotask(() => this.onload?.());
    }
    get src() {
      return this._src;
    }
  }
  const resizeObservers = new Set();
  Object.defineProperty(window, "__widgetResizeObservers", {
    configurable: true,
    value: resizeObservers,
  });
  class TestResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      resizeObservers.add(this);
    }
    observe(target) {
      this.targets.add(target);
    }
    unobserve(target) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
  }
  const quietConsole = Object.create(globalThis.console);
  Object.defineProperty(quietConsole, "debug", {
    configurable: true,
    value() {},
    writable: true,
  });
  const values = {
    console: quietConsole,
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    MutationObserver: window.MutationObserver,
    Image: LoadedImage,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ResizeObserver: TestResizeObserver,
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return previous;
}

export function restoreDomGlobals(previous) {
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}
