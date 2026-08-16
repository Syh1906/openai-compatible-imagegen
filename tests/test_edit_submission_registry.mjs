import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createEditSubmissionRegistry } from "../mcp/edit-submission-registry.mjs";


const IDS = [
  "sub_00000000000000000000000000000001",
  "sub_00000000000000000000000000000002",
  "sub_00000000000000000000000000000003",
];


test("issue creates a server ID and a prompt-safe canonical revision receipt", () => {
  const registry = createEditSubmissionRegistry({ idFactory: sequenceFactory(IDS) });
  const input = {
    bindingKey: "project-alpha",
    parentImageId: "img_parent",
    annotationId: "ann_current",
    maskSha256: "a".repeat(64),
    maskPolicySha256: "b".repeat(64),
    sourcePrompt: "replace the marked cup",
    items: [{ type: "rectangle", points: [{ y: 0.2, x: 0.1 }] }],
  };

  const receipt = registry.issue(input);

  assert.deepEqual(receipt, {
    id: IDS[0],
    parentImageId: "img_parent",
    annotationId: "ann_current",
    revisionSha256: canonicalRevisionSha256(input),
  });
  assert.deepEqual(Object.keys(receipt).sort(), [
    "annotationId",
    "id",
    "parentImageId",
    "revisionSha256",
  ]);
  assert.match(receipt.id, /^sub_[0-9a-f]{32}$/);

  const reordered = registry.issue({
    items: [{ points: [{ x: 0.1, y: 0.2 }], type: "rectangle" }],
    sourcePrompt: input.sourcePrompt,
    maskSha256: input.maskSha256,
    maskPolicySha256: input.maskPolicySha256,
    annotationId: input.annotationId,
    parentImageId: input.parentImageId,
    bindingKey: input.bindingKey,
  });
  assert.equal(reordered.revisionSha256, receipt.revisionSha256);
  assert.deepEqual(
    registry.resolveForEdit(editInput({ submissionId: reordered.id })),
    { receipt: reordered, maskSha256: input.maskSha256, maskPolicySha256: input.maskPolicySha256 },
  );
});


test("prepared revisions remain claimable until one is selected for editing", () => {
  const registry = createEditSubmissionRegistry({ idFactory: sequenceFactory(IDS) });
  const first = registry.issue(submissionInput({ sourcePrompt: "first" }));
  const latest = registry.issue(submissionInput({ sourcePrompt: "latest" }));

  assert.deepEqual(
    registry.resolveForEdit(editInput({ submissionId: first.id })),
    { receipt: first, maskSha256: null, maskPolicySha256: null },
  );
  assert.deepEqual(
    registry.resolveForEdit(editInput({ submissionId: latest.id })),
    { receipt: latest, maskSha256: null, maskPolicySha256: null },
  );

  const firstClaim = registry.claimForEdit(editInput({ submissionId: first.id }));
  assert.deepEqual(firstClaim, {
    receipt: first,
    maskSha256: null,
    maskPolicySha256: null,
    claimGeneration: 1,
  });
  assert.throws(
    () => registry.claimForEdit(editInput({ submissionId: latest.id })),
    errorWithCode("edit_submission_in_flight"),
  );

  registry.releaseForEdit({
    bindingKey: "project-alpha",
    parentImageId: "img_parent",
    submissionId: first.id,
    claimGeneration: firstClaim.claimGeneration,
  });
  assert.deepEqual(
    registry.resolveForEdit(editInput({ submissionId: latest.id })),
    { receipt: latest, maskSha256: null, maskPolicySha256: null },
  );

  const latestClaim = registry.claimForEdit(editInput({ submissionId: latest.id }));
  registry.complete({
    bindingKey: "project-alpha",
    parentImageId: "img_parent",
    submissionId: latest.id,
    claimGeneration: latestClaim.claimGeneration,
    artifactIds: ["img_01J00000000000000000000001"],
  });
  assert.throws(
    () => registry.resolveForEdit(editInput({ submissionId: first.id })),
    errorWithCode("stale_edit_submission"),
  );
});


test("pending submissions fail closed for missing IDs and binding mismatches", () => {
  const registry = createEditSubmissionRegistry({ idFactory: sequenceFactory(IDS) });
  const receipt = registry.issue(submissionInput());

  assert.throws(
    () => registry.resolveForEdit(editInput({ submissionId: undefined })),
    errorWithCode("missing_edit_submission"),
  );
  assert.throws(
    () => registry.resolveForEdit(editInput({ submissionId: "sub_ffffffffffffffffffffffffffffffff" })),
    errorWithCode("stale_edit_submission"),
  );
  assert.throws(
    () => registry.resolveForEdit(editInput({ submissionId: receipt.id, bindingKey: "other-project" })),
    errorWithCode("edit_submission_mismatch"),
  );
  assert.throws(
    () => registry.resolveForEdit(editInput({ submissionId: receipt.id, parentImageId: "img_other" })),
    errorWithCode("edit_submission_mismatch"),
  );
  assert.throws(
    () => registry.resolveForEdit({
      bindingKey: "project-alpha",
      parentImageId: "img_parent",
      submissionId: receipt.id,
    }),
    errorWithCode("edit_submission_mismatch"),
  );
  assert.throws(
    () => registry.resolveForEdit(editInput({ submissionId: receipt.id, annotationId: "ann_other" })),
    errorWithCode("edit_submission_mismatch"),
  );
});


test("ordinary edits are allowed only when no pending submission or ID exists", () => {
  const registry = createEditSubmissionRegistry({ idFactory: sequenceFactory(IDS) });

  assert.equal(registry.resolveForEdit({
    bindingKey: "project-alpha",
    parentImageId: "img_parent",
  }), null);
  assert.throws(
    () => registry.resolveForEdit(editInput({ submissionId: IDS[0] })),
    errorWithCode("stale_edit_submission"),
  );
});

test("prompt-only submissions resolve without an annotation argument", () => {
  const registry = createEditSubmissionRegistry({ idFactory: sequenceFactory(IDS) });
  const receipt = registry.issue(submissionInput({ annotationId: null, items: [] }));

  assert.deepEqual(registry.resolveForEdit({
    bindingKey: "project-alpha",
    parentImageId: "img_parent",
    submissionId: receipt.id,
  }), { receipt, maskSha256: null, maskPolicySha256: null });
});


test("claimForEdit synchronously claims a pending submission only once", () => {
  const registry = createEditSubmissionRegistry({ idFactory: sequenceFactory(IDS) });
  const receipt = registry.issue(submissionInput());

  assert.deepEqual(
    registry.claimForEdit(editInput({ submissionId: receipt.id })),
    { receipt, maskSha256: null, maskPolicySha256: null, claimGeneration: 1 },
  );
  assert.throws(
    () => registry.claimForEdit(editInput({ submissionId: receipt.id })),
    errorWithCode("stale_edit_submission"),
  );
});


test("issue rejects a new revision while the current submission is in flight", () => {
  const registry = createEditSubmissionRegistry({ idFactory: sequenceFactory(IDS) });
  const receipt = registry.issue(submissionInput());
  const claim = registry.claimForEdit(editInput({ submissionId: receipt.id }));

  assert.throws(
    () => registry.issue(submissionInput({ sourcePrompt: "replacement" })),
    errorWithCode("edit_submission_in_flight"),
  );
  registry.releaseForEdit({
    bindingKey: "project-alpha",
    parentImageId: "img_parent",
    submissionId: receipt.id,
    claimGeneration: claim.claimGeneration,
  });
  assert.equal(
    registry.issue(submissionInput({ sourcePrompt: "replacement" })).id,
    IDS[1],
  );
});


test("release retries the current claim and completion preserves response recovery", () => {
  const registry = createEditSubmissionRegistry({ idFactory: sequenceFactory(IDS) });
  const receipt = registry.issue(submissionInput());
  const firstClaim = registry.claimForEdit(editInput({ submissionId: receipt.id }));

  assert.deepEqual(registry.releaseForEdit({
    bindingKey: "project-alpha",
    parentImageId: "img_parent",
    submissionId: receipt.id,
    claimGeneration: firstClaim.claimGeneration,
  }), receipt);
  const secondClaim = registry.claimForEdit(editInput({ submissionId: receipt.id }));
  assert.deepEqual(secondClaim, {
    receipt,
    maskSha256: null,
    maskPolicySha256: null,
    claimGeneration: 2,
  });
  assert.deepEqual(registry.complete({
    bindingKey: "project-alpha",
    parentImageId: "img_parent",
    submissionId: receipt.id,
    claimGeneration: secondClaim.claimGeneration,
    artifactIds: ["img_01J00000000000000000000001"],
  }), receipt);
  const replacement = registry.issue(submissionInput({ sourcePrompt: "replacement" }));
  assert.throws(
    () => registry.releaseForEdit({
      bindingKey: "project-alpha",
      parentImageId: "img_parent",
      submissionId: receipt.id,
      claimGeneration: secondClaim.claimGeneration,
    }),
    errorWithCode("stale_edit_submission"),
  );
  assert.deepEqual(registry.claimForEdit(editInput({ submissionId: replacement.id })), {
    receipt: replacement,
    maskSha256: null,
    maskPolicySha256: null,
    claimGeneration: 1,
  });
  assert.deepEqual(registry.claimForEdit(editInput({ submissionId: receipt.id })), {
    receipt,
    maskSha256: null,
    maskPolicySha256: null,
    completedArtifactIds: ["img_01J00000000000000000000001"],
  });
  assert.throws(
    () => registry.claimForEdit(editInput({ submissionId: receipt.id, annotationId: "ann_other" })),
    errorWithCode("edit_submission_mismatch"),
  );
});


test("complete consumes only the current matching submission", () => {
  const registry = createEditSubmissionRegistry({ idFactory: sequenceFactory(IDS) });
  const stale = registry.issue(submissionInput({ sourcePrompt: "first" }));
  const latest = registry.issue(submissionInput({ sourcePrompt: "latest" }));

  assert.throws(
    () => registry.complete({
      bindingKey: "project-alpha",
      parentImageId: "img_parent",
      submissionId: stale.id,
      claimGeneration: 1,
    }),
    errorWithCode("stale_edit_submission"),
  );
  assert.deepEqual(
    registry.resolveForEdit(editInput({ submissionId: latest.id })),
    { receipt: latest, maskSha256: null, maskPolicySha256: null },
  );
  assert.throws(
    () => registry.complete({
      bindingKey: "other-project",
      parentImageId: "img_parent",
      submissionId: latest.id,
      claimGeneration: 1,
    }),
    errorWithCode("edit_submission_mismatch"),
  );
  const claim = registry.claimForEdit(editInput({ submissionId: latest.id }));
  assert.deepEqual(registry.complete({
    bindingKey: "project-alpha",
    parentImageId: "img_parent",
    submissionId: latest.id,
    claimGeneration: claim.claimGeneration,
  }), latest);
  assert.equal(registry.resolveForEdit({
    bindingKey: "project-alpha",
    parentImageId: "img_parent",
  }), null);
  assert.throws(
    () => registry.complete({
      bindingKey: "project-alpha",
      parentImageId: "img_parent",
      submissionId: latest.id,
      claimGeneration: claim.claimGeneration,
    }),
    errorWithCode("stale_edit_submission"),
  );
});


test("a completed submission keeps its immutable artifact IDs for response recovery", () => {
  const registry = createEditSubmissionRegistry({ idFactory: sequenceFactory(IDS) });
  const receipt = registry.issue(submissionInput());
  const claim = registry.claimForEdit(editInput({ submissionId: receipt.id }));
  registry.complete({
    bindingKey: "project-alpha",
    parentImageId: "img_parent",
    submissionId: receipt.id,
    claimGeneration: claim.claimGeneration,
    artifactIds: ["img_01J00000000000000000000001"],
  });

  assert.deepEqual(registry.claimForEdit(editInput({ submissionId: receipt.id })), {
    receipt,
    maskSha256: null,
    maskPolicySha256: null,
    completedArtifactIds: ["img_01J00000000000000000000001"],
  });
});


function submissionInput(overrides = {}) {
  return {
    bindingKey: "project-alpha",
    parentImageId: "img_parent",
    annotationId: "ann_current",
    maskSha256: null,
    maskPolicySha256: null,
    sourcePrompt: "edit the marked area",
    items: [{ type: "rectangle", x: 0.1, y: 0.2 }],
    ...overrides,
  };
}


function editInput(overrides = {}) {
  return {
    bindingKey: "project-alpha",
    parentImageId: "img_parent",
    annotationId: "ann_current",
    ...overrides,
  };
}


function sequenceFactory(ids) {
  let index = 0;
  return () => ids[index++];
}


function errorWithCode(code) {
  return (error) => error instanceof Error && error.code === code;
}


function canonicalRevisionSha256(input) {
  const revision = {
    annotationId: input.annotationId,
    items: input.items,
    maskPolicySha256: input.maskPolicySha256,
    maskSha256: input.maskSha256,
    parentImageId: input.parentImageId,
    sourcePrompt: input.sourcePrompt,
  };
  return createHash("sha256").update(canonicalJson(revision), "utf8").digest("hex");
}


function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}
