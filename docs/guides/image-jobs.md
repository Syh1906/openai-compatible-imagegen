# Long-running generation and batches

> Parent: [User guides](./README.md)

Language: [简体中文](./image-jobs.zh-CN.md)

The Codex Plugin saves API Key generation, edit, and batch jobs before returning a job ID. Codex can query progress and display completed images without keeping one tool call open for the entire batch. ChatGPT host generation and the Standalone CLI retain their existing workflows.

## Submit and view results

Describe the images as usual, for example: “Generate 40 different plant icons and save each separately.” Codex retains a submission key and job ID, queries the job until it finishes, and displays all successful results in groups.

A batch supports up to 64 items and 64 images in total. Concurrency is 1–8 and defaults to the user configuration. Multiple candidates for the same prompt still use ordered requests and are saved only when the whole group succeeds.

## Continue after a timeout

A tool timeout does not prove generation failed or that no charge occurred. Tell Codex: “Query the previous image job and continue showing results without regenerating.”

Ask Codex to recover results using the saved job information. A new submission key creates a separate request and can generate and bill again.

Job state and confirmed results are stored in the current image artifact directory and remain queryable after a Plugin restart. Interrupted execution can take up to 60 seconds to be identified. Recovery requires the original project, artifact directory, and image configuration.

| State | Action |
| --- | --- |
| Queued or running | Keep querying the same job |
| Succeeded | View the saved images or continue editing |
| Local processing failed | Keep the originals and resume local processing without another image request |
| Interrupted | Resume never-dispatched items and local processing with saved originals |
| Unknown outcome | Keep the job information and check the provider's request records; do not regenerate automatically |

To resume, say: “Continue the interrupted job using only never-dispatched items and local processing of saved originals.” Recovery never resubmits failed or unknown image requests.

## Cancellation and limitations

When you ask Codex to cancel a job, the Plugin stops queued items. Running items, including atomic candidate groups, may still finish and incur charges. Saved images are not deleted. Stopping a query ends only that wait, not the generation job.

Exiting the Plugin interrupts execution; saved results remain recoverable. A crash after saving an image but before recording its job result can leave the outcome unknown. The Plugin cannot revoke requests already received by a provider and does not regenerate automatically to recover results.

## Progress previews and final delivery

With either the API Key or ChatGPT route in the Codex Plugin, images can be generated, edited, or processed in stages. You can check progress along the way and view the images needed for delivery together in the final response. When you need to choose a direction, the candidates for comparison are shown together. Images previewed earlier may appear again in the final response; reusing saved images does not generate them again.

Delivery includes the independent assets you requested and candidates still needed for comparison, preferring final edits and successfully processed images. References, experiments, and superseded drafts are usually omitted; ask to keep them when you need a before-and-after comparison. Results appear in order, grouped when there are more than ten images. Each image has its own canvas entry, but a destroyed canvas cannot be reopened.

If only some images succeed, Codex explains which results are missing. If local processing fails but the original remains usable, you can view it with an explanation of any unmet size, transparency, or other requirements. If a result card does not load its images, ask Codex to check the saved results or see [Troubleshooting](./troubleshooting.md). Displaying saved results does not require generating them again.
