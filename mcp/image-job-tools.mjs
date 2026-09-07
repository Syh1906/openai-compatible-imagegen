import { z } from "zod";

import { imageJobOutputSchema, jobIdSchema } from "./image-job-contract.mjs";
import { projectBindingIdSchema } from "./image-tool-schemas.mjs";

export function imageJobResult(job) {
  const presentationIds = job.items.flatMap((item) => {
    const result = item.result;
    if (!result?.ok) return [];
    return result.artifacts.flatMap(({ id }) => {
      const delivery = result.delivery?.results.find((receipt) => receipt.sourceArtifactId === id);
      return delivery?.deliveryReady && delivery.artifacts.length ? delivery.artifacts.map((artifact) => artifact.id) : [id];
    });
  }).slice(0, 10);
  const action = job.done
    ? "读取所有结果分页，并用 render_image_results 展示尚未展示的成功图片。结果未知的项不得自动重新生成。"
    : job.status === "interrupted"
      ? "任务执行已中断。resume_image_job 只恢复未发出的请求和已保存原图的本地处理，不重新生成结果未知的项。"
      : "继续调用 get_image_job 查询此任务；查询超时不会取消生成，请勿重新创建请求。";
  return {
    content: [{ type: "text", text: `图片任务 ${job.jobId}：${job.summary.succeeded}/${job.summary.total} 项成功，${job.summary.localFailed} 项本地处理未完成，${job.summary.unknown} 项结果未知，${job.summary.running} 项执行中，${job.summary.queued} 项排队中。${action}${presentationIds.length ? ` 本页可展示的图片 ID：${presentationIds.join(", ")}。` : ""}` }],
    structuredContent: job,
  };
}

export function registerImageJobTools(server, { jobs, projectContext, toolError }) {
  const input = { projectBindingId: projectBindingIdSchema, jobId: jobIdSchema };
  server.registerTool("get_image_job", {
    title: "Get image job",
    description: "Read a durable image job and an ordered page of up to 10 item results. Poll the same job until done; a query timeout never resubmits or cancels generation. Render successful images once, then read nextOffset pages. Unknown outcomes must not be regenerated automatically.",
    inputSchema: { ...input,
      offset: z.number().int().min(0).max(63).optional(), limit: z.number().int().min(1).max(10).optional(),
      afterRevision: z.number().int().nonnegative().optional(), waitMs: z.number().int().min(0).max(20_000).optional(),
    },
    outputSchema: imageJobOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ projectBindingId, afterRevision, waitMs = 0, ...request }, extra) => {
    try {
      const context = await projectContext.require(projectBindingId);
      const deadline = Date.now() + waitMs;
      let job;
      do {
        job = await jobs.get({ ...request, context });
        if (job.done || job.status === "interrupted" || afterRevision === undefined || job.revision > afterRevision || extra.signal.aborted) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await pause(Math.min(500, remaining), extra.signal);
      } while (Date.now() < deadline);
      return imageJobResult(job);
    } catch (error) { return toolError(error); }
  });
  for (const [name, method, title, description] of [
    ["cancel_image_job", "cancel", "Cancel image job", "Cancel queued items in this job. Running items, including atomic candidate groups, may still finish and incur charges; their successful originals remain recoverable. Does not delete images."],
    ["resume_image_job", "resume", "Resume image job", "Resume only never-dispatched items and local processing with saved originals. Never resubmit failed or unknown image requests. Requires the original configuration; does not change provider, model, authentication, or route."],
  ]) {
    server.registerTool(name, {
      title, description, inputSchema: method === "resume"
        ? { ...input, expectedRevision: z.number().int().nonnegative().describe("Revision from get_image_job. Reuse it after a lost resume reply to avoid repeating local processing.") }
        : input,
      outputSchema: imageJobOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: method === "resume" },
    }, async ({ projectBindingId, jobId, expectedRevision }) => {
      try { return imageJobResult(await jobs[method]({ jobId, expectedRevision, context: await projectContext.require(projectBindingId) })); }
      catch (error) { return toolError(error); }
    });
  }
}

function pause(ms, signal) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
