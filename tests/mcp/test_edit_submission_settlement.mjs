import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createEditSubmissionRegistry } from "../../mcp/edit-submission-registry.mjs";
import { createFileEditSubmissionRegistry } from "../../mcp/file-edit-submission-registry.mjs";

for (const [name, createRegistry] of [["memory", createEditSubmissionRegistry], ["file", createFileEditSubmissionRegistry]]) {
  test(`${name} submission settlement is replayable and fenced by claim generation`, async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "imagegen-settlement-"));
    const input = { artifactRoot, bindingKey: "1".repeat(64), parentImageId: "img_01J00000000000000000000000",
      annotationId: null, sourcePrompt: "edit", items: [], maskSha256: null, maskPolicySha256: null };
    const registry = createRegistry();
    try {
      const receipt = await registry.issue(input);
      const lookup = { ...input, submissionId: receipt.id };
      const claimed = await registry.claimForEdit(lookup);
      const firstClaim = { ...lookup, claimGeneration: claimed.claimGeneration };
      const released = await registry.releaseForEdit(firstClaim);
      assert.deepEqual(await registry.releaseForEdit(firstClaim), released);
      const next = await registry.claimForEdit(lookup);
      await assert.rejects(async () => await registry.releaseForEdit(firstClaim), (error) => error.code === "stale_edit_submission");
      const completed = { ...lookup, claimGeneration: next.claimGeneration, artifactIds: ["img_01J00000000000000000000001"] };
      const result = await registry.complete(completed);
      assert.deepEqual(await registry.complete(completed), result);
      await assert.rejects(async () => await registry.complete({ ...completed, artifactIds: ["img_01J00000000000000000000002"] }),
        (error) => error.code === "stale_edit_submission");
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });
}
