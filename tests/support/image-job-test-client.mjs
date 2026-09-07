import assert from "node:assert/strict";

const imageTools = new Set(["generate_image", "edit_image", "batch_images"]);

// Artifact, mask, and delivery behavior tests still examine completed results.
// Job protocol tests use the unwrapped client and assert the actual submission/query schemas.
export function withCompletedImageJobs(callTool) {
  let sequence = 0;
  return async (request, ...options) => {
    if (!imageTools.has(request.name)) return await callTool(request, ...options);
    const submitted = await callTool({
      ...request, arguments: { submissionKey: `test-submission-${++sequence}`, ...request.arguments },
    }, ...options);
    if (!submitted.structuredContent?.jobId) return submitted;
    const jobId = submitted.structuredContent.jobId;
    let status = submitted;
    const deadline = Date.now() + 120_000;
    while (!status.structuredContent.done) {
      assert.ok(Date.now() < deadline, "image job did not finish");
      assert.notEqual(status.structuredContent.status, "interrupted", "image job unexpectedly interrupted");
      status = await callTool({ name: "get_image_job", arguments: {
        ...(request.arguments?.projectBindingId ? { projectBindingId: request.arguments.projectBindingId } : {}), jobId, limit: 1,
        afterRevision: status.structuredContent.revision, waitMs: 1000,
      } });
      assert.equal(status.isError, undefined, status.content?.[0]?.text);
    }
    const items = [];
    const pageContent = [];
    let offset = 0;
    do {
      const page = await callTool({ name: "get_image_job", arguments: {
        ...(request.arguments?.projectBindingId ? { projectBindingId: request.arguments.projectBindingId } : {}),
        jobId, offset, limit: 10,
      } });
      assert.equal(page.isError, undefined, page.content?.[0]?.text);
      items.push(...page.structuredContent.items);
      pageContent.push(...page.content);
      offset = page.structuredContent.nextOffset;
    } while (offset !== null);
    const results = items.map((item) => item.result);
    if (request.name !== "batch_images" && !results[0]?.ok) {
      return { isError: true, content: [{ type: "text", text: `${results[0].error.code}: ${results[0].error.message}` }] };
    }
    const artifacts = results.flatMap((result) => result?.ok ? result.artifacts : []);
    if (request.name === "batch_images") {
      const artifactIds = items.flatMap((item) => item.artifactIds);
      const manifest = status.structuredContent.manifest ?? { manifestReady: false };
      const succeeded = results.filter((result) => result.ok).length;
      return {
        content: pageContent,
        structuredContent: { results, summary: { total: results.length, succeeded, failed: results.length - succeeded, artifactCount: artifactIds.length }, artifactIds, ...manifest },
        _meta: { imageIds: artifactIds, artifacts, ...(manifest.batchId ? { batchId: manifest.batchId } : {}) },
      };
    }
    return {
      content: status.content,
      structuredContent: { artifacts, ...(artifacts.length === 1 ? { artifact: artifacts[0] } : {}) },
      _meta: { imageIds: artifacts.map(({ id }) => id), artifacts, ...(artifacts.length === 1 ? { imageId: artifacts[0].id } : {}) },
    };
  };
}
