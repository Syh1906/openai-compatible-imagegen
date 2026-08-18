import {
  addAnnotation,
  createEditorState,
  normalizeMaskOperationState,
  normalizeEditorColorState,
  normalizeAnnotation,
  removeAnnotation,
  resolveMaskOperation,
  translateAnnotation,
  updateAnnotation as updateEditorAnnotation,
} from "./editor-state.mjs";
import { hitTestAnnotation, maskColor } from "./editor-annotation-view.mjs";
import { createSubmissionCoordinator } from "./editor-submission.mjs";
import { createEditorSessionController } from "./editor-session-controller.mjs";
import { createEditorDraftLifecycle } from "./editor-draft-lifecycle.mjs";
import { createWidgetI18n } from "./widget-i18n.mjs";
import { createEditorToast } from "./editor-toast.mjs";
import { createEditorRenderer } from "./editor-renderer.mjs";
import { createEditorDraftRegistry, draftStatusMessage } from "./editor-drafts.mjs";
import {
  composerSubmissionStatus,
  observeComposerContext,
  submissionErrorStatus,
  submissionProgressStatus,
} from "./editor-context-outcome.mjs";
import { createFrameCoalescer } from "./frame-coalescer.mjs";
import { createDeferredResizeObserver } from "./deferred-resize-observer.mjs";
import {
  advanceMovePointerInteraction,
  appendDrawingPointerSamples,
  createDrawingPointerInteraction,
  finishDrawingPointerInteraction,
  hasPointerPathMoved,
  pointerPositionFromSample,
  pointerSamplesFromEvent,
} from "./editor-pointer-samples.mjs";
import { createCanvasTextEditingController } from "./editor-text-editing.mjs";
import { createEditorColorController } from "./editor-color-controller.mjs";
import { createHostObservationReporter } from "./host-observation.mjs";
import { createArtifactLoadRegistry, uniqueImageIds } from "./artifact-load-registry.mjs";
import { createArtifactCandidateLoader } from "./artifact-candidate-loader.mjs";
import { createResultBootstrap } from "./result-bootstrap.mjs";
import { ArtifactHydrationError, artifactLineage, artifactLineageImageIds, extractResultArtifacts, extractResultInputImageIds, lineageSeedFor, mergeLineageRecords, toImageUrl } from "./result-state.mjs";
import { artifactLoadFailure, resultFailureCode } from "./result-errors.mjs";
import { createResultFileRevealController, createResultPreviewSession } from "./result-preview.mjs";
import { createHostDisplayModeController } from "./editor-host-display.mjs";
import { applyHostTheme } from "./host-theme.mjs";
import { bindScopedClicks } from "./editor-ui-listeners.mjs";
import { createEditorDisclosureController } from "./editor-disclosure-controller.mjs";
import { isNativeEditingTarget } from "./editor-keyboard-annotation.mjs";
import { createEditorKeyboardController } from "./editor-keyboard-controller.mjs";
import { createEditorConfirmationController } from "./editor-confirmation-controller.mjs";
import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import { createBoundToolClient } from "./bound-tool-client.mjs";
const defaultImage = {
  id: "",
  mimeType: "image/png",
  width: 1,
  height: 1,
  operation: "generate",
  parentIds: [],
};
const root = document.querySelector("main");
const widgetI18n = createWidgetI18n();
const renderer = createEditorRenderer(root, { i18n: widgetI18n });
const draftRegistry = createEditorDraftRegistry();
const canvasResize = createDeferredResizeObserver({
  requestFrame: window.requestAnimationFrame.bind(window),
  cancelFrame: window.cancelAnimationFrame.bind(window),
  onResize: () => {
    if (widgetRole === "editor" && !interaction) renderer.updateCanvasGeometry(editor);
  },
});
const pointerCoalescer = createFrameCoalescer({
  requestFrame: window.requestAnimationFrame.bind(window),
  cancelFrame: window.cancelAnimationFrame.bind(window),
  onFrame: applyPointerSamples,
});
let editor = createEditorState({ image: defaultImage });
let interaction = null;
let undoStack = [];
let redoStack = [];
let imageUrl = "";
let resultCandidates = [];
let hostReady = false;
let pendingImageId = "";
let pendingImageIds = [];
let pendingArtifactRecords = [];
let displayMode = "inline";
let availableDisplayModes = [];
let inlineStatus = "";
let inlineStatusTone = "neutral";
let inlineStatusImageId = "";
let widgetRole = "result";
let submissionInFlight = false;
let submissionStatus = "";
let submissionStatusTone = "neutral";
let openingInFlight = false;
let openingImageId = "";
let hostInlineReturnInFlight = false;
let intentPanelOpen = false;
let intentPanelTrigger = null;
let destroyInFlight = false;
let artifactLoadSequence = 0;
let artifactLoadInFlight = false;
const resultBootstrap = createResultBootstrap();
const artifactRecordCache = createArtifactLoadRegistry({
  timeoutMs: 8000,
  setTimeoutFn: window.setTimeout.bind(window),
  clearTimeoutFn: window.clearTimeout.bind(window),
});
let modelCapabilities = null;
let uiCleanup = null;
let uiAbortController = null;
let resourceActive = true;
const resourceAbortController = new window.AbortController();
const destroyedCanvasImageIds = new Set();
function editorDestroyed() { return widgetRole === "editor" && destroyedCanvasImageIds.has(editor.image.id); }
function interactionLocked() { return submissionInFlight || artifactLoadInFlight || destroyInFlight || editorDestroyed(); }
function setLoadFailure(failure) { inlineStatus = submissionStatus = failure; inlineStatusTone = submissionStatusTone = "error"; }
const textEditing = createCanvasTextEditingController({
  root,
  getEditor: () => editor,
  setEditor: (value) => { editor = value; },
  render,
  renderLayer: () => renderer.renderAnnotationLayer(editor),
  clearStatus: clearSubmissionStatus,
  onStart: () => { intentPanelOpen = true; },
  commitHistory: (before) => { undoStack.push(before); redoStack = []; },
  isActive: () => resourceActive,
});
const keyboardController = createEditorKeyboardController({
  renderer,
  getEditor: () => editor,
  setEditor: (value) => { editor = value; },
  hasPointerInteraction: () => Boolean(interaction),
  isInteractionLocked: interactionLocked,
  pushHistory: (before) => { undoStack.push(before); redoStack = []; },
  clearStatus: clearSubmissionStatus,
  openIntentPanel: () => { intentPanelOpen = true; },
  startTextEditing: (id) => textEditing.start(id),
  render,
});
const closeGuidance = createEditorDisclosureController({ root, wrapSelector: "[data-close-guidance-wrap]", triggerSelector: "[data-close-guidance]" });
const colorController = createEditorColorController({
  root,
  getEditor: () => editor,
  setEditor: (value) => { editor = value; },
  getModelCapabilities: () => modelCapabilities,
  isInteractionLocked: interactionLocked,
  renderer,
  render,
  clearStatus: clearSubmissionStatus,
  discardInteraction,
  pushHistory: (before) => { undoStack.push(before); redoStack = []; },
});
const destroyConfirmation = createEditorConfirmationController({
  root,
  dialogSelector: "[data-destroy-confirm]",
  triggerSelector: "[data-action=destroy]",
  cancelSelector: "[data-action=cancel-destroy]",
  render,
  focusLastWhenMissing: true,
});
const clearConfirmation = createEditorConfirmationController({
  root,
  dialogSelector: "[data-clear-confirm]",
  triggerSelector: "[data-action=clear]",
  cancelSelector: "[data-action=cancel-clear]",
  render,
});
const app = new App({ name: "openai-compatible-imagegen-editor", version: "0.1.0" }, {});
const boundToolClient = createBoundToolClient(app);
const displayModeController = createHostDisplayModeController({
  app,
  isActive: () => resourceActive,
  getRole: () => widgetRole,
  setRole: (value) => { widgetRole = value; },
  getDisplayMode: () => displayMode,
  getHostReady: () => hostReady,
  getAvailableModes: () => availableDisplayModes,
  setAvailableModes: (value) => { availableDisplayModes = value; },
  setDisplayMode: (value) => { displayMode = value; },
  setStatus: (message, tone) => {
    inlineStatus = message;
    inlineStatusTone = tone;
  },
  render,
});
const artifactCandidates = createArtifactCandidateLoader({ app: boundToolClient, records: artifactRecordCache, observeToolCall: (result) => hostObservationReporter.observeToolCall(result) });
const resultFileReveal = createResultFileRevealController({
  root,
  app: boundToolClient,
  isActive: () => resourceActive,
  onBusyChange: (_imageId, surface) => { if (surface === "editor" && resourceActive && widgetRole === "editor") render(); },
  onFailure: (_imageId, surface) => { if (surface === "editor") toast("无法在文件夹中显示图片"); },
});
const resultPreview = createResultPreviewSession({ root, app: boundToolClient, isActive: () => resourceActive, getState: () => ({ hostReady, availableDisplayModes, displayMode, candidates: resultCandidates }), onReveal: resultFileReveal.reveal, onSessionEnd: render });
const hostObservationReporter = createHostObservationReporter({
  app: boundToolClient,
  releaseFingerprint: document.querySelector('meta[name="openai-compatible-imagegen-release"]')?.content || "",
});
const submissionCoordinator = createSubmissionCoordinator({ app: boundToolClient, isActive: () => resourceActive });
const toastController = createEditorToast({ root, window, isActive: () => resourceActive, localize: widgetI18n.localizeText, onFallback: (message) => { inlineStatus = message; inlineStatusTone = "error"; render(); } });
const toast = toastController.show;
const sessionController = createEditorSessionController({
  app: boundToolClient,
  setIntervalFn: window.setInterval.bind(window),
  clearIntervalFn: window.clearInterval.bind(window),
  onDestroyed: teardownDestroyedEditor,
  onError: () => toast("无法确认画布会话状态"),
});
const draftLifecycle = createEditorDraftLifecycle({
  window, document, sessionController, draftRegistry,
  getEditor: () => editor, setEditor: (value) => { editor = value; },
  getUndoStack: () => undoStack, setUndoStack: (value) => { undoStack = value; },
  getRedoStack: () => redoStack, setRedoStack: (value) => { redoStack = value; },
  isEligible: () => resourceActive && widgetRole === "editor" && Boolean(sessionController.id) && !editorDestroyed(),
  onError: () => { if (resourceActive && widgetRole === "editor") toast("Codex 未能自动保存当前画布"); },
});
render();
connectHost();
document.addEventListener("keydown", handleEditorKeyDown);
draftLifecycle.bind(resourceAbortController.signal);
function bindUi() {
  uiCleanup?.();
  uiCleanup = null;
  uiAbortController = new window.AbortController();
  const listenerOptions = { signal: uiAbortController.signal };
  textEditing.bind();
  closeGuidance.bind(uiAbortController.signal);
  const colorCleanup = colorController.bind();
  root.onclick = (event) => {
    const annotation = event.target.closest("[data-annotation-id]");
    if (annotation && !event.target.closest("textarea, button")) {
      selectAnnotation(annotation.dataset.annotationId);
      render();
      return;
    }
    const tool = event.target.closest(".tool-button[data-tool]");
    if (tool) {
      activateTool(tool);
      return;
    }
    const colorSlot = event.target.closest("[data-color-slot]");
    if (colorSlot) {
      colorController.choose(Number(colorSlot.dataset.colorSlot));
      return;
    }
    const stroke = event.target.closest("[data-stroke]");
    if (stroke && editor.activeTool !== "mask" && editor.annotations.find((item) => item.id === editor.selectedAnnotationId)?.type !== "mask") {
      discardInteraction();
      const strokeWidth = Number(stroke.dataset.stroke);
      const selected = editor.annotations.find((item) => item.id === editor.selectedAnnotationId);
      const annotationChanged = Boolean(selected && selected.strokeWidth !== strokeWidth);
      const controlChanged = editor.strokeWidth !== strokeWidth;
      if (!annotationChanged && !controlChanged) {
        render();
        return;
      }
      if (annotationChanged) {
        undoStack.push(editor);
        redoStack = [];
        editor = updateEditorAnnotation({ ...editor, strokeWidth }, selected.id, { strokeWidth });
      } else {
        editor = { ...editor, strokeWidth };
      }
      clearSubmissionStatus();
      render();
      return;
    }
    if (applyMaskControl(event.target.closest("[data-mask-mode], [data-mask-operation], [data-mask-radius]"))) return;
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action) handleAction(action, event);
    const version = event.target.closest("[data-version-id]");
    if (version) selectVersion(version.dataset.versionId);
  };
  // Keep host-facing actions on the button itself. Some Codex App surfaces
  // do not reliably bubble clicks from replaced widget content to <main>.
  bindScopedClicks(root, [
    { selector: "[data-action]", skip: (button) => button.dataset.action === "open-editor", handle: (button, event) => void handleAction(button.dataset.action, event) },
    { selector: ".tool-button[data-tool]", handle: activateTool },
    { selector: "[data-mask-mode], [data-mask-operation], [data-mask-radius]", handle: applyMaskControl },
  ], uiAbortController.signal);
  uiCleanup = () => {
    colorCleanup?.();
    uiAbortController?.abort();
    uiAbortController = null;
    root.onclick = null;
    root.oninput = null;
    root.removeEventListener("focusin", handleIntentFieldFocus);
    textEditing.dispose();
    uiCleanup = null;
  };
  root.oninput = (event) => {
    if (event.target.closest("[data-canvas-text-editor]")) return;
    const field = event.target.closest("[data-annotation-text]");
    if (!field) return;
    editor = updateEditorAnnotation(editor, field.dataset.annotationText, { text: field.value });
    clearSubmissionStatus();
    draftLifecycle.track();
    const count = field.closest("[data-annotation-id]")?.querySelector("[data-annotation-count]");
    if (count) count.textContent = `${field.value.length}/600`;
    renderer.renderAnnotationLayer(editor);
  };
  root.addEventListener("focusin", handleIntentFieldFocus);
  root.querySelector("[data-zoom-select]").addEventListener("change", (event) => {
    editor = { ...editor, zoom: Number(event.target.value) };
    render();
  }, listenerOptions);
  root.querySelector("[data-prompt]").addEventListener("input", (event) => {
    editor = { ...editor, prompt: event.target.value };
    clearSubmissionStatus();
    draftLifecycle.track();
    root.querySelector("[data-prompt-count]").textContent = `${event.target.value.length}/600`;
    root.querySelector("[data-action=clear]").disabled = submissionInFlight || (!editor.annotations.length && !editor.prompt.trim());
  }, listenerOptions);
  const canvas = root.querySelector("[data-canvas]");
  canvas.addEventListener("pointerdown", beginAnnotation, listenerOptions);
  canvas.addEventListener("pointerup", finishAnnotation, listenerOptions);
  canvas.addEventListener("pointercancel", cancelAnnotation, listenerOptions);
  canvas.addEventListener("pointermove", queueAnnotationUpdate, listenerOptions);
}
function bindDynamicUi() {
  bindScopedClicks(root, [
    { selector: "[data-action=apply-foreground-color], [data-action=remove-annotation]", handle: (button, event) => handleAction(button.dataset.action, event) },
    { selector: "[data-version-id]", handle: (button) => selectVersion(button.dataset.versionId) },
  ], uiAbortController?.signal);
}
function handleIntentFieldFocus(event) {
  const field = event.target.closest("[data-annotation-text]");
  if (!field || editor.selectedAnnotationId === field.dataset.annotationText) return;
  selectAnnotation(field.dataset.annotationText);
  intentPanelOpen = true;
  renderer.updateSelection({ editor, modelCapabilities, intentPanelOpen, ...colorController.state() });
}
function handleEditorKeyDown(event) {
  if (!resourceActive || widgetRole !== "editor") return;
  if (destroyConfirmation.handleKeyDown(event) || clearConfirmation.handleKeyDown(event)) return;
  if (event.key === "Escape" && colorController.isOpen()) {
    colorController.close({ restoreFocus: true });
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && closeGuidance.close()) { event.preventDefault(); return; }
  if (event.key === "Escape" && interaction) {
    cancelAnnotation();
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && keyboardController.cancel()) {
    event.preventDefault();
    return;
  }
  if (interactionLocked() || isNativeEditingTarget(event.target)) return;
  const modifier = (event.ctrlKey || event.metaKey) && !event.altKey;
  const historyShortcut = modifier && ["y", "z"].includes(event.key.toLowerCase());
  if (historyShortcut && (interaction || keyboardController.hasDrawing())) {
    discardInteraction();
    render();
    event.preventDefault();
    return;
  }
  if (modifier && event.key.toLowerCase() === "z") {
    handleAction(event.shiftKey ? "redo" : "undo", event);
    event.preventDefault();
  } else if (modifier && event.key.toLowerCase() === "y") {
    handleAction("redo", event);
    event.preventDefault();
  } else if ((event.key === "Delete" || event.key === "Backspace") && editor.selectedAnnotationId) {
    undoStack.push(editor);
    redoStack = [];
    editor = removeAnnotation(editor, editor.selectedAnnotationId);
    clearSubmissionStatus();
    render();
    event.preventDefault();
  } else {
    if (keyboardController.handleCanvasKeyDown(event)) {
      event.preventDefault();
    }
  }
}
async function connectHost() {
  app.ontoolinput = (params) => { if (resourceActive) ingestToolInput(params); };
  app.ontoolresult = (params) => {
    if (!resourceActive) return;
    hostObservationReporter.observeNotification(params);
    ingestToolResult(params);
  };
  app.onhostcontextchanged = (params) => {
    if (!resourceActive) return;
    const hostContext = app.getHostContext();
    const localeChanged = widgetI18n.setLocale(hostContext?.locale);
    applyHostTheme(hostContext);
    const requestedContext = displayModeController.consumeRequestedContext(params?.displayMode);
    const changed = displayModeController.applyContext(params);
    if (params?.displayMode === "inline"
      && widgetRole === "editor"
      && !requestedContext) {
      void returnAfterHostRestoredInline();
      return;
    }
    if (widgetRole === "result") resultPreview.syncHostContext(params?.displayMode); else if (changed || localeChanged) render();
  };
  app.onteardown = async () => {
    let draftSaveError = null;
    if (resourceActive && widgetRole === "editor" && sessionController.id) {
      try {
        await draftLifecycle.flush();
      } catch (error) {
        draftSaveError = error;
      }
    }
    resourceActive = false;
    applyResultBootstrapEffects(resultBootstrap.observe({ type: "dispose" }));
    toastController.dispose();
    resourceAbortController.abort();
    document.removeEventListener("keydown", handleEditorKeyDown);
    uiCleanup?.();
    pointerCoalescer.cancel();
    resultPreview.dispose();
    resultFileReveal.dispose();
    canvasResize.disconnect();
    artifactLoadSequence += 1;
    artifactLoadInFlight = false;
    pendingImageIds = [];
    pendingArtifactRecords = [];
    sessionController.stop();
    await sessionController.finalize();
    if (draftSaveError) throw draftSaveError;
    return {};
  };
  try {
    await app.connect(new PostMessageTransport(window.parent, window.parent));
    if (!resourceActive) return;
    const initialHostContext = app.getHostContext();
    widgetI18n.setLocale(initialHostContext?.locale);
    applyHostTheme(initialHostContext);
    displayModeController.applyContext(initialHostContext, { initializeRole: true });
    hostReady = true;
    applyResultBootstrapEffects(resultBootstrap.observe({ type: "host-ready" }));
    render();
    if (widgetRole === "editor" && boundToolClient.isBound()) loadModelCapabilities();
    if (widgetRole === "editor") await displayModeController.request("fullscreen");
    if (!resourceActive) return;
    if (widgetRole !== "result" && pendingArtifactRecords.length) hydrateArtifacts(pendingArtifactRecords);
    if (widgetRole === "editor" && sessionController.id) sessionController.start();
    render();
  } catch (error) {
    if (!resourceActive) return;
    inlineStatus = "宿主连接失败，请重新打开当前图片";
    inlineStatusTone = "error";
    render();
  }
}
async function loadModelCapabilities() {
  if (modelCapabilities !== null) return;
  modelCapabilities = {};
  try {
    const result = await boundToolClient.callServerTool({ name: "list_image_models", arguments: {} });
    if (!resourceActive) return;
    hostObservationReporter.observeToolCall(result);
    const model = result?.structuredContent?.models?.find((item) => item.id === "primary/gpt-image-2");
    if (result.isError || !model?.capabilities) throw new Error("model capabilities unavailable");
    modelCapabilities = model.capabilities;
    if (!modelCapabilities.mask && editor.activeTool === "mask") editor = { ...editor, activeTool: "select" };
    render();
  } catch (error) {
    if (!resourceActive) return;
    modelCapabilities = {};
    if (editor.activeTool === "mask") editor = { ...editor, activeTool: "select" };
    render();
    toast("无法读取当前模型能力");
  }
}
async function requestOpenEditor(imageId = editor.image.id) {
  if (!resourceActive || openingInFlight) return;
  if (destroyedCanvasImageIds.has(imageId)) {
    inlineStatus = "画布已销毁";
    inlineStatusTone = "neutral";
    inlineStatusImageId = imageId;
    render();
    return;
  }
  const selectedCandidate = resultCandidates.find((item) => item.id === imageId);
  if (selectedCandidate && selectedCandidate.id !== editor.image.id) {
    draftLifecycle.saveWorking();
    draftLifecycle.restoreWorking(createEditorState({ image: selectedCandidate, ...artifactLineage(selectedCandidate) }));
    imageUrl = toImageUrl(selectedCandidate);
    submissionCoordinator.reset();
  }
  if (!hostReady || !editor.image.id) {
    inlineStatus = "当前图片尚未准备好";
    inlineStatusTone = "error";
    inlineStatusImageId = editor.image.id;
    render();
    return;
  }
  if (!availableDisplayModes.includes("fullscreen")) {
    inlineStatus = "当前 Codex App 不支持展开画布";
    inlineStatusTone = "error";
    inlineStatusImageId = editor.image.id;
    render();
    return;
  }
  inlineStatus = "正在打开画布..."; inlineStatusTone = "progress"; inlineStatusImageId = editor.image.id;
  openingInFlight = true; openingImageId = editor.image.id;
  render();
  try {
    const sessionPromise = ensureEditorSession();
    const opened = await new Promise((resolve) => {
      // Give the host one event-loop turn to cancel a resource that is being torn down.
      window.setTimeout(() => {
        if (!resourceActive) return resolve(false);
        void displayModeController.request("fullscreen").then(resolve);
      }, 16);
    });
    const ensured = await sessionPromise;
    if (!resourceActive) return;
    if (!ensured?.session) {
      const failedImageId = openingImageId || editor.image.id;
      if (opened) await displayModeController.request("inline");
      if (resourceActive) {
        inlineStatus = "Codex 未能打开画布"; inlineStatusTone = "error"; inlineStatusImageId = failedImageId;
        render();
      }
      return;
    }
    draftLifecycle.restoreTransferred(ensured.session.draft);
    if (!resourceActive || !opened) return;
    inlineStatus = "";
    inlineStatusTone = "neutral";
    inlineStatusImageId = "";
    widgetRole = "editor";
    render();
    sessionController.start();
    const artifacts = ensured.opened ? extractResultArtifacts(ensured.result) : [];
    if (artifacts.length) void hydrateArtifacts(artifacts, { selectedImageId: editor.image.id });
  } catch (error) {
    if (!resourceActive) return;
    widgetRole = "result";
    inlineStatus = "画布打开失败";
    inlineStatusTone = "error";
    inlineStatusImageId = editor.image.id;
    render();
  } finally {
    if (!resourceActive) return;
    openingInFlight = false;
    openingImageId = "";
    if (widgetRole === "result") render();
  }
}
async function ensureEditorSession() {
  try {
    const ensured = await sessionController.ensure(editor.image.id);
    if (ensured.session) destroyInFlight = false;
    return resourceActive ? ensured : null;
  } catch (error) {
    if (!resourceActive) return null;
    inlineStatus = "Codex 未能打开画布";
    inlineStatusTone = "error";
    inlineStatusImageId = editor.image.id;
    render();
    return null;
  }
}
function ingestToolInput(input) {
  const bindingObserved = boundToolClient.observeToolInput(input);
  const isResultToolInput = Object.prototype.hasOwnProperty.call(input?.arguments || {}, "imageIds")
    || app.getHostContext()?.toolInfo?.tool?.name === "render_image_results";
  if (isResultToolInput) {
    const imageIds = extractResultInputImageIds(input);
    applyResultBootstrapEffects(resultBootstrap.observe({ type: "tool-input", imageIds, valid: imageIds.length > 0 }));
    return;
  }
  const imageId = input?._meta?.imageId || input?.imageId || input?.arguments?.imageId;
  if (imageId) {
    pendingImageId = imageId;
    if (!editor.image.id) editor = createEditorState({ image: { ...defaultImage, id: imageId } });
    artifactLoadInFlight = true;
  }
  if (bindingObserved && hostReady && widgetRole === "editor") loadModelCapabilities();
  render();
}
async function loadArtifacts(imageIds, { includeLineage = false, selectedImageId = "" } = {}) {
  if (!hostReady) return;
  const requestedImageIds = uniqueImageIds(imageIds);
  const loadSequence = ++artifactLoadSequence;
  artifactLoadInFlight = true;
  render();
  pendingImageIds = [];
  if (requestedImageIds.includes(pendingImageId)) pendingImageId = "";
  try {
    const activeImageId = selectedImageId || requestedImageIds[0] || editor.image.id || "";
    const pendingRequestedIds = new Set(requestedImageIds);
    for (const imageId of requestedImageIds) {
      const cached = artifactRecordCache.get(imageId);
      if (!(cached?.data && cached.loadState === "ready")) {
        artifactRecordCache.record({ ...cached, id: imageId, loadState: "loading" });
      }
    }
    const loadingCandidates = requestedImageIds.map((imageId) => artifactRecordCache.get(imageId) || { id: imageId, loadState: "loading" });
    applyArtifacts(
      loadingCandidates.filter((candidate) => candidate.data && candidate.loadState === "ready"),
      { candidates: loadingCandidates, selectedImageId: activeImageId },
    );
    const requestedResults = await Promise.all(requestedImageIds.map((imageId) => {
      const { attempt, load } = artifactCandidates.start(imageId);
      return artifactRecordCache.settle(load).then((result) => {
        if (loadSequence !== artifactLoadSequence) {
          captureLateArtifactResult(imageId, result, null, attempt);
          return result;
        }
        if (attempt) artifactRecordCache.captureAttempt(attempt, result, artifactRecordCache.get(imageId));
        pendingRequestedIds.delete(imageId);
        artifactLoadInFlight = pendingRequestedIds.has(activeImageId);
        const candidates = requestedImageIds.map((candidateId) => artifactRecordCache.get(candidateId) || { id: candidateId, loadState: "loading" });
        const artifacts = candidates.filter((candidate) => candidate.data && candidate.loadState === "ready");
        applyArtifacts(artifacts, { candidates, selectedImageId: activeImageId });
        return result;
      });
    }));
    if (loadSequence !== artifactLoadSequence) return;
    const seed = requestedResults.find(({ status }) => status === "fulfilled")?.value
      || artifactRecordCache.get(requestedImageIds[0])
      || lineageSeedFor(requestedImageIds[0], editor.lineage);
    const allImageIds = includeLineage
      ? uniqueImageIds([...requestedImageIds, ...artifactLineageImageIds(seed)])
      : requestedImageIds;
    const resultById = new Map(requestedImageIds.map((imageId, index) => [imageId, requestedResults[index]]));
    const extraImageIds = allImageIds.filter((imageId) => !resultById.has(imageId));
    for (const imageId of extraImageIds) {
      const cached = artifactRecordCache.get(imageId);
      if (!(cached?.data && cached.loadState === "ready")) {
        artifactRecordCache.record({ ...cached, id: imageId, loadState: "loading" });
      }
    }
    artifactLoadInFlight = false;
    const initialCandidates = allImageIds.map((imageId) => artifactRecordCache.get(imageId) || { id: imageId, loadState: "loading" });
    const initialArtifacts = initialCandidates.filter((candidate) => candidate.data && candidate.loadState === "ready");
    applyArtifacts(initialArtifacts, { candidates: initialCandidates, selectedImageId: activeImageId });
    const extraResults = await Promise.all(extraImageIds.map((imageId) => {
      const { attempt, load } = artifactCandidates.start(imageId);
      return artifactRecordCache.settle(load).then((result) => {
        if (loadSequence !== artifactLoadSequence) {
          captureLateArtifactResult(imageId, result, null, attempt);
          return result;
        }
        if (attempt) artifactRecordCache.captureAttempt(attempt, result, artifactRecordCache.get(imageId));
        resultById.set(imageId, result);
        const candidates = allImageIds.map((candidateId) => artifactRecordCache.get(candidateId) || { id: candidateId, loadState: "loading" });
        const artifacts = candidates.filter((candidate) => candidate.data && candidate.loadState === "ready");
        applyArtifacts(artifacts, { candidates, selectedImageId: activeImageId });
        return result;
      });
    }));
    extraImageIds.forEach((imageId, index) => resultById.set(imageId, extraResults[index]));
    const results = allImageIds.map((imageId) => resultById.get(imageId) || {
      status: "rejected",
      reason: new ArtifactHydrationError("artifact_payload_invalid", "MCP image artifact metadata is missing"),
    });
    if (loadSequence !== artifactLoadSequence) return;
    const candidates = artifactRecordCache.capture(
      allImageIds,
      results,
      allImageIds.map((imageId) => artifactRecordCache.get(imageId) || { id: imageId }),
    );
    const artifacts = candidates.filter((candidate) => candidate.data && candidate.loadState === "ready");
    artifactLoadInFlight = false;
    pendingImageIds = [];
    submissionStatus = "";
    if (!artifacts.length) {
      const failure = artifactLoadFailure(
        results.find(({ status }) => status === "rejected")?.reason
          || new ArtifactHydrationError("artifact_server_error", "MCP artifact tool returned an error"),
      );
      if (widgetRole === "result") resultCandidates = candidates;
      setLoadFailure(failure);
      render();
      toast(failure);
      return;
    }
    inlineStatus = "";
    inlineStatusTone = "neutral";
    applyArtifacts(artifacts, { candidates, selectedImageId: activeImageId });
  } catch (error) {
    if (loadSequence !== artifactLoadSequence) return;
    artifactLoadInFlight = false;
    submissionStatus = artifactLoadFailure(error);
    render();
    toast(submissionStatus);
  }
}
async function hydrateArtifacts(metadata, { selectedImageId = metadata.find((artifact) => artifact?.id)?.id || "" } = {}) {
  if (!hostReady) {
    pendingArtifactRecords = metadata;
    return;
  }
  const loadSequence = ++artifactLoadSequence;
  artifactLoadInFlight = true;
  pendingArtifactRecords = [];
  render();
  try {
    const seedMetadata = metadata.filter((artifact) => artifact?.id);
    const allImageIds = uniqueImageIds(seedMetadata.flatMap((artifact) => artifactLineageImageIds(artifact)));
    const metadataById = new Map(seedMetadata.map((artifact) => [artifact.id, artifact]));
    const activeImageId = selectedImageId || editor.image.id || allImageIds[0] || "";
    const pendingImageLoads = new Set(allImageIds);
    for (const imageId of allImageIds) {
      const cached = artifactRecordCache.get(imageId);
      const known = metadataById.get(imageId) || { id: imageId };
      const merged = { ...cached, ...known, id: imageId };
      artifactRecordCache.record(cached?.data && cached.loadState === "ready"
        ? merged
        : { ...merged, loadState: "loading" });
    }
    const loadingCandidates = allImageIds.map((imageId) => artifactRecordCache.get(imageId)
      || metadataById.get(imageId)
      || { id: imageId, loadState: "loading" });
    applyArtifacts(
      loadingCandidates.filter((candidate) => candidate.data && candidate.loadState === "ready"),
      { candidates: loadingCandidates, selectedImageId: activeImageId },
    );
    const loads = allImageIds.map((imageId) => {
      const cached = artifactRecordCache.get(imageId);
      const known = metadataById.get(imageId);
      const { attempt, load } = artifactCandidates.start(imageId, known);
      return artifactRecordCache.settle(load).then((result) => {
        if (loadSequence !== artifactLoadSequence) {
          captureLateArtifactResult(imageId, result, known, attempt);
          return result;
        }
        if (attempt) artifactRecordCache.captureAttempt(attempt, result, known || cached);
        pendingImageLoads.delete(imageId);
        const candidates = allImageIds.map((candidateId) => artifactRecordCache.get(candidateId)
          || metadataById.get(candidateId)
          || { id: candidateId, loadState: "loading" });
        const artifacts = candidates.filter((candidate) => candidate.data && candidate.loadState === "ready");
        artifactLoadInFlight = pendingImageLoads.has(activeImageId);
        const currentCandidate = candidates.find((candidate) => candidate.id === activeImageId);
        if (currentCandidate?.loadError) {
          inlineStatus = currentCandidate.loadError;
          inlineStatusTone = "error";
          submissionStatus = currentCandidate.loadError;
        } else if (currentCandidate?.data && currentCandidate.loadState === "ready") {
          inlineStatus = "";
          inlineStatusTone = "neutral";
          submissionStatus = "";
        }
        applyArtifacts(artifacts, { candidates, selectedImageId: activeImageId });
        return result;
      });
    });
    const results = await Promise.all(loads);
    if (loadSequence !== artifactLoadSequence) return;
    artifactLoadInFlight = false;
    pendingImageIds = [];
    pendingImageId = "";
    const candidates = allImageIds.map((imageId) => artifactRecordCache.get(imageId)
      || metadataById.get(imageId)
      || { id: imageId, loadState: "loading" });
    const artifacts = candidates.filter((candidate) => candidate.data && candidate.loadState === "ready");
    const currentCandidate = candidates.find((candidate) => candidate.id === activeImageId);
    if (!artifacts.length || currentCandidate?.loadError) {
      const failure = currentCandidate?.loadError || artifactLoadFailure(
        results.find(({ status }) => status === "rejected")?.reason
          || new ArtifactHydrationError("artifact_server_error", "MCP artifact tool returned an error"),
      );
      setLoadFailure(failure);
    } else {
      inlineStatus = "";
      inlineStatusTone = "neutral";
      submissionStatus = "";
    }
    applyArtifacts(artifacts, { candidates, selectedImageId });
  } catch (error) {
    if (loadSequence !== artifactLoadSequence) return;
    artifactLoadInFlight = false;
    const failure = artifactLoadFailure(error);
    resultCandidates = resultCandidates.map((candidate) => ({ ...candidate, loadError: failure, loadState: "error" }));
    setLoadFailure(failure);
    render();
    toast(failure);
  }
}
function ingestToolResult(result) {
  const editorSession = result?.structuredContent?.editorSession;
  if (editorSession?.id) {
    const newUiOwner = !sessionController.isUiOwner(editorSession.id);
    if (!sessionController.adopt(editorSession)) return;
    if (newUiOwner) destroyInFlight = false;
    if (newUiOwner && editorSession.draft) draftLifecycle.restoreTransferred(editorSession.draft);
    if (editorSession.status === "destroyed" && editorSession.imageId) {
      destroyedCanvasImageIds.add(editorSession.imageId);
    }
    if (editorSession.imageId && !editor.image.id) {
      pendingImageId = editorSession.imageId;
      editor = createEditorState({ image: { ...defaultImage, id: editorSession.imageId } });
    }
    if (hostReady && widgetRole === "editor") sessionController.start(editorSession.status);
    const artifacts = extractResultArtifacts(result);
    if (!artifacts.length) {
      artifactLoadSequence += 1; artifactLoadInFlight = false;
      pendingImageId = ""; pendingArtifactRecords = [];
      const failure = artifactLoadFailure({ code: result?.isError ? "artifact_server_error" : "artifact_schema_missing" });
      setLoadFailure(failure);
      render();
      return;
    }
    if (!hostReady) pendingArtifactRecords = artifacts;
    else void hydrateArtifacts(artifacts, { selectedImageId: editorSession.imageId || artifacts[0].id });
    return;
  }
  if (widgetRole === "result") {
    canvasResize.disconnect();
    const type = resultFailureCode(result) === "artifact_server_error" ? "server-error" : "tool-result";
    applyResultBootstrapEffects(resultBootstrap.observe({ type }));
    return;
  }
  const artifacts = extractResultArtifacts(result);
  if (result?.isError || !artifacts.length) {
    artifactLoadInFlight = false;
    pendingImageIds = [];
    const failure = artifactLoadFailure({
      code: result?.isError ? "artifact_server_error" : "artifact_schema_missing",
    });
    resultCandidates = resultCandidates.map((candidate) => ({ ...candidate, loadError: failure }));
    inlineStatus = failure;
    inlineStatusTone = "error";
    render();
    return;
  }
  if (!hostReady) {
    pendingArtifactRecords = artifacts;
    return;
  }
  void hydrateArtifacts(artifacts);
}
function applyResultBootstrapEffects(effects) {
  for (const effect of effects) {
    if (effect.type === "bind") {
      pendingImageIds = [...effect.imageIds]; pendingImageId = "";
      resultCandidates = effect.imageIds.map((id) => ({ ...defaultImage, id }));
      if (!editor.image.id || !effect.imageIds.includes(editor.image.id)) editor = createEditorState({ image: resultCandidates[0] });
      artifactLoadInFlight = true; inlineStatus = ""; inlineStatusTone = "neutral";
      render();
    } else if (effect.type === "start") { void loadArtifacts(effect.imageIds);
    } else if (effect.type === "fail") {
      artifactLoadSequence += 1; artifactLoadInFlight = false; pendingImageIds = [];
      const failure = artifactLoadFailure({ code: effect.code });
      resultCandidates = resultCandidates.map((candidate) => ({ ...candidate, loadError: failure, loadState: "error" }));
      inlineStatus = failure; inlineStatusTone = "error";
      render();
    }
  }
}
function applyArtifacts(artifacts, { candidates = artifacts, selectedImageId = "" } = {}) {
  const draftStatusBefore = new Map(
    candidates.map((candidate) => [candidate?.id, draftRegistry.status(candidate?.id)]),
  );
  const completedDraftImageIds = new Set(draftRegistry.reconcileArtifacts(artifacts));
  const draftConsumptionIds = new Set(
    candidates
      .filter((candidate) => {
        const before = draftStatusBefore.get(candidate?.id)?.kind;
        const after = draftRegistry.status(candidate?.id)?.kind;
        return before === "pending" && after !== "pending" && after !== "writing";
      })
      .map((candidate) => candidate.id),
  );
  for (const imageId of completedDraftImageIds) draftConsumptionIds.add(imageId);
  if (draftConsumptionIds.has(editor.image.id) || draftConsumptionIds.has(selectedImageId)) {
    submissionStatus = "";
    submissionStatusTone = "neutral";
    if (draftConsumptionIds.has(inlineStatusImageId)) {
      inlineStatus = "";
      inlineStatusTone = "neutral";
      inlineStatusImageId = "";
    }
  }
  for (const artifact of candidates) {
    artifactRecordCache.record(artifact);
  }
  for (const artifact of artifacts) {
    if (artifact.canvasStatus === "destroyed") destroyedCanvasImageIds.add(artifact.id);
  }
  const currentId = selectedImageId || editor.image.id || artifacts[0]?.id || candidates[0]?.id || "";
  const selected = candidates.find((artifact) => artifact.id === currentId)
    || artifacts.find((artifact) => artifact.id === currentId)
    || candidates[0]
    || artifacts[0]
    || {};
  const selectedIsReadable = Boolean(selected?.id && selected?.data && !selected?.loadError && selected?.loadState !== "error");
  if (!selectedIsReadable) {
    const currentIsReadable = Boolean(editor.image?.id && editor.image?.data && imageUrl);
    const failure = selected?.loadError;
    if (editor.image?.id) {
      editor = { ...editor, lineage: mergeLineageRecords(editor.lineage || [], candidates, editor.image.id) };
    }
    if (failure) {
      setLoadFailure(failure);
    }
    if (widgetRole === "result") resultCandidates = candidates;
    if (!currentIsReadable) imageUrl = "";
    render();
    return false;
  }
  const cached = currentId ? artifactRecordCache.get(currentId) : null;
  const metadata = { ...cached, ...selected };
  const image = { ...defaultImage, ...metadata, id: metadata.id || currentId };
  if (!image.id) return;
  const preserveActiveEditor = editor.image.id === image.id && Boolean(editor.image.data && imageUrl) && !completedDraftImageIds.has(image.id);
  const imageIdentityChanged = Boolean(editor.image.id && editor.image.id !== image.id);
  if (imageIdentityChanged) { discardInteraction(); colorController.close({ update: false }); }
  if (widgetRole === "result") resultCandidates = candidates;
  if (imageIdentityChanged && !completedDraftImageIds.has(editor.image.id)) draftLifecycle.saveWorking();
  const lineage = artifactLineage(image, artifactRecordCache);
  const previousLineage = editor.lineage;
  const baseEditor = createEditorState({ image, ...lineage });
  if (preserveActiveEditor) {
    editor = { ...editor, image, lineage: mergeLineageRecords(previousLineage || [], baseEditor.lineage, image.id) };
  } else {
    draftLifecycle.restoreWorking(baseEditor);
    if (previousLineage?.length && baseEditor.lineage.length) editor = { ...editor, lineage: mergeLineageRecords(previousLineage, baseEditor.lineage, image.id) };
  }
  imageUrl = toImageUrl(image);
  render();
}
function captureLateArtifactResult(imageId, result, metadata = null, attempt = null) {
  if (!attempt) return;
  const { accepted, candidate } = artifactRecordCache.captureAttempt(attempt, result, metadata);
  if (!accepted || !candidate) return;
  if (!resourceActive || widgetRole !== "editor" || destroyInFlight) return;
  if (!editor.lineage.some((item) => item.id === imageId)) return;
  editor = { ...editor, lineage: mergeLineageRecords(editor.lineage, [candidate], editor.image.id) };
  render();
}
function beginAnnotation(event) {
  if (interactionLocked() || !editor.image.id) return;
  if (event.isPrimary === false || event.button !== 0) return;
  if (event.target.closest("[data-canvas-text-editor]")) return;
  if (interaction) return;
  event.preventDefault();
  keyboardController.discard();
  textEditing.finish({ renderNow: false });
  pointerCoalescer.cancel();
  const rect = event.currentTarget.getBoundingClientRect();
  const gestureRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  const point = { x: event.clientX - gestureRect.left, y: event.clientY - gestureRect.top };
  const hitAnnotations = editor.annotationVisible ? editor.annotations : [];
  if (editor.activeTool === "text") {
    const hit = hitTestAnnotation(hitAnnotations, point, gestureRect);
    const textHit = hit?.type === "text" ? hit : null;
    if (textHit) {
      textEditing.start(textHit.id);
      return;
    }
  }
  if (editor.activeTool === "select" || editor.activeTool === "eraser") {
    const hit = hitTestAnnotation(hitAnnotations, point, gestureRect, editor.activeTool === "eraser");
    if (hit) {
      if (editor.activeTool === "eraser") {
        undoStack.push(editor);
        redoStack = [];
        editor = removeAnnotation(editor, hit.id);
        clearSubmissionStatus();
      } else {
        selectAnnotation(hit.id);
        interaction = {
          mode: "move",
          annotationId: hit.id,
          start: { x: point.x / Math.max(1, gestureRect.width), y: point.y / Math.max(1, gestureRect.height) },
          current: { x: point.x / Math.max(1, gestureRect.width), y: point.y / Math.max(1, gestureRect.height) },
          original: hit,
          before: editor,
          pointerId: event.pointerId,
          target: event.currentTarget,
          gestureRect,
          editTextOnClick: hit.type === "text",
          dragging: false,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }
      render();
    } else if (editor.activeTool === "select" && editor.selectedAnnotationId) {
      editor = { ...editor, selectedAnnotationId: null };
      render();
    }
    return;
  }
  if (!editor.annotationVisible) {
    editor = { ...editor, annotationVisible: true };
    render();
  }
  interaction = createDrawingPointerInteraction({
    start: point, pointerId: event.pointerId, target: event.currentTarget,
  });
  interaction.gestureRect = gestureRect;
  event.currentTarget.setPointerCapture?.(event.pointerId);
}
function queueAnnotationUpdate(event) {
  if (!interaction || event.pointerId !== interaction.pointerId) return;
  for (const sample of pointerSamplesFromEvent(event)) pointerCoalescer.push(sample);
}
function applyPointerSamples(samples) {
  if (!interaction || !samples.length) return;
  const latest = samples.at(-1);
  const rect = interaction.gestureRect;
  if (interaction.mode === "move") {
    const current = pointerPositionFromSample(latest, rect);
    const movement = advanceMovePointerInteraction(interaction, current, rect);
    if (!movement) return;
    const moved = translateAnnotation(
      interaction.original,
      movement.x,
      movement.y,
      { viewportWidth: rect.width, viewportHeight: rect.height },
    );
    editor = updateEditorAnnotation(editor, interaction.annotationId, moved);
    renderer.renderAnnotationLayer(editor);
    return;
  }
  appendDrawingPointerSamples(interaction, samples, rect);
  renderPreviewAnnotation();
}
function finishAnnotation(event) {
  if (!interaction || event.pointerId !== interaction.pointerId) return;
  pointerCoalescer.flushNow();
  if (interaction.mode === "move") {
    applyPointerSamples([event]);
    const changed = interaction.dragging;
    const editTextOnClick = interaction.editTextOnClick && !changed;
    const annotationId = interaction.annotationId;
    if (changed) {
      undoStack.push(interaction.before);
      redoStack = [];
      clearSubmissionStatus();
    }
    interaction = null;
    if (editTextOnClick) {
      textEditing.start(annotationId);
      return;
    }
    render();
    return;
  }
  const rect = interaction.gestureRect;
  const pointDabTool = editor.activeTool === "mask";
  const { start, end } = finishDrawingPointerInteraction(interaction, event, rect, { retainDab: pointDabTool });
  if (!hasPointerPathMoved(interaction.points) && editor.activeTool !== "text" && !pointDabTool) {
    interaction = null;
    render();
    return;
  }
  const raw = { type: editor.activeTool, x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y), points: interaction.points, text: editor.activeTool === "text" ? "标注文字" : "", color: editor.activeTool === "mask" ? maskColor(editor.maskMode) : (editor.color || "#ef4444"), strokeWidth: editor.strokeWidth || 5, ...(editor.activeTool === "mask" ? { mode: editor.maskMode, operation: editor.maskOperation, brushRadius: editor.maskBrushRadius } : {}), ...(editor.activeTool === "arrow" ? { from: start, to: end } : {}) };
  const normalized = normalizeAnnotation(raw, { viewportWidth: rect.width, viewportHeight: rect.height });
  undoStack.push(editor);
  redoStack = [];
  editor = addAnnotation(editor, normalized);
  clearSubmissionStatus();
  intentPanelOpen = true;
  interaction = null;
  if (normalized.type === "text") textEditing.start(normalized.id);
  else render();
}
function cancelAnnotation(event) {
  if (event && interaction && event.pointerId !== interaction.pointerId) return;
  discardInteraction();
  render();
}
function discardInteraction() {
  pointerCoalescer.cancel();
  const pending = interaction;
  if (pending?.mode === "move") editor = pending.before;
  interaction = null;
  keyboardController.discard();
  if (pending?.target?.hasPointerCapture?.(pending.pointerId)) {
    pending.target.releasePointerCapture(pending.pointerId);
  }
}
function handleAction(action, event) {
  if (editorDestroyed() && action !== "back") return;
  if (destroyInFlight) return;
  if (submissionInFlight && !["back", "destroy"].includes(action)) return;
  if (artifactLoadInFlight && !["back", "destroy", "confirm-destroy", "cancel-destroy"].includes(action)) return;
  if (["undo", "redo"].includes(action)) discardInteraction();
  if (action === "back") {
    returnToConversation({ preserveDraft: !editorDestroyed() });
    return;
  } else if (action === "undo" && undoStack.length) {
    redoStack.push(editor);
    editor = restoreHistoryEditor(undoStack.pop());
    clearSubmissionStatus();
  } else if (action === "redo" && redoStack.length) {
    undoStack.push(editor);
    editor = restoreHistoryEditor(redoStack.pop());
    clearSubmissionStatus();
  } else if (action === "clear") {
    if (!editor.annotations.length && !editor.prompt.trim()) return;
    clearConfirmation.open(event);
  } else if (action === "toggle-annotations") {
    editor = { ...editor, annotationVisible: !editor.annotationVisible };
  } else if (action === "toggle-intents") {
    const opening = !intentPanelOpen;
    if (opening) {
      intentPanelTrigger = event?.currentTarget?.closest?.(".top-actions [data-action=toggle-intents]")
        || event?.target?.closest?.(".top-actions [data-action=toggle-intents]")
        || root.querySelector(".top-actions [data-action=toggle-intents]");
    }
    intentPanelOpen = opening;
    render();
    if (!opening) {
      const trigger = intentPanelTrigger?.isConnected
        ? intentPanelTrigger
        : root.querySelector(".top-actions [data-action=toggle-intents]");
      intentPanelTrigger = null;
      trigger?.focus({ preventScroll: true });
    }
    return;
  } else if (action === "fit") {
    editor = { ...editor, zoom: 1 };
  } else if (action === "reveal-image") {
    void resultFileReveal.reveal(editor.image.id, { surface: "editor" });
    return;
  } else if (action === "edit-active-color") {
    colorController.toggle(editor.activeColorSlot, { focusPanel: true });
    return;
  } else if (action === "apply-foreground-color") {
    const id = event.target.closest("[data-action=apply-foreground-color]")?.dataset.annotationTarget;
    if (id) colorController.applyToAnnotation(id);
    return;
  } else if (action === "submit") {
    submitChanges();
    return;
  } else if (action === "destroy") {
    destroyConfirmation.open(event);
    return;
  } else if (action === "cancel-destroy") {
    destroyConfirmation.close();
    return;
  } else if (action === "cancel-clear") {
    clearConfirmation.close();
    return;
  } else if (action === "confirm-destroy") {
    discardInteraction();
    destroyConfirmation.close({ renderNow: false, restoreFocus: false, clearTrigger: false });
    destroyInFlight = true; artifactLoadSequence += 1; artifactLoadInFlight = false;
    render();
    void destroyEditor();
    return;
  } else if (action === "confirm-clear") {
    if (!clearConfirmation.isOpen()) return;
    clearConfirmation.close({ renderNow: false, restoreFocus: false, clearTrigger: false });
    discardInteraction();
    undoStack.push(editor);
    redoStack = [];
    draftRegistry.clearWorking(editor.image.id);
    editor = normalizeMaskOperationState({ ...editor, annotations: [], selectedAnnotationId: null, prompt: "" });
    clearSubmissionStatus();
    render();
    clearConfirmation.restoreTriggerFocus();
    return;
  } else if (action === "remove-annotation") {
    const id = event.target.closest("[data-action=remove-annotation]")?.dataset.annotationTarget;
    if (id) {
      undoStack.push(editor);
      redoStack = [];
      editor = removeAnnotation(editor, id);
      clearSubmissionStatus();
    }
  }
  render();
}
function restoreHistoryEditor(snapshot) {
  const palette = { color: editor.color, colorSlots: editor.colorSlots, activeColorSlot: editor.activeColorSlot };
  return normalizeMaskOperationState(normalizeEditorColorState({ ...snapshot, ...palette }));
}
function markEditorDestroyed(imageId) {
  if (imageId) { destroyedCanvasImageIds.add(imageId); draftRegistry.destroy(imageId); }
  resetDraft();
  submissionStatus = "画布已销毁，无法继续编辑；请返回会话";
  submissionStatusTone = "neutral";
}
async function destroyEditor() {
  let ownerSessionId = sessionController.id;
  try {
    if (!hostReady || !sessionController.id) {
      toast("当前画布会话尚未准备好");
      return;
    }
    draftLifecycle.discardServerDraft();
    try { await draftLifecycle.whenIdle(); } catch {}
    ownerSessionId = sessionController.id;
    const destroyedImageId = sessionController.imageId || editor.image.id;
    const destroyed = await sessionController.destroy();
    if (!resourceActive || !sessionController.isUiOwner(ownerSessionId)) return;
    if (!destroyed) await returnToConversation({ preserveDraft: true, ownerSessionId });
  } catch (error) { if (resourceActive && sessionController.isUiOwner(ownerSessionId)) toast("画布销毁失败"); }
  finally {
    if (!resourceActive || (ownerSessionId && !sessionController.isUiOwner(ownerSessionId))) return;
    destroyInFlight = false;
    if (widgetRole === "editor") {
      render();
      destroyConfirmation.restoreTriggerFocus();
    }
  }
}
async function returnToConversation({ preserveDraft = true, ownerSessionId = "" } = {}) {
  const ownsUi = () => !ownerSessionId || sessionController.isUiOwner(ownerSessionId);
  if (!resourceActive || !ownsUi()) return false;
  discardInteraction(); closeGuidance.close();
  if (!hostReady) {
    toast("宿主尚未连接，暂时无法返回会话");
    return false;
  }
  try {
    await draftLifecycle.flush();
  } catch {
    toast("Codex 未能保存当前画布");
    return false;
  }
  const returned = await displayModeController.request("inline");
  if (!resourceActive) return false;
  if (!ownsUi()) { if (widgetRole === "editor") await displayModeController.request("fullscreen"); return false; }
  if (!returned) {
    toast("Codex 未能返回会话视图");
    return false;
  }
  finishReturnToResult({ preserveDraft });
  return true;
}
async function returnAfterHostRestoredInline() {
  if (hostInlineReturnInFlight || !resourceActive || widgetRole !== "editor") return;
  hostInlineReturnInFlight = true;
  try {
    discardInteraction(); closeGuidance.close();
    await draftLifecycle.flush();
    if (!resourceActive || widgetRole !== "editor") return;
    const returned = await displayModeController.request("inline");
    if (!resourceActive || widgetRole !== "editor" || !returned) return;
    await app.requestTeardown();
  } catch {
    if (resourceActive && widgetRole === "editor") toast("Codex 未能保存并关闭当前画布");
  } finally {
    hostInlineReturnInFlight = false;
  }
}
function finishReturnToResult({ preserveDraft }) {
  if (preserveDraft) draftLifecycle.saveWorking();
  sessionController.stop();
  colorController.close({ update: false });
  intentPanelTrigger = null;
  destroyConfirmation.close({ renderNow: false, restoreFocus: false });
  widgetRole = "result";
  inlineStatus = "";
  inlineStatusTone = "neutral";
  inlineStatusImageId = "";
  render();
}
async function teardownDestroyedEditor(destroyedSession) {
  const ownsUi = destroyedSession.isUiOwner;
  if (!ownsUi()) { try { await destroyedSession.finalize(); } catch {} return; }
  destroyInFlight = true;
  const destroyedImageId = destroyedSession.imageId || editor.image.id;
  markEditorDestroyed(destroyedImageId);
  if (resourceActive && widgetRole === "editor") render();
  sessionController.stop();
  artifactLoadSequence += 1; artifactLoadInFlight = false;
  try { await destroyedSession.finalize(); }
  catch { if (resourceActive && ownsUi()) toast("画布已销毁，但会话清理失败"); }
  if (!ownsUi()) return;
  try { await returnToConversation({ preserveDraft: false, ownerSessionId: destroyedSession.sessionId }); }
  finally {
    if (!ownsUi()) return;
    destroyInFlight = false;
    if (resourceActive && widgetRole === "editor") render();
  }
}
function selectVersion(id) {
  if (interactionLocked()) return;
  const selected = editor.lineage.find((item) => item.id === id);
  if (!selected || id === editor.image.id) return;
  if (editor.annotations.length || editor.prompt.trim()) {
    toast("请先提交或清除当前修改，再切换版本");
    return;
  }
  discardInteraction();
  submissionStatus = "正在加载所选版本...";
  render();
  void loadArtifacts([id], { includeLineage: true, selectedImageId: id });
}

async function submitChanges() {
  const draftStatusAtSubmit = draftRegistry.status(editor.image.id, editor);
  if (editorDestroyed() || submissionInFlight || artifactLoadInFlight || draftStatusAtSubmit.kind === "pending" || (draftStatusAtSubmit.kind === "updated" && draftStatusAtSubmit.canUpdate === false) || !editor.image.id || (!editor.annotations.length && !editor.prompt.trim())) return;
  const updatingTaskInput = draftStatusAtSubmit.kind === "updated";
  if (!hostReady) {
    submissionStatus = "宿主尚未连接，暂时无法提交";
    render();
    return;
  }
  discardInteraction();
  submissionInFlight = true;
  submissionStatus = editor.annotations.length ? "正在保存标注..." : "正在准备修改请求...";
  submissionStatusTone = "progress";
  render();
  try {
    const result = await submissionCoordinator.submit(editor, (stage) => {
      if (!resourceActive) return;
      submissionStatus = submissionProgressStatus(stage, Boolean(editor.annotations.length));
      submissionStatusTone = "progress";
      render();
    });
    submissionInFlight = false;
    if (!resourceActive) return;
    const composerAcknowledged = result.delivery !== "composer" || result.contextAcknowledged;
    const composerStatus = composerSubmissionStatus(result, updatingTaskInput);
    submissionStatus = composerStatus;
    submissionStatusTone = composerAcknowledged ? "success" : "error";
    if (result.delivery === "composer") {
      draftLifecycle.saveWorking();
      draftRegistry.markPending(editor.image.id, {
        submissionId: result.submissionId,
        annotationId: result.annotationId,
        revisionSha256: result.revisionSha256,
        contextAcknowledged: result.contextAcknowledged,
        updatingTaskInput,
        snapshot: result.snapshot,
      });
    } else {
      draftRegistry.destroy(editor.image.id);
      resetDraft();
    }
    render();
    const returned = await returnToConversation();
    if (!resourceActive) return;
    if (returned && result.delivery === "composer") {
      inlineStatus = composerStatus;
      inlineStatusTone = composerAcknowledged ? "success" : "error";
      inlineStatusImageId = editor.image.id;
      render();
    }
    observeComposerContext(result, draftRegistry, ({ imageId, status, tone }) => {
      if (editor.image.id === imageId) {
        submissionStatus = status;
        submissionStatusTone = tone;
      }
      if (inlineStatusImageId === imageId) {
        inlineStatus = status;
        inlineStatusTone = tone;
      }
      render();
    }, () => resourceActive);
  } catch (error) {
    submissionInFlight = false;
    if (!resourceActive || error?.stage === "inactive") return;
    submissionStatus = submissionErrorStatus(error?.stage);
    submissionStatusTone = "error";
    render();
  }
}
function resetDraft() {
  discardInteraction();
  editor = normalizeMaskOperationState({ ...editor, annotations: [], selectedAnnotationId: null, editingTextAnnotationId: null, prompt: "" });
  undoStack = [];
  redoStack = [];
  submissionCoordinator.reset();
}
function render() {
  document.body.dataset.view = widgetRole;
  if (widgetRole === "result") {
    if (resultPreview.isActive()) { resultPreview.reconcile(); widgetI18n.localizeTree(root); return; }
    uiCleanup?.();
    canvasResize.disconnect();
    renderer.renderInline({
      candidates: (resultCandidates.length ? resultCandidates : [editor.image]).map((candidate) => ({
        ...candidate,
        imageUrl: toImageUrl(candidate),
        canvasStatus: destroyedCanvasImageIds.has(candidate.id) ? "destroyed" : (candidate.canvasStatus || "available"),
        draftState: draftRegistry.status(candidate.id),
      })),
      openingImageId,
      inlineStatus,
      inlineStatusTone,
      inlineStatusImageId,
      onOpen: requestOpenEditor,
      onPreview: resultPreview.open,
      signal: resourceAbortController.signal,
    });
    resultPreview.reconcile();
    widgetI18n.localizeTree(root);
    return;
  }
  if (!renderer.isEditorMounted()) {
    renderer.mountEditor();
    bindUi();
    canvasResize.observe(root.querySelector(".canvas-frame"));
  }
  renderer.updateEditor({
    editor,
    imageUrl,
    submissionInFlight,
    artifactLoadInFlight,
    destroyInFlight,
    destroyedEditorTerminal: editorDestroyed(),
    revealInFlightImageId: resultFileReveal.isInFlight(editor.image.id) ? editor.image.id : "",
    undoCount: undoStack.length,
    redoCount: redoStack.length,
    modelCapabilities,
    intentPanelOpen,
    destroyConfirmOpen: destroyConfirmation.isOpen(),
    clearConfirmOpen: clearConfirmation.isOpen(),
    ...colorController.state(),
    draftState: draftRegistry.status(editor.image.id, editor),
    submissionStatus: submissionStatus || draftStatusMessage(draftRegistry.status(editor.image.id, editor)),
    submissionStatusTone,
  });
  keyboardController.renderLayer();
  bindDynamicUi();
  colorController.position();
  widgetI18n.localizeTree(root);
  draftLifecycle.track();
}
function selectAnnotation(id) {
  if (interactionLocked()) return;
  const selected = editor.annotations.find((item) => item.id === id);
  if (!selected) return;
  if (selected.type === "mask") colorController.close({ update: false });
  editor = {
    ...editor,
    activeTool: selected.type === "mask" ? "select" : editor.activeTool,
    selectedAnnotationId: id,
    editingTextAnnotationId: null,
    ...(selected.type === "mask" ? {} : { strokeWidth: selected.strokeWidth || editor.strokeWidth }),
  };
}
function activateTool(tool) {
  if (interactionLocked()) return;
  discardInteraction();
  textEditing.finish({ renderNow: false });
  colorController.close({ update: false });
  tool.focus({ preventScroll: true });
  const activeTool = tool.dataset.tool;
  editor = normalizeMaskOperationState({ ...editor, activeTool, editingTextAnnotationId: null, selectedAnnotationId: activeTool === "select" ? editor.selectedAnnotationId : null });
  render();
}
function updateMaskSetting({ maskMode = editor.maskMode, maskOperation = editor.maskOperation, maskBrushRadius = editor.maskBrushRadius }) {
  if (interactionLocked()) return;
  discardInteraction();
  const resolvedOperation = resolveMaskOperation(editor.annotations, maskMode, maskOperation);
  const changed = editor.activeTool !== "mask"
    || editor.selectedAnnotationId !== null
    || editor.maskMode !== maskMode
    || editor.maskOperation !== resolvedOperation
    || editor.maskBrushRadius !== maskBrushRadius;
  if (!changed) { render(); return; }
  editor = {
    ...editor,
    activeTool: "mask",
    selectedAnnotationId: null,
    editingTextAnnotationId: null,
    maskMode,
    maskOperation: resolvedOperation,
    maskBrushRadius,
  };
  clearSubmissionStatus();
  render();
}

function applyMaskControl(control) {
  if (!control) return false;
  if (control.disabled || control.getAttribute("aria-disabled") === "true") return true;
  if (control.dataset.maskMode) updateMaskSetting({ maskMode: control.dataset.maskMode });
  else if (control.dataset.maskOperation) updateMaskSetting({ maskOperation: control.dataset.maskOperation });
  else updateMaskSetting({ maskBrushRadius: Number(control.dataset.maskRadius) });
  return true;
}

function renderPreviewAnnotation() {
  if (!interaction) return;
  const rect = interaction.gestureRect;
  const item = normalizeAnnotation({ type: editor.activeTool, x: Math.min(interaction.start.x, interaction.current.x), y: Math.min(interaction.start.y, interaction.current.y), width: Math.abs(interaction.current.x - interaction.start.x), height: Math.abs(interaction.current.y - interaction.start.y), points: interaction.points, color: editor.activeTool === "mask" ? maskColor(editor.maskMode) : (editor.color || "#ef4444"), strokeWidth: editor.strokeWidth || 5, ...(editor.activeTool === "mask" ? { mode: editor.maskMode, operation: editor.maskOperation, brushRadius: editor.maskBrushRadius } : {}), ...(editor.activeTool === "arrow" ? { from: interaction.start, to: interaction.current } : {}) }, { viewportWidth: rect.width, viewportHeight: rect.height });
  renderer.renderPreviewAnnotation(editor, item);
}

function clearSubmissionStatus() {
  const draftStatus = draftRegistry.status(editor.image.id, editor);
  submissionStatus = draftStatusMessage(draftStatus);
  submissionStatusTone = "neutral";
  const element = root.querySelector("[data-submit-status]");
  if (!element) return;
  element.textContent = submissionStatus;
  element.dataset.statusTone = "neutral";
  element.classList.toggle("visible", Boolean(submissionStatus));
  const submitButton = root.querySelector("[data-action=submit]");
  if (submitButton) {
    submitButton.disabled = submissionInFlight || draftStatus.kind === "pending" || (draftStatus.kind === "updated" && draftStatus.canUpdate === false) || !editor.image.id || (!editor.annotations.length && !editor.prompt.trim());
    submitButton.textContent = draftStatus.kind === "pending" ? "已放入输入框" : draftStatus.kind === "updated" ? draftStatus.canUpdate === false ? "等待上一版确认" : "更新任务输入框" : draftStatus.kind === "writing" ? "重新确认" : "提交修改";
  }
}
