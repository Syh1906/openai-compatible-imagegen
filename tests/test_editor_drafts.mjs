import assert from "node:assert/strict";
import test from "node:test";

import { createEditorDraftRegistry } from "../web/editor-drafts.mjs";
import { createEditorState } from "../web/editor-state.mjs";


test("draft registry restores working state and history onto refreshed image metadata", () => {
  const registry = createEditorDraftRegistry();
  const editor = {
    ...baseEditor("img_parent"),
    annotations: [annotation("mark_1")],
    prompt: "保持背景不变",
    zoom: 1.5,
  };
  registry.saveWorking(editor, { undoStack: [baseEditor("img_parent")], redoStack: [] });

  const refreshed = baseEditor("img_parent", { data: "fresh", name: "刷新后的图片" });
  const restored = registry.restore(refreshed);
  assert.equal(restored.editor.image.data, "fresh");
  assert.equal(restored.editor.image.name, "刷新后的图片");
  assert.equal(restored.editor.prompt, "保持背景不变");
  assert.equal(restored.editor.annotations[0].id, "mark_1");
  assert.equal(restored.editor.zoom, 1.5);
  assert.equal(restored.undoStack.length, 1);
  assert.equal(registry.status("img_parent").kind, "editing");
});

test("draft restore removes orphaned mask erases from working and history snapshots", () => {
  const registry = createEditorDraftRegistry();
  const orphaned = {
    ...baseEditor("img_parent"),
    annotations: [{ id: "erase_only", type: "mask", mode: "edit", operation: "erase" }],
    selectedAnnotationId: "erase_only",
    maskOperation: "erase",
  };
  registry.saveWorking(orphaned, { undoStack: [orphaned], redoStack: [orphaned] });

  const restored = registry.restore(baseEditor("img_parent"));
  for (const snapshot of [restored.editor, ...restored.undoStack, ...restored.redoStack]) {
    assert.deepEqual(snapshot.annotations, []);
    assert.equal(snapshot.selectedAnnotationId, null);
    assert.equal(snapshot.maskOperation, "paint");
  }
});

test("pending composer snapshots distinguish unchanged and updated working drafts", () => {
  const registry = createEditorDraftRegistry();
  const editor = { ...baseEditor("img_parent"), annotations: [annotation("mark_1")], prompt: "改为绿色" };
  registry.saveWorking(editor);
  registry.markPending("img_parent", pending(editor, { contextAcknowledged: true }));

  assert.equal(registry.status("img_parent").kind, "pending");
  assert.deepEqual(registry.status("img_parent", { ...editor, prompt: "改为墨绿色" }), { kind: "updated", canUpdate: true });
  registry.saveWorking({ ...editor, prompt: "改为墨绿色" });
  assert.equal(registry.status("img_parent").kind, "updated");
});

test("only a child artifact with the same parent and annotation clears pending state", () => {
  const registry = createEditorDraftRegistry();
  const editor = { ...baseEditor("img_parent"), annotations: [annotation("mark_1")], prompt: "改为绿色" };
  registry.saveWorking(editor);
  registry.markPending("img_parent", pending(editor, { contextAcknowledged: true }));

  assert.deepEqual(registry.reconcileArtifacts([{ id: "img_wrong", parentIds: ["img_parent"], annotationId: "ann_other", parameters: { submissionId: "sub_0123456789abcdef0123456789abcdef" } }]), []);
  assert.equal(registry.status("img_parent").kind, "pending");
  assert.deepEqual(registry.reconcileArtifacts([{ id: "img_wrong_submission", parentIds: ["img_parent"], annotationId: "ann_current", parameters: { submissionId: "sub_ffffffffffffffffffffffffffffffff" } }]), []);
  assert.equal(registry.status("img_parent").kind, "pending");
  assert.deepEqual(registry.reconcileArtifacts([{ id: "img_child", parentIds: ["img_parent"], annotationId: "ann_current", parameters: { submissionId: "sub_0123456789abcdef0123456789abcdef" } }]), ["img_parent"]);
  assert.equal(registry.status("img_parent").kind, "empty");
});

test("matching child clears pending but preserves an updated working draft", () => {
  const registry = createEditorDraftRegistry();
  const original = { ...baseEditor("img_parent"), annotations: [annotation("mark_1")], prompt: "改为绿色" };
  const updated = { ...original, prompt: "改为墨绿色" };
  registry.saveWorking(original);
  registry.markPending("img_parent", pending(original, { contextAcknowledged: true }));
  registry.saveWorking(updated);

  assert.deepEqual(
    registry.reconcileArtifacts([{ id: "img_child", parentIds: ["img_parent"], annotationId: "ann_current", parameters: { submissionId: "sub_0123456789abcdef0123456789abcdef" } }]),
    [],
  );
  assert.equal(registry.status("img_parent").kind, "editing");
  assert.equal(registry.restore(baseEditor("img_parent")).editor.prompt, "改为墨绿色");
});

test("unacknowledged and prompt-only submissions remain explicit and image-scoped", () => {
  const registry = createEditorDraftRegistry();
  const first = { ...baseEditor("img_first"), prompt: "第一张" };
  const second = { ...baseEditor("img_second"), prompt: "第二张" };
  registry.saveWorking(first);
  registry.saveWorking(second);
  registry.markPending("img_first", pending(first, { annotationId: null, contextAcknowledged: false }));

  assert.equal(registry.status("img_first").kind, "writing");
  assert.equal(registry.status("img_second").kind, "editing");
  assert.deepEqual(registry.reconcileArtifacts([{
    id: "img_child",
    parentIds: ["img_first"],
    annotationId: null,
    parameters: { submissionId: "sub_0123456789abcdef0123456789abcdef" },
  }]), []);
  assert.equal(registry.status("img_first").kind, "writing");
  registry.destroy("img_first");
  assert.equal(registry.status("img_first").kind, "empty");
  assert.equal(registry.status("img_second").kind, "editing");
});

test("an unacknowledged submission becomes updated when its working draft changes", () => {
  const registry = createEditorDraftRegistry();
  const original = { ...baseEditor("img_parent"), prompt: "第一版" };
  registry.saveWorking(original);
  registry.markPending("img_parent", pending(original, { annotationId: null, contextAcknowledged: false }));

  assert.deepEqual(registry.status("img_parent", { ...original, prompt: "修改后的第二版" }), { kind: "updated", canUpdate: false });
});

test("a late acknowledgement unlocks only the matching pending submission", () => {
  const registry = createEditorDraftRegistry();
  const original = { ...baseEditor("img_parent"), prompt: "第一版" };
  registry.saveWorking(original);
  registry.markPending("img_parent", pending(original, { contextAcknowledged: false }));
  registry.saveWorking({ ...original, prompt: "第二版" });

  assert.equal(registry.acknowledge("img_parent", "sub_other"), null);
  assert.deepEqual(registry.status("img_parent"), { kind: "updated", canUpdate: false });
  assert.equal(registry.acknowledge("img_parent", "sub_0123456789abcdef0123456789abcdef")?.contextAcknowledged, true);
  assert.deepEqual(registry.status("img_parent"), { kind: "updated", canUpdate: true });
});

test("a late acknowledgement consumes an exact child that arrived while context was unacknowledged", () => {
  const registry = createEditorDraftRegistry();
  const original = { ...baseEditor("img_parent"), prompt: "第一版" };
  registry.saveWorking(original);
  registry.markPending("img_parent", pending(original, {
    annotationId: null,
    contextAcknowledged: false,
  }));

  assert.deepEqual(registry.reconcileArtifacts([{
    id: "img_child",
    parentIds: ["img_parent"],
    annotationId: null,
    parameters: { submissionId: "sub_0123456789abcdef0123456789abcdef" },
  }]), []);
  assert.equal(registry.status("img_parent").kind, "writing");

  const acknowledged = registry.acknowledge(
    "img_parent",
    "sub_0123456789abcdef0123456789abcdef",
  );
  assert.equal(acknowledged?.completionApplied, true);
  assert.equal(registry.status("img_parent").kind, "empty");
  assert.deepEqual(registry.reconcileArtifacts([{
    id: "img_child",
    parentIds: ["img_parent"],
    annotationId: null,
    parameters: { submissionId: "sub_0123456789abcdef0123456789abcdef" },
  }]), []);
  assert.equal(registry.status("img_parent").kind, "empty");
});

test("clearing working content preserves an acknowledged task-input snapshot", () => {
  const registry = createEditorDraftRegistry();
  const editor = { ...baseEditor("img_parent"), prompt: "上一版任务" };
  registry.saveWorking(editor);
  registry.markPending("img_parent", pending(editor, { contextAcknowledged: true }));

  registry.clearWorking("img_parent");

  assert.equal(registry.restore(baseEditor("img_parent")).editor.prompt, "");
  assert.equal(registry.status("img_parent", baseEditor("img_parent")).kind, "updated");
});


test("a rejected replacement restores the previous snapshot after working content was cleared", () => {
  const registry = createEditorDraftRegistry();
  const first = { ...baseEditor("img_parent"), prompt: "上一版任务" };
  const second = { ...first, prompt: "更新版本" };
  registry.saveWorking(first);
  registry.markPending("img_parent", pending(first, { contextAcknowledged: true }));
  registry.saveWorking(second);
  registry.markPending("img_parent", pending(second, {
    submissionId: "sub_ffffffffffffffffffffffffffffffff",
    contextAcknowledged: false,
    updatingTaskInput: true,
  }));

  registry.clearWorking("img_parent");
  registry.reject("img_parent", "sub_ffffffffffffffffffffffffffffffff");

  assert.deepEqual(registry.status("img_parent", baseEditor("img_parent")), { kind: "updated", canUpdate: true });
});


test("an acknowledged prompt-only submission clears only for its exact child submission ID", () => {
  const registry = createEditorDraftRegistry();
  const editor = { ...baseEditor("img_parent"), prompt: "只调整整体光线" };
  registry.saveWorking(editor);
  registry.markPending("img_parent", pending(editor, {
    annotationId: null,
    contextAcknowledged: true,
  }));

  assert.deepEqual(registry.reconcileArtifacts([{
    id: "img_wrong",
    parentIds: ["img_parent"],
    annotationId: null,
    parameters: { submissionId: "sub_ffffffffffffffffffffffffffffffff" },
  }]), []);
  assert.equal(registry.status("img_parent").kind, "pending");
  assert.deepEqual(registry.reconcileArtifacts([{
    id: "img_wrong_annotation",
    parentIds: ["img_parent"],
    annotationId: "ann_unexpected",
    parameters: { submissionId: "sub_0123456789abcdef0123456789abcdef" },
  }]), []);
  assert.equal(registry.status("img_parent").kind, "pending");
  assert.deepEqual(registry.reconcileArtifacts([{
    id: "img_child",
    parentIds: ["img_parent"],
    annotationId: null,
    parameters: { submissionId: "sub_0123456789abcdef0123456789abcdef" },
  }]), ["img_parent"]);
  assert.equal(registry.status("img_parent").kind, "empty");
});

function baseEditor(id, imagePatch = {}) {
  return createEditorState({
    image: { id, mimeType: "image/png", width: 100, height: 80, parentIds: [], childIds: [], data: "old", ...imagePatch },
  });
}

function annotation(id) {
  return { id, type: "rectangle", x: 0.1, y: 0.1, width: 0.2, height: 0.2, points: [], text: "", color: "#ef4444", strokeWidth: 5 };
}

function pending(editor, overrides = {}) {
  return {
    submissionId: "sub_0123456789abcdef0123456789abcdef",
    annotationId: "ann_current",
    revisionSha256: "a".repeat(64),
    contextAcknowledged: true,
    snapshot: { imageId: editor.image.id, annotations: editor.annotations, prompt: editor.prompt, items: [], preview: { mimeType: "image/svg+xml", data: "<svg/>" } },
    ...overrides,
  };
}
