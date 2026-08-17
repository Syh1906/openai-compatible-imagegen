import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import lockfile from "proper-lockfile";

import { createFileEditorStateRegistry } from "../mcp/file-editor-state-registry.mjs";
import { readLatestFencedFileSnapshot } from "../mcp/file-lock-ownership.mjs";
import { latestCommittedRecordPath } from "./support/fenced-record-fixture.mjs";


const BINDING_KEY = "1".repeat(64);
const OTHER_BINDING_KEY = "2".repeat(64);
const IMAGE_ID = "img_01J00000000000000000000000";
const OTHER_IMAGE_ID = "img_01J00000000000000000000001";
const SESSION_ID = "eds_00000000000000000000000000000001";
const OTHER_SESSION_ID = "eds_00000000000000000000000000000002";
const DRAFT = {
  annotations: [{ id: "arrow-1", type: "arrow", from: { x: 0.1, y: 0.2 }, to: { x: 0.7, y: 0.8 } }],
  prompt: "保留未发送的修改草稿",
};


test("file editor state persists image-wide destruction and session finalization", async () => {
  await withArtifactRoot("lifecycle", async (artifactRoot) => {
    const first = createFileEditorStateRegistry({ idFactory: sequenceFactory([SESSION_ID, OTHER_SESSION_ID]) });
    const second = createFileEditorStateRegistry();
    const input = scope(artifactRoot);

    assert.deepEqual(await first.getCanvasStatuses({ ...input, imageIds: [IMAGE_ID] }), ["available"]);
    assert.deepEqual(await first.open({ ...input, imageId: IMAGE_ID }), {
      id: SESSION_ID,
      imageId: IMAGE_ID,
      status: "active",
    });
    await first.open({ ...input, imageId: IMAGE_ID });
    assert.equal((await second.getSession({ ...input, editorSessionId: SESSION_ID })).status, "active");

    const destroyed = await second.destroy({ ...input, editorSessionId: SESSION_ID });
    assert.equal(destroyed.status, "destroyed");
    assert.equal((await first.getSession({ ...input, editorSessionId: OTHER_SESSION_ID })).status, "destroyed");
    assert.deepEqual(await second.getCanvasStatuses({ ...input, imageIds: [IMAGE_ID, OTHER_IMAGE_ID] }), [
      "destroyed",
      "available",
    ]);
    await assert.rejects(
      second.open({ ...input, imageId: IMAGE_ID }),
      errorWithCode("image_canvas_destroyed"),
    );

    assert.equal((await first.finalize({ ...input, editorSessionId: SESSION_ID })).status, "released");
    assert.equal(await second.getSession({ ...input, editorSessionId: SESSION_ID }), null);
    assert.equal((await second.destroy({ ...input, editorSessionId: SESSION_ID })), null);
    assert.deepEqual(await first.getCanvasStatuses({ ...input, imageIds: [IMAGE_ID] }), ["destroyed"]);
  });
});


test("file editor state hands a saved draft to the next canvas session exactly once", async () => {
  await withArtifactRoot("draft-handoff", async (artifactRoot) => {
    const first = createFileEditorStateRegistry({ idFactory: sequenceFactory([SESSION_ID]) });
    const input = scope(artifactRoot);
    await first.open({ ...input, imageId: IMAGE_ID });
    await first.saveDraft({ ...input, editorSessionId: SESSION_ID, draft: DRAFT });
    await first.finalize({ ...input, editorSessionId: SESSION_ID });

    const second = createFileEditorStateRegistry({ idFactory: sequenceFactory([OTHER_SESSION_ID]) });
    assert.deepEqual(await second.open({ ...input, imageId: IMAGE_ID }), {
      id: OTHER_SESSION_ID,
      imageId: IMAGE_ID,
      status: "active",
      draft: DRAFT,
    });
    await second.finalize({ ...input, editorSessionId: OTHER_SESSION_ID });

    const thirdSessionId = "eds_00000000000000000000000000000003";
    const third = createFileEditorStateRegistry({ idFactory: sequenceFactory([thirdSessionId]) });
    assert.deepEqual(await third.open({ ...input, imageId: IMAGE_ID }), {
      id: thirdSessionId,
      imageId: IMAGE_ID,
      status: "active",
    });
  });
});


test("file editor state rejects an invalid draft before publication", async () => {
  await withArtifactRoot("invalid-draft-input", async (artifactRoot) => {
    const registry = createFileEditorStateRegistry({ idFactory: () => SESSION_ID });
    const input = scope(artifactRoot);
    await registry.open({ ...input, imageId: IMAGE_ID });

    await assert.rejects(
      registry.saveDraft({
        ...input,
        editorSessionId: SESSION_ID,
        draft: {
          annotations: [{
            id: "invalid-arrow",
            type: "arrow",
            from: { x: -0.1, y: 0.2 },
            to: { x: 0.7, y: 0.8 },
          }],
          prompt: "非法草稿不得写入",
        },
      }),
      errorWithCode("editor_state_invalid"),
    );
  });
});


test("file editor state rejects a late draft after the image canvas is destroyed", async () => {
  await withArtifactRoot("destroyed-draft", async (artifactRoot) => {
    const registry = createFileEditorStateRegistry({ idFactory: () => SESSION_ID });
    const input = scope(artifactRoot);
    await registry.open({ ...input, imageId: IMAGE_ID });
    await registry.destroy({ ...input, editorSessionId: SESSION_ID });

    await assert.rejects(
      registry.saveDraft({ ...input, editorSessionId: SESSION_ID, draft: DRAFT }),
      errorWithCode("image_canvas_destroyed"),
    );
  });
});


test("one binding lock serializes concurrent opens without losing sessions", async () => {
  await withArtifactRoot("concurrent", async (artifactRoot) => {
    const ids = Array.from({ length: 12 }, (_, index) => `eds_${(index + 1).toString(16).padStart(32, "0")}`);
    const registry = createFileEditorStateRegistry({ idFactory: sequenceFactory(ids) });
    const settled = await Promise.allSettled(ids.map(() => registry.open({ ...scope(artifactRoot), imageId: IMAGE_ID })));
    const rejected = settled.filter((result) => result.status === "rejected");
    assert.deepEqual(rejected.map((result) => result.reason?.code), []);
    const opened = settled.map((result) => result.value);
    assert.deepEqual(new Set(opened.map((item) => item.id)), new Set(ids));
    for (const editorSessionId of ids) {
      assert.equal((await registry.getSession({ ...scope(artifactRoot), editorSessionId })).status, "active");
    }
  });
});


test("file editor state fails closed for corrupt, mismatched, and duplicate records", async (t) => {
  await t.test("corrupt JSON", async () => {
    await assertInvalidMutation("corrupt", async (recordPath) => {
      await writeFile(recordPath, "{", "utf8");
    });
  });
  await t.test("wrong binding key", async () => {
    await assertInvalidMutation("binding", async (recordPath, record) => {
      record.bindingKey = OTHER_BINDING_KEY;
      await writeFile(recordPath, `${JSON.stringify(record)}\n`, "utf8");
    });
  });
  await t.test("duplicate session ID", async () => {
    await assertInvalidMutation("duplicate", async (recordPath, record) => {
      record.images.push({ imageId: OTHER_IMAGE_ID, canvasStatus: "available", sessionIds: [SESSION_ID] });
      await writeFile(recordPath, `${JSON.stringify(record)}\n`, "utf8");
    });
  });
  await t.test("invalid persisted draft", async () => {
    await assertInvalidMutation("invalid-draft-record", async (recordPath, record) => {
      record.images[0].draft = {
        annotations: [{
          id: "invalid-arrow",
          type: "arrow",
          from: { x: -0.1, y: 0.2 },
          to: { x: 0.7, y: 0.8 },
        }],
        prompt: "非法草稿不得恢复",
      };
      await writeFile(recordPath, `${JSON.stringify(record)}\n`, "utf8");
    });
  });
});


test("file editor state rejects linked state paths", async (t) => {
  await t.test("linked runtime directory", async () => {
    await withArtifactRoot("linked-runtime", async (artifactRoot, root) => {
      const target = path.join(root, "target");
      await mkdir(target);
      await symlink(target, path.join(artifactRoot, ".runtime"), process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(
        createFileEditorStateRegistry().getCanvasStatuses({ ...scope(artifactRoot), imageIds: [IMAGE_ID] }),
        errorWithCode("editor_state_invalid"),
      );
    });
  });

  await t.test("linked record", async () => {
    await withArtifactRoot("linked-record", async (artifactRoot, root) => {
      const registry = createFileEditorStateRegistry({ idFactory: () => SESSION_ID });
      await registry.open({ ...scope(artifactRoot), imageId: IMAGE_ID });
      const recordPath = await latestCommittedRecordPath(editorRecordPath(artifactRoot));
      const target = path.join(root, "foreign.json");
      await writeFile(target, await readFile(recordPath));
      await rm(recordPath);
      await symlink(target, recordPath, "file");
      await assert.rejects(
        registry.getSession({ ...scope(artifactRoot), editorSessionId: SESSION_ID }),
        errorWithCode("editor_state_invalid"),
      );
    });
  });

  await t.test("dangling record", async () => {
    await withArtifactRoot("dangling-record", async (artifactRoot, root) => {
      const registry = createFileEditorStateRegistry({ idFactory: () => SESSION_ID });
      await registry.open({ ...scope(artifactRoot), imageId: IMAGE_ID });
      await registry.destroy({ ...scope(artifactRoot), editorSessionId: SESSION_ID });
      const recordPath = await latestCommittedRecordPath(editorRecordPath(artifactRoot));
      await rm(recordPath);
      await symlink(path.join(root, "missing.json"), recordPath, "file");
      await assert.rejects(
        registry.getCanvasStatuses({ ...scope(artifactRoot), imageIds: [IMAGE_ID] }),
        errorWithCode("editor_state_invalid"),
      );
      await assert.rejects(
        registry.open({ ...scope(artifactRoot), imageId: IMAGE_ID }),
        errorWithCode("editor_state_invalid"),
      );
    });
  });

  await t.test("linked lock directory", async () => {
    await withArtifactRoot("linked-lock", async (artifactRoot, root) => {
      const registry = createFileEditorStateRegistry({ idFactory: () => SESSION_ID });
      await registry.open({ ...scope(artifactRoot), imageId: IMAGE_ID });
      const target = path.join(root, "foreign-lock");
      await mkdir(target);
      await symlink(target, editorLockPath(artifactRoot), process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(
        registry.open({ ...scope(artifactRoot), imageId: OTHER_IMAGE_ID }),
        errorWithCode("editor_state_invalid"),
      );
    });
  });
});


test("a compromised editor state lock returns a stable registry error", async () => {
  await withArtifactRoot("compromised-lock", async (artifactRoot) => {
    const originalLock = lockfile.lock;
    lockfile.lock = compromisedLock;
    try {
      await assert.rejects(
        createFileEditorStateRegistry({ idFactory: () => SESSION_ID }).open({
          ...scope(artifactRoot),
          imageId: IMAGE_ID,
        }),
        errorWithCode("editor_state_unavailable"),
      );
    } finally {
      lockfile.lock = originalLock;
    }
  });
});


test("read-only editor state lookups do not create runtime directories", async () => {
  await withArtifactRoot("read-only-missing", async (artifactRoot) => {
    const registry = createFileEditorStateRegistry();
    assert.deepEqual(
      await registry.getCanvasStatuses({ ...scope(artifactRoot), imageIds: [IMAGE_ID] }),
      ["available"],
    );
    assert.equal(
      await registry.getSession({ ...scope(artifactRoot), editorSessionId: SESSION_ID }),
      null,
    );
    await assert.rejects(access(path.join(artifactRoot, ".runtime")), errorWithCode("ENOENT"));
  });
});


test("a lock compromised at publication cannot create an editor state record", async () => {
  await withArtifactRoot("compromised-publication", async (artifactRoot) => {
    const lockPath = editorLockPath(artifactRoot);
    await withSerializationCompromise("editor-state.v1", () => {
      renameSync(lockPath, `${lockPath}.former-owner`);
      mkdirSync(lockPath);
    }, async () => {
      await assert.rejects(
        createFileEditorStateRegistry({ idFactory: () => SESSION_ID }).open({
          ...scope(artifactRoot),
          imageId: IMAGE_ID,
        }),
        errorWithCode("editor_state_unavailable"),
      );
    });
    assert.equal(
      await readLatestFencedFileSnapshot(editorRecordPath(artifactRoot), { maxBytes: 256 * 1024 }),
      null,
    );
  });
});


async function assertInvalidMutation(name, mutate) {
  await withArtifactRoot(name, async (artifactRoot) => {
    const registry = createFileEditorStateRegistry({ idFactory: () => SESSION_ID });
    await registry.open({ ...scope(artifactRoot), imageId: IMAGE_ID });
    const recordPath = await latestCommittedRecordPath(editorRecordPath(artifactRoot));
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    await mutate(recordPath, record);
    await assert.rejects(
      registry.getSession({ ...scope(artifactRoot), editorSessionId: SESSION_ID }),
      errorWithCode("editor_state_invalid"),
    );
  });
}


async function withArtifactRoot(name, callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), `imagegen-editor-state-${name}-`));
  const artifactRoot = path.join(root, "artifacts");
  await mkdir(artifactRoot);
  try {
    await callback(artifactRoot, root);
  } finally {
    await rm(root, { recursive: true });
  }
}


function editorRecordPath(artifactRoot) {
  const key = createHash("sha256").update(BINDING_KEY, "utf8").digest("hex");
  return path.join(artifactRoot, ".runtime", "editor-state", "bindings", `${key}.json`);
}


function editorLockPath(artifactRoot) {
  const key = createHash("sha256").update(BINDING_KEY, "utf8").digest("hex");
  return path.join(artifactRoot, ".runtime", "editor-state", "locks", `${key}.lock`);
}


function scope(artifactRoot) {
  return { artifactRoot, bindingKey: BINDING_KEY };
}


function sequenceFactory(ids) {
  let index = 0;
  return () => ids[index++];
}


function errorWithCode(code) {
  return (error) => error instanceof Error && error.code === code;
}


async function compromisedLock(_file, options) {
  const error = Object.assign(new Error("lock compromised"), { code: "ECOMPROMISED" });
  queueMicrotask(() => {
    if (typeof options.onCompromised !== "function") throw error;
    options.onCompromised(error);
  });
  return async () => {};
}


async function withSerializationCompromise(schemaVersion, compromise, callback) {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  let fired = false;
  Object.defineProperty(Object.prototype, "toJSON", {
    configurable: true,
    value() {
      if (!fired && this.schemaVersion === schemaVersion) {
        fired = true;
        compromise();
      }
      return Object.assign(Object.create(null), this);
    },
  });
  try {
    await callback();
    assert.equal(fired, true);
  } finally {
    if (original) Object.defineProperty(Object.prototype, "toJSON", original);
    else delete Object.prototype.toJSON;
  }
}
