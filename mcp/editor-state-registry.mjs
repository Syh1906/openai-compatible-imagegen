import { randomBytes } from "node:crypto";


const BINDING_KEY_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_ID_PATTERN = /^img_[0-9A-HJKMNP-TV-Z]{26}$/;
const SESSION_ID_PATTERN = /^eds_[0-9a-f]{32}$/;


export function createEditorStateRegistry({ idFactory = createEditorSessionId } = {}) {
  if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
  const records = new Map();

  return Object.freeze({ open, getSession, destroy, finalize, getCanvasStatuses });

  async function open(input) {
    const { bindingKey, imageId } = normalizeImageInput(input);
    const images = imagesFor(records, bindingKey);
    let image = images.get(imageId);
    if (image?.canvasStatus === "destroyed") throw editorStateError("image_canvas_destroyed");
    if (!image) {
      image = { canvasStatus: "available", sessionIds: new Set() };
      images.set(imageId, image);
    }
    const id = idFactory();
    if (!SESSION_ID_PATTERN.test(id) || findSession(images, id)) {
      throw new TypeError("idFactory must return a unique eds_ ID with 32 lowercase hex characters");
    }
    image.sessionIds.add(id);
    return sessionResult(id, imageId, "active");
  }

  async function getSession(input) {
    const { bindingKey, editorSessionId } = normalizeSessionInput(input);
    const found = findSession(records.get(bindingKey), editorSessionId);
    return found
      ? sessionResult(editorSessionId, found.imageId, found.image.canvasStatus === "destroyed" ? "destroyed" : "active")
      : null;
  }

  async function destroy(input) {
    const { bindingKey, editorSessionId } = normalizeSessionInput(input);
    const found = findSession(records.get(bindingKey), editorSessionId);
    if (!found) return null;
    found.image.canvasStatus = "destroyed";
    return sessionResult(editorSessionId, found.imageId, "destroyed");
  }

  async function finalize(input) {
    const { bindingKey, editorSessionId } = normalizeSessionInput(input);
    const images = records.get(bindingKey);
    const found = findSession(images, editorSessionId);
    if (!found) return null;
    found.image.sessionIds.delete(editorSessionId);
    if (found.image.canvasStatus === "available" && found.image.sessionIds.size === 0) {
      images.delete(found.imageId);
      if (images.size === 0) records.delete(bindingKey);
    }
    return sessionResult(editorSessionId, found.imageId, "released");
  }

  async function getCanvasStatuses(input) {
    const { bindingKey, imageIds } = normalizeStatusesInput(input);
    const images = records.get(bindingKey);
    return imageIds.map((imageId) => images?.get(imageId)?.canvasStatus === "destroyed" ? "destroyed" : "available");
  }
}


export function createEditorSessionId() {
  return `eds_${randomBytes(16).toString("hex")}`;
}


export function editorStateError(code, message = code) {
  const error = new Error(message);
  error.name = "EditorStateError";
  error.code = code;
  return error;
}


export function normalizeImageInput(input) {
  const bindingKey = requireBindingKey(input?.bindingKey);
  if (typeof input?.imageId !== "string" || !IMAGE_ID_PATTERN.test(input.imageId)) invalidState();
  return { bindingKey, imageId: input.imageId };
}


export function normalizeSessionInput(input) {
  const bindingKey = requireBindingKey(input?.bindingKey);
  if (typeof input?.editorSessionId !== "string" || !SESSION_ID_PATTERN.test(input.editorSessionId)) invalidState();
  return { bindingKey, editorSessionId: input.editorSessionId };
}


export function normalizeStatusesInput(input) {
  const bindingKey = requireBindingKey(input?.bindingKey);
  if (
    !Array.isArray(input?.imageIds)
    || input.imageIds.some((imageId) => typeof imageId !== "string" || !IMAGE_ID_PATTERN.test(imageId))
  ) invalidState();
  return { bindingKey, imageIds: [...input.imageIds] };
}


function requireBindingKey(value) {
  if (typeof value !== "string" || !BINDING_KEY_PATTERN.test(value)) invalidState();
  return value;
}


function imagesFor(records, bindingKey) {
  let images = records.get(bindingKey);
  if (!images) {
    images = new Map();
    records.set(bindingKey, images);
  }
  return images;
}


function findSession(images, editorSessionId) {
  if (!images) return null;
  for (const [imageId, image] of images) {
    if (image.sessionIds.has(editorSessionId)) return { imageId, image };
  }
  return null;
}


function sessionResult(id, imageId, status) {
  return Object.freeze({ id, imageId, status });
}


function invalidState() {
  throw editorStateError("editor_state_invalid", "画布状态无效。");
}
