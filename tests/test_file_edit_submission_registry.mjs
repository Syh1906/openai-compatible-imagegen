import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import lockfile from "proper-lockfile";

import { createFileEditSubmissionRegistry } from "../mcp/file-edit-submission-registry.mjs";
import { readLatestFencedFileSnapshot } from "../mcp/file-lock-ownership.mjs";
import { latestCommittedRecordPath } from "./support/fenced-record-fixture.mjs";


const BINDING_KEY = "1".repeat(64);
const FIRST_PARENT_ID = "img_01J00000000000000000000000";
const SECOND_PARENT_ID = "img_01J00000000000000000000001";
const FIRST_SUBMISSION_ID = "sub_00000000000000000000000000000001";
const SECOND_SUBMISSION_ID = "sub_00000000000000000000000000000002";
const ARTIFACT_ID = "img_01J00000000000000000000002";


test("persisted in-flight pointer and submission states must agree exactly", async (t) => {
  await t.test("a null pointer rejects an in-flight submission", async () => {
    await assertInvalidMutation("null-pointer", (record) => {
      record.submissions[0].state = "in_flight";
    });
  });

  await t.test("a pointer rejects a second in-flight submission", async () => {
    await assertInvalidMutation("second-in-flight", (record) => {
      record.submissions[0].state = "in_flight";
      record.submissions[1].state = "in_flight";
      record.inFlightSubmissionId = record.submissions[0].id;
      record.inFlightAt = 1;
    }, { submissionCount: 2 });
  });
});


test("persisted completed artifact IDs must be unique", async () => {
  await assertInvalidMutation("duplicate-artifacts", (record) => {
    record.submissions[0].state = "complete";
    record.submissions[0].completedArtifactIds = [ARTIFACT_ID, ARTIFACT_ID];
  });
});


test("an expired claimant cannot complete or release a replacement lease", async () => {
  const artifactRoot = await createArtifactRoot("expired-claimant");
  let currentTime = 1;
  const registry = createFileEditSubmissionRegistry({
    idFactory: () => FIRST_SUBMISSION_ID,
    now: () => currentTime,
    leaseTimeoutMs: 10,
  });
  try {
    await registry.issue(submissionInput(artifactRoot, FIRST_PARENT_ID));
    const firstClaim = await registry.claimForEdit(
      lookupInput(artifactRoot, FIRST_PARENT_ID, FIRST_SUBMISSION_ID),
    );
    currentTime = 12;
    const replacementClaim = await registry.claimForEdit(
      lookupInput(artifactRoot, FIRST_PARENT_ID, FIRST_SUBMISSION_ID),
    );

    assert.equal(firstClaim.claimGeneration, 1);
    assert.equal(replacementClaim.claimGeneration, 2);
    await assert.rejects(
      registry.complete({
        ...lookupInput(artifactRoot, FIRST_PARENT_ID, FIRST_SUBMISSION_ID),
        claimGeneration: firstClaim.claimGeneration,
        artifactIds: [ARTIFACT_ID],
      }),
      errorWithCode("stale_edit_submission"),
    );
    await assert.rejects(
      registry.releaseForEdit({
        ...lookupInput(artifactRoot, FIRST_PARENT_ID, FIRST_SUBMISSION_ID),
        claimGeneration: firstClaim.claimGeneration,
      }),
      errorWithCode("stale_edit_submission"),
    );
    await registry.complete({
      ...lookupInput(artifactRoot, FIRST_PARENT_ID, FIRST_SUBMISSION_ID),
      claimGeneration: replacementClaim.claimGeneration,
      artifactIds: [ARTIFACT_ID],
    });
    const completed = await registry.resolveForEdit(
      lookupInput(artifactRoot, FIRST_PARENT_ID, FIRST_SUBMISSION_ID),
    );
    assert.deepEqual(completed.completedArtifactIds, [ARTIFACT_ID]);
  } finally {
    await rm(path.dirname(artifactRoot), { recursive: true });
  }
});


test("different parent records can be locked concurrently", async () => {
  const root = await createArtifactRoot("concurrent-locks");
  const registry = createFileEditSubmissionRegistry({
    idFactory: sequenceFactory([FIRST_SUBMISSION_ID, SECOND_SUBMISSION_ID]),
  });
  try {
    const receipts = await Promise.all([
      registry.issue(submissionInput(root, FIRST_PARENT_ID)),
      registry.issue(submissionInput(root, SECOND_PARENT_ID)),
    ]);

    assert.deepEqual(receipts.map((receipt) => receipt.id).sort(), [
      FIRST_SUBMISSION_ID,
      SECOND_SUBMISSION_ID,
    ]);
  } finally {
    await rm(path.dirname(root), { recursive: true });
  }
});


test("a linked edit submission lock is rejected before locking", async () => {
  const artifactRoot = await createArtifactRoot("linked-lock");
  const registry = createFileEditSubmissionRegistry({ idFactory: () => FIRST_SUBMISSION_ID });
  try {
    await registry.issue(submissionInput(artifactRoot, FIRST_PARENT_ID));
    const target = path.join(path.dirname(artifactRoot), "foreign-lock");
    await mkdir(target);
    await symlink(
      target,
      parentLockPath(artifactRoot, FIRST_PARENT_ID),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      registry.resolveForEdit(lookupInput(artifactRoot, FIRST_PARENT_ID, FIRST_SUBMISSION_ID)),
      errorWithCode("edit_submission_state_invalid"),
    );
  } finally {
    await rm(path.dirname(artifactRoot), { recursive: true });
  }
});


test("a linked runtime ancestor cannot create edit submission directories outside the artifact root", async () => {
  const artifactRoot = await createArtifactRoot("linked-runtime-ancestor");
  const externalRoot = path.join(path.dirname(artifactRoot), "external-runtime");
  await mkdir(externalRoot);
  await symlink(
    externalRoot,
    path.join(artifactRoot, ".runtime"),
    process.platform === "win32" ? "junction" : "dir",
  );
  try {
    await assert.rejects(
      createFileEditSubmissionRegistry({ idFactory: () => FIRST_SUBMISSION_ID })
        .issue(submissionInput(artifactRoot, FIRST_PARENT_ID)),
      errorWithCode("edit_submission_state_invalid"),
    );
    await assert.rejects(
      access(path.join(externalRoot, "edit-submissions")),
      errorWithCode("ENOENT"),
    );
  } finally {
    await rm(path.dirname(artifactRoot), { recursive: true });
  }
});


test("a dangling edit submission record is invalid", async () => {
  const artifactRoot = await createArtifactRoot("dangling-record");
  const registry = createFileEditSubmissionRegistry({ idFactory: () => FIRST_SUBMISSION_ID });
  try {
    await registry.issue(submissionInput(artifactRoot, FIRST_PARENT_ID));
    const recordPath = await latestCommittedRecordPath(parentRecordPath(artifactRoot, FIRST_PARENT_ID));
    await rm(recordPath);
    await symlink(path.join(path.dirname(artifactRoot), "missing.json"), recordPath, "file");
    await assert.rejects(
      registry.resolveForEdit(lookupInput(artifactRoot, FIRST_PARENT_ID, FIRST_SUBMISSION_ID)),
      errorWithCode("edit_submission_state_invalid"),
    );
  } finally {
    await rm(path.dirname(artifactRoot), { recursive: true });
  }
});


test("a compromised edit submission lock returns a stable registry error", async () => {
  const artifactRoot = await createArtifactRoot("compromised-lock");
  const registry = createFileEditSubmissionRegistry({ idFactory: () => FIRST_SUBMISSION_ID });
  const originalLock = lockfile.lock;
  lockfile.lock = compromisedLock;
  try {
    await assert.rejects(
      registry.issue(submissionInput(artifactRoot, FIRST_PARENT_ID)),
      errorWithCode("edit_submission_state_unavailable"),
    );
  } finally {
    lockfile.lock = originalLock;
    await rm(path.dirname(artifactRoot), { recursive: true });
  }
});


test("a lock compromised at publication cannot create an edit submission record", async () => {
  const artifactRoot = await createArtifactRoot("compromised-publication");
  const registry = createFileEditSubmissionRegistry({ idFactory: () => FIRST_SUBMISSION_ID });
  try {
    const lockPath = parentLockPath(artifactRoot, FIRST_PARENT_ID);
    await withSerializationCompromise("edit-submissions.v1", () => {
      renameSync(lockPath, `${lockPath}.former-owner`);
      mkdirSync(lockPath);
    }, async () => {
      await assert.rejects(
        registry.issue(submissionInput(artifactRoot, FIRST_PARENT_ID)),
        errorWithCode("edit_submission_state_unavailable"),
      );
    });
    assert.equal(
      await readLatestFencedFileSnapshot(parentRecordPath(artifactRoot, FIRST_PARENT_ID), { maxBytes: 128 * 1024 }),
      null,
    );
  } finally {
    await rm(path.dirname(artifactRoot), { recursive: true });
  }
});


async function assertInvalidMutation(name, mutate, { submissionCount = 1 } = {}) {
  const artifactRoot = await createArtifactRoot(name);
  const ids = [FIRST_SUBMISSION_ID, SECOND_SUBMISSION_ID];
  const registry = createFileEditSubmissionRegistry({ idFactory: sequenceFactory(ids) });
  try {
    for (let index = 0; index < submissionCount; index += 1) {
      await registry.issue(submissionInput(artifactRoot, FIRST_PARENT_ID, `revision ${index}`));
    }
    const recordPath = await latestCommittedRecordPath(parentRecordPath(artifactRoot, FIRST_PARENT_ID));
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    mutate(record);
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, "utf8");

    await assert.rejects(
      registry.resolveForEdit(lookupInput(artifactRoot, FIRST_PARENT_ID, FIRST_SUBMISSION_ID)),
      errorWithCode("edit_submission_state_invalid"),
    );
  } finally {
    await rm(path.dirname(artifactRoot), { recursive: true });
  }
}


async function createArtifactRoot(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `imagegen-file-edit-registry-${name}-`));
  const artifactRoot = path.join(root, "artifacts");
  await mkdir(artifactRoot);
  return artifactRoot;
}


function parentRecordPath(artifactRoot, parentImageId) {
  const key = createHash("sha256")
    .update(`${BINDING_KEY}\0${parentImageId}`, "utf8")
    .digest("hex");
  return path.join(artifactRoot, ".runtime", "edit-submissions", "parents", `${key}.json`);
}


function parentLockPath(artifactRoot, parentImageId) {
  const key = createHash("sha256")
    .update(`${BINDING_KEY}\0${parentImageId}`, "utf8")
    .digest("hex");
  return path.join(artifactRoot, ".runtime", "edit-submissions", "locks", `${key}.lock`);
}


function submissionInput(artifactRoot, parentImageId, sourcePrompt = "edit the marked area") {
  return {
    artifactRoot,
    bindingKey: BINDING_KEY,
    parentImageId,
    annotationId: null,
    maskSha256: null,
    maskPolicySha256: null,
    sourcePrompt,
    items: [],
  };
}


function lookupInput(artifactRoot, parentImageId, submissionId) {
  return { artifactRoot, bindingKey: BINDING_KEY, parentImageId, submissionId };
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
