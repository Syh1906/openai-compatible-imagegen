import { normalizeMaskOperationState } from "./editor-state.mjs";

export function createEditorDraftRegistry() {
  const records = new Map();

  return {
    saveWorking(editor, { undoStack = [], redoStack = [] } = {}) {
      const imageId = editor?.image?.id;
      if (!imageId) return { kind: "empty" };
      const record = records.get(imageId) || emptyRecord();
      record.working = clone({ editor, undoStack, redoStack });
      records.set(imageId, record);
      return statusFor(record);
    },

    restore(baseEditor) {
      const imageId = baseEditor?.image?.id;
      const record = imageId ? records.get(imageId) : null;
      if (!record?.working) {
        return { editor: baseEditor, undoStack: [], redoStack: [], status: statusFor(record) };
      }
      const working = clone(record.working);
      return {
        editor: normalizeMaskOperationState({
          ...baseEditor,
          ...working.editor,
          image: { ...baseEditor.image },
          lineage: clone(baseEditor.lineage),
        }),
        undoStack: working.undoStack.map(normalizeMaskOperationState),
        redoStack: working.redoStack.map(normalizeMaskOperationState),
        status: statusFor(record),
      };
    },

    markPending(imageId, pending) {
      if (!imageId || pending?.snapshot?.imageId !== imageId) {
        throw new Error("pending edit snapshot does not match its image");
      }
      const record = records.get(imageId) || emptyRecord();
      record.previousPending = pending.updatingTaskInput
        && pending.contextAcknowledged === false
        && !record.deferredCompletion
        ? clone(record.pending)
        : null;
      record.deferredCompletion = null;
      record.pending = clone(pending);
      records.set(imageId, record);
      return statusFor(record);
    },

    acknowledge(imageId, submissionId) {
      const record = records.get(imageId);
      if (!record?.pending || record.pending.submissionId !== submissionId) return null;
      const pending = record.pending;
      pending.contextAcknowledged = true;
      record.previousPending = null;
      const completionApplied = record.deferredCompletion?.submissionId === submissionId;
      record.deferredCompletion = null;
      if (completionApplied) {
        const workingMatched = contentKey(record.working?.editor) === contentKey(pending.snapshot);
        record.pending = null;
        const completionStatus = workingMatched ? { kind: "empty" } : { kind: "editing" };
        if (workingMatched) records.delete(imageId);
        else records.set(imageId, record);
        return {
          ...clone(pending),
          completionApplied: true,
          completionStatus,
        };
      }
      return clone(pending);
    },

    reject(imageId, submissionId) {
      const record = records.get(imageId);
      if (!record?.pending || record.pending.submissionId !== submissionId) return null;
      const rejected = clone(record.pending);
      record.pending = record.previousPending || null;
      rejected.previousPendingRestored = Boolean(record.pending);
      record.previousPending = null;
      record.deferredCompletion = null;
      if (record.working || record.pending) records.set(imageId, record);
      else records.delete(imageId);
      return rejected;
    },

    status(imageId, liveEditor = null) {
      return statusFor(records.get(imageId), liveEditor);
    },

    reconcileArtifacts(artifacts) {
      const completed = [];
      for (const artifact of artifacts || []) {
        const parentIds = Array.isArray(artifact?.parentIds) ? artifact.parentIds : [];
        for (const parentId of parentIds) {
          const record = records.get(parentId);
          if (matchesPendingArtifact(record?.previousPending, artifact)) {
            record.previousPending = null;
          }
          const pending = record?.pending;
          if (!pending) continue;
          if (pending.contextAcknowledged === false) {
            if (matchesPendingArtifact(pending, artifact)) {
              record.deferredCompletion = { submissionId: pending.submissionId, artifactId: artifact.id };
              records.set(parentId, record);
            }
            continue;
          }
          if (!matchesPendingArtifact(pending, artifact)) continue;
          const workingMatched = contentKey(record.working?.editor) === contentKey(record.pending.snapshot);
          record.pending = null;
          if (workingMatched) {
            records.delete(parentId);
            completed.push(parentId);
          } else {
            records.set(parentId, record);
          }
        }
      }
      return [...new Set(completed)];
    },

    destroy(imageId) {
      records.delete(imageId);
    },

    clearWorking(imageId) {
      const record = records.get(imageId);
      if (!record) return;
      record.working = null;
      if (record.pending) records.set(imageId, record);
      else records.delete(imageId);
    },
  };
}

export function draftStatusMessage(status) {
  return {
    writing: "正在等待任务输入框确认",
    pending: "任务输入框中是当前版本",
    updated: "任务输入框仍是上一版，可更新为当前修改",
  }[status?.kind] || "";
}

function statusFor(record, liveEditor = null) {
  const editor = liveEditor || record?.working?.editor || null;
  if (!record?.pending) return { kind: hasContent(editor) ? "editing" : "empty" };
  if (contentKey(editor) !== contentKey(record.pending.snapshot)) {
    return { kind: "updated", canUpdate: record.pending.contextAcknowledged !== false };
  }
  if (record.pending.contextAcknowledged === false) return { kind: "writing" };
  return {
    kind: "pending",
  };
}

function hasContent(editor) {
  return Boolean(editor?.annotations?.length || String(editor?.prompt || "").trim());
}

function contentKey(value) {
  if (!value) return "";
  return JSON.stringify({
    annotations: Array.isArray(value.annotations) ? value.annotations : [],
    prompt: String(value.prompt || "").trim(),
  });
}

function clone(value) {
  return structuredClone(value);
}

function emptyRecord() {
  return { working: null, pending: null, previousPending: null, deferredCompletion: null };
}

function matchesPendingArtifact(pending, artifact) {
  if (!pending) return false;
  const annotationMatches = typeof pending.annotationId === "string"
    ? artifact.annotationId === pending.annotationId
    : pending.annotationId === null && artifact.annotationId === null;
  return annotationMatches
    && artifact?.parameters?.submissionId === pending.submissionId;
}
