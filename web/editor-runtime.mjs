import {
  addAnnotation,
  createEditorState,
  normalizeAnnotation,
  removeAnnotation,
  translateAnnotation,
  updateAnnotation as updateEditorAnnotation,
} from "./editor-state.mjs";
import { hitTestAnnotation } from "./editor-annotation-view.mjs";
import { createSubmissionCoordinator } from "./editor-submission.mjs";
import { createEditorSessionController } from "./editor-session-controller.mjs";
import { createEditorRenderer } from "./editor-renderer.mjs";
import { artifactLineage, extractResultArtifacts, hydrateResultArtifacts } from "./result-state.mjs";
import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";

const defaultImage = {
  id: "",
  mimeType: "image/png",
  width: 1,
  height: 1,
  operation: "generate",
  parentIds: [],
};

const root = document.querySelector("main");
const renderer = createEditorRenderer(root);
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
let intentPanelOpen = false;
let artifactLoadSequence = 0;
let artifactLoadInFlight = false;
let modelCapabilities = null;
const destroyedCanvasImageIds = new Set();
const app = new App({ name: "openai-compatible-imagegen-v2-editor", version: "0.1.0" }, {});
const submissionCoordinator = createSubmissionCoordinator({ app });
const sessionController = createEditorSessionController({
  app,
  setIntervalFn: window.setInterval.bind(window),
  clearIntervalFn: window.clearInterval.bind(window),
  onDestroyed: teardownDestroyedEditor,
  onError: () => toast("无法确认画布会话状态"),
});

render();
connectHost();

function bindUi() {
  root.onclick = (event) => {
    const annotation = event.target.closest("[data-annotation-id]");
    if (annotation && !event.target.closest("textarea, button")) {
      selectAnnotation(annotation.dataset.annotationId);
      render();
      return;
    }
    const tool = event.target.closest("[data-tool]");
    if (tool) {
      editor = { ...editor, activeTool: tool.dataset.tool };
      render();
      return;
    }
    const swatch = event.target.closest("[data-color]");
    if (swatch) {
      const color = swatch.dataset.color;
      if (editor.selectedAnnotationId) {
        undoStack.push(editor);
        redoStack = [];
        editor = updateEditorAnnotation({ ...editor, color }, editor.selectedAnnotationId, { color });
      } else {
        editor = { ...editor, color };
      }
      render();
      return;
    }
    const stroke = event.target.closest("[data-stroke]");
    if (stroke) {
      const strokeWidth = Number(stroke.dataset.stroke);
      if (editor.selectedAnnotationId) {
        undoStack.push(editor);
        redoStack = [];
        editor = updateEditorAnnotation({ ...editor, strokeWidth }, editor.selectedAnnotationId, { strokeWidth });
      } else {
        editor = { ...editor, strokeWidth };
      }
      render();
      return;
    }
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action) handleAction(action, event);
    const version = event.target.closest("[data-version-id]");
    if (version) selectVersion(version.dataset.versionId);
  };
  // Keep host-facing actions on the button itself. Some Codex App surfaces
  // do not reliably bubble clicks from replaced widget content to <main>.
  root.querySelectorAll("[data-action]").forEach((button) => {
    if (["open-editor"].includes(button.dataset.action)) return;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void handleAction(button.dataset.action, event);
    });
  });
  root.oninput = (event) => {
    const field = event.target.closest("[data-annotation-text]");
    if (!field) return;
    editor = updateEditorAnnotation(editor, field.dataset.annotationText, { text: field.value });
    clearSubmissionStatus();
    const count = field.closest("[data-annotation-id]")?.querySelector("[data-annotation-count]");
    if (count) count.textContent = `${field.value.length}/600`;
    renderer.renderAnnotationLayer(editor);
  };
  root.addEventListener("focusin", (event) => {
    const field = event.target.closest("[data-annotation-text]");
    if (!field || editor.selectedAnnotationId === field.dataset.annotationText) return;
    selectAnnotation(field.dataset.annotationText);
    intentPanelOpen = true;
    root.querySelectorAll("[data-annotation-id]").forEach((item) => {
      item.classList.toggle("selected", item.dataset.annotationId === editor.selectedAnnotationId);
    });
    renderer.renderAnnotationLayer(editor);
  });
  root.onkeydown = (event) => {
    if (submissionInFlight || event.target.closest("textarea, select")) return;
    const modifier = event.ctrlKey || event.metaKey;
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
      render();
      event.preventDefault();
    }
  };

  root.querySelector("[data-zoom-select]").addEventListener("change", (event) => {
    editor = { ...editor, zoom: Number(event.target.value) };
    render();
  });
  root.querySelector("[data-prompt]").addEventListener("input", (event) => {
    editor = { ...editor, prompt: event.target.value };
    clearSubmissionStatus();
    root.querySelector("[data-prompt-count]").textContent = `${event.target.value.length}/600`;
    root.querySelector("[data-action=submit]").disabled = submissionInFlight || !editor.image.id || (!editor.annotations.length && !editor.prompt.trim());
    root.querySelector("[data-action=clear]").disabled = submissionInFlight || (!editor.annotations.length && !editor.prompt.trim());
  });
  const canvas = root.querySelector("[data-canvas]");
  canvas.addEventListener("pointerdown", beginAnnotation);
  canvas.addEventListener("pointerup", finishAnnotation);
  canvas.addEventListener("pointercancel", cancelAnnotation);
  canvas.addEventListener("pointermove", updateAnnotation);
}

async function connectHost() {
  app.ontoolinput = (params) => ingestToolInput(params);
  app.ontoolresult = (params) => ingestToolResult(params);
  app.onhostcontextchanged = (params) => {
    if (applyHostContext(params)) render();
  };
  app.onteardown = async () => {
    sessionController.stop();
    await sessionController.finalize();
    return {};
  };
  try {
    await app.connect(new PostMessageTransport(window.parent, window.parent));
    applyHostContext(app.getHostContext(), { initializeRole: true });
    hostReady = true;
    render();
    loadModelCapabilities();
    if (widgetRole === "editor") await requestDisplayMode("fullscreen");
    if (pendingArtifactRecords.length) hydrateArtifacts(pendingArtifactRecords);
    if (widgetRole === "editor" && sessionController.id) sessionController.start();
    render();
  } catch (error) {
    inlineStatus = "宿主连接失败，请重新打开当前图片";
    inlineStatusTone = "error";
    render();
  }
}

async function loadModelCapabilities() {
  try {
    const result = await app.callServerTool({ name: "list_image_models", arguments: {} });
    const model = result?.structuredContent?.models?.find((item) => item.id === "primary/gpt-image-2");
    if (result.isError || !model?.capabilities) throw new Error("model capabilities unavailable");
    modelCapabilities = model.capabilities;
    if (!modelCapabilities.mask && editor.activeTool === "mask") editor = { ...editor, activeTool: "select" };
    render();
  } catch (error) {
    modelCapabilities = {};
    if (editor.activeTool === "mask") editor = { ...editor, activeTool: "select" };
    render();
    toast("无法读取当前模型能力");
  }
}

function applyHostContext(context, { initializeRole = false } = {}) {
  let changed = false;
  if (initializeRole) {
    const nextRole = context?.toolInfo?.tool?.name === "open_image_editor" ? "editor" : "result";
    if (nextRole !== widgetRole) {
      widgetRole = nextRole;
      changed = true;
    }
  }
  if (context?.displayMode && context.displayMode !== displayMode) {
    displayMode = context.displayMode;
    changed = true;
  }
  if (Array.isArray(context?.availableDisplayModes) && !sameValues(context.availableDisplayModes, availableDisplayModes)) {
    availableDisplayModes = context.availableDisplayModes;
    changed = true;
  }
  return changed;
}

async function requestOpenEditor(imageId = editor.image.id) {
  if (openingInFlight) return;
  if (destroyedCanvasImageIds.has(imageId)) {
    inlineStatus = "画布已销毁";
    inlineStatusTone = "neutral";
    inlineStatusImageId = imageId;
    render();
    return;
  }
  const selectedCandidate = resultCandidates.find((item) => item.id === imageId);
  if (selectedCandidate && selectedCandidate.id !== editor.image.id) {
    editor = createEditorState({ image: selectedCandidate, ...artifactLineage(selectedCandidate) });
    imageUrl = toImageUrl(selectedCandidate);
    undoStack = [];
    redoStack = [];
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
  inlineStatus = "正在打开画布...";
  inlineStatusTone = "progress";
  inlineStatusImageId = editor.image.id;
  openingInFlight = true;
  openingImageId = editor.image.id;
  render();
  try {
    if (!(await ensureEditorSession())) return;
    const opened = await requestDisplayMode("fullscreen");
    if (!opened) return;
    inlineStatus = "";
    inlineStatusTone = "neutral";
    inlineStatusImageId = "";
    widgetRole = "editor";
    render();
    sessionController.start();
  } catch (error) {
    widgetRole = "result";
    inlineStatus = "画布打开失败";
    inlineStatusTone = "error";
    inlineStatusImageId = editor.image.id;
    render();
  } finally {
    openingInFlight = false;
    openingImageId = "";
    if (widgetRole === "result") render();
  }
}

async function ensureEditorSession() {
  try {
    const { opened, result } = await sessionController.ensure(editor.image.id);
    if (opened) ingestToolResult(result);
    return true;
  } catch (error) {
    inlineStatus = "Codex 未能打开画布";
    inlineStatusTone = "error";
    inlineStatusImageId = editor.image.id;
    render();
    return false;
  }
}

async function requestDisplayMode(mode) {
  if (!hostReady) {
    inlineStatus = "宿主尚未连接，暂时无法打开画布";
    inlineStatusTone = "error";
    render();
    return false;
  }
  if (!availableDisplayModes.includes(mode)) {
    inlineStatus = mode === "fullscreen" ? "当前 Codex App 不支持展开画布" : "当前 Codex App 不支持返回内联视图";
    inlineStatusTone = "error";
    render();
    return false;
  }
  try {
    const result = await app.requestDisplayMode({ mode });
    displayMode = result.mode;
    inlineStatus = result.mode === mode ? "" : "宿主未切换到请求的显示模式";
    inlineStatusTone = result.mode === mode ? "neutral" : "error";
    render();
    return result.mode === mode;
  } catch (error) {
    inlineStatus = "画布显示模式切换失败";
    inlineStatusTone = "error";
    render();
    return false;
  }
}

function ingestToolInput(input) {
  const imageIds = input?.arguments?.imageIds || input?.imageIds || input?._meta?.imageIds || [];
  if (Array.isArray(imageIds) && imageIds.length) {
    pendingImageIds = [...imageIds];
    resultCandidates = imageIds.map((id) => ({ ...defaultImage, id }));
    if (!editor.image.id) editor = createEditorState({ image: resultCandidates[0] });
    artifactLoadInFlight = true;
    render();
    return;
  }
  const imageId = input?._meta?.imageId || input?.imageId || input?.arguments?.imageId;
  if (imageId) {
    pendingImageId = imageId;
    if (!editor.image.id) editor = createEditorState({ image: { ...defaultImage, id: imageId } });
    artifactLoadInFlight = true;
  }
  render();
}

async function loadArtifact(imageId) {
  await loadArtifacts([imageId]);
}

async function loadArtifacts(imageIds) {
  if (!hostReady) return;
  const requestedImageIds = [...imageIds];
  const loadSequence = ++artifactLoadSequence;
  artifactLoadInFlight = true;
  render();
  pendingImageIds = [];
  if (requestedImageIds.includes(pendingImageId)) pendingImageId = "";
  try {
    const results = await Promise.all(requestedImageIds.map((imageId) =>
      app.callServerTool({ name: "get_image_artifact", arguments: { imageId } })));
    if (loadSequence !== artifactLoadSequence) return;
    if (results.some((result) => result.isError)) throw new Error("artifact load failed");
    const metadata = results.map((result) => ({
      ...extractResultArtifacts(result)[0],
      canvasStatus: result?.structuredContent?.canvasStatus || "available",
    }));
    if (metadata.some((artifact) => !artifact?.id)) throw new Error("artifact metadata unavailable");
    const artifacts = await hydrateResultArtifacts(app, metadata);
    artifactLoadInFlight = false;
    submissionStatus = "";
    applyArtifacts(artifacts);
  } catch (error) {
    if (loadSequence !== artifactLoadSequence) return;
    artifactLoadInFlight = false;
    submissionStatus = artifactLoadFailure(error);
    render();
    toast(submissionStatus);
  }
}

async function hydrateArtifacts(metadata) {
  if (!hostReady) {
    pendingArtifactRecords = metadata;
    return;
  }
  const loadSequence = ++artifactLoadSequence;
  artifactLoadInFlight = true;
  pendingArtifactRecords = [];
  render();
  try {
    if (metadata.some((artifact) => !artifact?.id)) {
      throw new Error("artifact metadata unavailable");
    }
    const artifacts = await hydrateResultArtifacts(app, metadata);
    if (loadSequence !== artifactLoadSequence) return;
    artifactLoadInFlight = false;
    pendingImageIds = [];
    pendingImageId = "";
    inlineStatus = "";
    submissionStatus = "";
    applyArtifacts(artifacts);
  } catch (error) {
    if (loadSequence !== artifactLoadSequence) return;
    artifactLoadInFlight = false;
    const failure = artifactLoadFailure(error);
    resultCandidates = resultCandidates.map((candidate) => ({ ...candidate, loadError: failure }));
    inlineStatus = failure;
    inlineStatusTone = "error";
    submissionStatus = failure;
    render();
    toast(failure);
  }
}

function ingestToolResult(result) {
  const editorSession = result?.structuredContent?.editorSession;
  if (editorSession?.id) {
    if (editorSession.status === "destroyed" && editorSession.imageId) {
      destroyedCanvasImageIds.add(editorSession.imageId);
    }
    sessionController.adopt(editorSession);
    if (editorSession.imageId && !editor.image.id) {
      pendingImageId = editorSession.imageId;
      editor = createEditorState({ image: { ...defaultImage, id: editorSession.imageId } });
    }
    if (hostReady && widgetRole === "editor") sessionController.start(editorSession.status);
    if (editor.image.data) {
      render();
      return;
    }
  }
  const artifacts = extractResultArtifacts(result);
  if (result?.isError || !artifacts.length) {
    artifactLoadInFlight = false;
    pendingImageIds = [];
    const failure = artifactLoadFailure({ code: "artifact_result_invalid" });
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

function applyArtifacts(artifacts) {
  for (const artifact of artifacts) {
    if (artifact.canvasStatus === "destroyed") destroyedCanvasImageIds.add(artifact.id);
  }
  const selected = artifacts.find((artifact) => artifact.id === editor.image.id);
  const metadata = selected || artifacts[0] || {};
  const image = { ...defaultImage, ...metadata, id: metadata.id || editor.image.id };
  if (!image.id) return;
  if (widgetRole === "result") resultCandidates = artifacts;
  editor = createEditorState({ image, ...artifactLineage(image) });
  imageUrl = toImageUrl(image);
  render();
}

function beginAnnotation(event) {
  if (submissionInFlight || artifactLoadInFlight || !editor.image.id) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  if (editor.activeTool === "select" || editor.activeTool === "eraser") {
    const hit = hitTestAnnotation(editor.annotations, point, rect, editor.activeTool === "eraser");
    if (hit) {
      if (editor.activeTool === "eraser") {
        undoStack.push(editor);
        redoStack = [];
        editor = removeAnnotation(editor, hit.id);
      } else {
        selectAnnotation(hit.id);
        interaction = {
          mode: "move",
          annotationId: hit.id,
          start: { x: point.x / Math.max(1, rect.width), y: point.y / Math.max(1, rect.height) },
          current: { x: point.x / Math.max(1, rect.width), y: point.y / Math.max(1, rect.height) },
          original: hit,
          before: editor,
          pointerId: event.pointerId,
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
  interaction = { start: point, current: point, points: [point], pointerId: event.pointerId };
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function updateAnnotation(event) {
  if (!interaction) return;
  const rect = event.currentTarget.getBoundingClientRect();
  if (interaction.mode === "move") {
    interaction.current = {
      x: (event.clientX - rect.left) / Math.max(1, rect.width),
      y: (event.clientY - rect.top) / Math.max(1, rect.height),
    };
    const moved = translateAnnotation(
      interaction.original,
      interaction.current.x - interaction.start.x,
      interaction.current.y - interaction.start.y,
    );
    editor = updateEditorAnnotation(editor, interaction.annotationId, moved);
    renderer.renderAnnotationLayer(editor);
    return;
  }
  interaction.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  interaction.points.push(interaction.current);
  renderPreviewAnnotation();
}

function finishAnnotation(event) {
  if (!interaction) return;
  if (interaction.mode === "move") {
    const changed = editor.annotations.find((item) => item.id === interaction.annotationId) !== interaction.original;
    if (changed) {
      undoStack.push(interaction.before);
      redoStack = [];
    }
    interaction = null;
    render();
    return;
  }
  const rect = event.currentTarget.getBoundingClientRect();
  const end = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  const start = interaction.start;
  if (Math.hypot(end.x - start.x, end.y - start.y) < 3 && editor.activeTool !== "text") {
    interaction = null;
    render();
    return;
  }
  const lastPoint = interaction.points.at(-1);
  if (!lastPoint || lastPoint.x !== end.x || lastPoint.y !== end.y) interaction.points.push(end);
  const raw = { type: editor.activeTool, x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y), points: interaction.points, text: editor.activeTool === "text" ? "标注文字" : "", color: editor.color || "#ef4444", strokeWidth: editor.strokeWidth || 5, ...(editor.activeTool === "arrow" ? { from: start, to: end } : {}) };
  const normalized = normalizeAnnotation(raw, { viewportWidth: rect.width, viewportHeight: rect.height });
  undoStack.push(editor);
  redoStack = [];
  editor = addAnnotation(editor, normalized);
  intentPanelOpen = true;
  interaction = null;
  render();
  if (editor.activeTool === "text") {
    const field = [...root.querySelectorAll("[data-annotation-text]")].find((candidate) => candidate.dataset.annotationText === normalized.id);
    field?.focus({ preventScroll: true });
    field?.select();
  }
}

function cancelAnnotation() {
  if (interaction?.mode === "move") editor = interaction.before;
  interaction = null;
  render();
}

function handleAction(action, event) {
  if (submissionInFlight && !["back", "destroy"].includes(action)) return;
  if (artifactLoadInFlight && !["back", "destroy"].includes(action)) return;
  if (action === "back") {
    returnToConversation();
    return;
  } else if (action === "undo" && undoStack.length) {
    redoStack.push(editor);
    editor = undoStack.pop();
  } else if (action === "redo" && redoStack.length) {
    undoStack.push(editor);
    editor = redoStack.pop();
  } else if (action === "clear") {
    if (!editor.annotations.length && !editor.prompt.trim()) return;
    undoStack.push(editor);
    redoStack = [];
    editor = { ...editor, annotations: [], selectedAnnotationId: null, prompt: "" };
    submissionStatus = "";
    submissionStatusTone = "neutral";
  } else if (action === "toggle-annotations") {
    editor = { ...editor, annotationVisible: !editor.annotationVisible };
  } else if (action === "toggle-intents") {
    intentPanelOpen = !intentPanelOpen;
  } else if (action === "fit") {
    editor = { ...editor, zoom: 1 };
  } else if (action === "submit") {
    submitChanges();
    return;
  } else if (action === "destroy") {
    destroyEditor();
    return;
  } else if (action === "remove-annotation") {
    const id = event.target.closest("[data-action=remove-annotation]")?.dataset.annotationTarget;
    if (id) {
      undoStack.push(editor);
      redoStack = [];
      editor = removeAnnotation(editor, id);
    }
  }
  render();
}

async function destroyEditor() {
  if (!hostReady || !sessionController.id) {
    toast("当前画布会话尚未准备好");
    return;
  }
  try {
    const destroyedImageId = editor.image.id;
    await sessionController.destroy();
    destroyedCanvasImageIds.add(destroyedImageId);
    resetDraft();
    await returnToConversation();
  } catch (error) {
    toast("画布销毁失败");
  }
}

async function returnToConversation() {
  if (!hostReady) {
    toast("宿主尚未连接，暂时无法返回会话");
    return false;
  }
  const returned = await requestDisplayMode("inline");
  if (!returned) {
    toast("Codex 未能返回会话视图");
    return false;
  }
  sessionController.stop();
  widgetRole = "result";
  inlineStatus = "";
  inlineStatusTone = "neutral";
  inlineStatusImageId = "";
  render();
  return true;
}

async function teardownDestroyedEditor() {
  sessionController.stop();
  if (editor.image.id) destroyedCanvasImageIds.add(editor.image.id);
  await sessionController.finalize();
  resetDraft();
  await returnToConversation();
}

function selectVersion(id) {
  const selected = editor.lineage.find((item) => item.id === id);
  if (!selected || id === editor.image.id) return;
  if (editor.annotations.length || editor.prompt.trim()) {
    toast("请先提交或清除当前修改，再切换版本");
    return;
  }
  submissionStatus = "正在加载所选版本...";
  render();
  loadArtifact(id);
}

async function submitChanges() {
  if (submissionInFlight || artifactLoadInFlight || !editor.image.id || (!editor.annotations.length && !editor.prompt.trim())) return;
  if (!hostReady) {
    submissionStatus = "宿主尚未连接，暂时无法提交";
    render();
    return;
  }
  submissionInFlight = true;
  submissionStatus = editor.annotations.length ? "正在保存标注..." : "正在准备修改请求...";
  submissionStatusTone = "progress";
  render();
  try {
    await submissionCoordinator.submit(editor, (stage) => {
      submissionStatus = {
        preview: editor.annotations.length ? "正在生成标注预览..." : "正在准备修改请求...",
        annotations: editor.annotations.length ? "正在保存标注..." : "正在准备修改请求...",
        context: "正在准备修改请求...",
        message: "正在发送到会话...",
      }[stage];
      submissionStatusTone = "progress";
      render();
    });
    submissionInFlight = false;
    submissionStatus = "修改请求已发送";
    submissionStatusTone = "success";
    resetDraft();
    render();
    await returnToConversation();
  } catch (error) {
    submissionInFlight = false;
    submissionStatus = {
      preview: "标注预览生成失败，请重试",
      annotations: "标注保存失败，请重试",
      context: "模型上下文更新失败，请重试",
      message: "会话消息发送失败，请重试",
    }[error?.stage] || "提交失败，请重试";
    submissionStatusTone = "error";
    render();
  }
}

function resetDraft() {
  editor = { ...editor, annotations: [], selectedAnnotationId: null, prompt: "" };
  undoStack = [];
  redoStack = [];
  submissionCoordinator.reset();
}

function render() {
  document.body.dataset.view = widgetRole;
  if (widgetRole === "result") {
    renderer.renderInline({
      candidates: (resultCandidates.length ? resultCandidates : [editor.image]).map((candidate) => ({
        ...candidate,
        imageUrl: toImageUrl(candidate),
        canvasStatus: destroyedCanvasImageIds.has(candidate.id) ? "destroyed" : (candidate.canvasStatus || "available"),
      })),
      openingImageId,
      inlineStatus,
      inlineStatusTone,
      inlineStatusImageId,
      onOpen: requestOpenEditor,
    });
    return;
  }
  if (!renderer.isEditorMounted()) {
    renderer.mountEditor();
    bindUi();
  }
  renderer.updateEditor({
    editor,
    imageUrl,
    submissionInFlight,
    artifactLoadInFlight,
    undoCount: undoStack.length,
    redoCount: redoStack.length,
    modelCapabilities,
    intentPanelOpen,
    submissionStatus,
    submissionStatusTone,
  });
}

function selectAnnotation(id) {
  const selected = editor.annotations.find((item) => item.id === id);
  if (!selected) return;
  editor = {
    ...editor,
    selectedAnnotationId: id,
    color: selected.color || editor.color,
    strokeWidth: selected.strokeWidth || editor.strokeWidth,
  };
}

function renderPreviewAnnotation() {
  if (!interaction) return;
  const rect = root.querySelector("[data-canvas]").getBoundingClientRect();
  const item = normalizeAnnotation({ type: editor.activeTool, x: Math.min(interaction.start.x, interaction.current.x), y: Math.min(interaction.start.y, interaction.current.y), width: Math.abs(interaction.current.x - interaction.start.x), height: Math.abs(interaction.current.y - interaction.start.y), points: interaction.points, color: editor.color || "#ef4444", strokeWidth: editor.strokeWidth || 5, ...(editor.activeTool === "arrow" ? { from: interaction.start, to: interaction.current } : {}) }, { viewportWidth: rect.width, viewportHeight: rect.height });
  renderer.renderPreviewAnnotation(editor, item);
}

function toImageUrl(image) {
  return image?.data ? `data:${image.mimeType || "image/png"};base64,${image.data}` : "";
}

function artifactLoadFailure(error) {
  const stage = {
    artifact_bridge_unavailable: "IMG-BRIDGE",
    artifact_tool_call_failed: "IMG-TOOL-CALL",
    artifact_server_error: "IMG-SERVER",
    artifact_payload_invalid: "IMG-PAYLOAD",
    artifact_result_invalid: "IMG-RESULT",
  }[error?.code] || "IMG-UNKNOWN";
  return `图片读取失败 · ${stage}`;
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}



function toast(message) {
  const element = root.querySelector("[data-toast]");
  if (!element) {
    inlineStatus = message;
    inlineStatusTone = "error";
    render();
    return;
  }
  element.textContent = message;
  element.classList.add("visible");
  window.setTimeout(() => element.classList.remove("visible"), 2800);
}

function clearSubmissionStatus() {
  submissionStatus = "";
  submissionStatusTone = "neutral";
  const element = root.querySelector("[data-submit-status]");
  if (!element) return;
  element.textContent = "";
  element.dataset.statusTone = "neutral";
  element.classList.remove("visible");
}
