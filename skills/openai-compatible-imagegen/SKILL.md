---
name: openai-compatible-imagegen
description: Generate, edit, annotate, and deliver OpenAI-compatible images in Codex App, and open a focused canvas from a concrete image result. Use for generation, reference edits, mask edits, transparent delivery, batches, version inspection, exact sizing, grid splitting, preview boards, deterministic QA, and continued work on historical images. The initial supported model is gpt-image-2. Do not switch to the built-in image_gen capability or another image route.
---

# OpenAI-Compatible Images

The conversation is the primary entry point for image generation and iterative edits. Open the focused canvas only from a concrete image result to inspect the image and express edit intent. Never expose credentials, Authorization headers, or local absolute paths in prompts.

## Project binding

Before calling any project-scoped tool, call `bind_imagegen_project` with the current Codex task's project root as `projectRoot`. Preserve the returned `projectBindingId` and pass it unchanged to every subsequent project tool in this task. The project root must come from the current task workspace, never from the Plugin installation directory, MCP `cwd`, roots, Git discovery, or other local state.

The first bind without an ID issues a new random binding, so do not repeat an initial bind in the same task. After configuration changes, rebind with the existing `projectBindingId` and the same `projectRoot`; rebinding the same project is idempotent and refreshes the configuration digest, while changing roots conflicts. MCP persists only a domain-separated digest of the binding ID, not the raw ID. Never substitute, recover, or guess a binding ID from the transport `sessionId`, roots, MCP `cwd`, a recent project, or other local state.

A `projectBindingId` survives MCP process and server restarts. Stop the current operation on `project_binding_required` or `project_binding_invalid`; do not scan old state or guess another ID. If a fresh start is required, create a new isolated binding only from the current task project root and continue with the new ID. Old canvas and submission state does not migrate automatically. App-only tools obtain the same ID from standard `tool-input.arguments.projectBindingId`, not private host fields.

## Platform runtime

The Plugin supports Windows, macOS, and Linux from one archive. Its Python bridge selects `python` on Windows and `python3` on macOS/Linux and requires Python 3.12 or newer. To choose one explicit executable, set `OPENAI_COMPATIBLE_IMAGEGEN_PYTHON`. An invalid override or failed preflight stops the operation; never probe another command or silently switch runtimes.

Repository safety uses a platform adapter behind `scripts/repository_fs.py`: Windows uses the Windows adapter, while macOS/Linux use the POSIX adapter. This adapter is Plugin-only and is not part of the Standalone Skill. macOS/Linux do not provide **Show in folder**; this does not block image generation, editing, artifact reads, annotations, or canvas work.

## Routing

1. For generation, call `generate_image` once. For multiple candidates, pass `count` in that same call. The runtime executes the same number of ordered single-image requests and returns the ordered group only when all succeed; any failure aborts the group without storing partial candidates. Do not retry or split it into multiple calls. For transparent delivery, pass top-level `transparency`, never `background=transparent`; the runtime resolves the route, enhances the prompt once before the API request, and preserves PNG originals. After ordinary generation, call `render_image_results` once with the returned IDs in order. For transparent generation, call `deliver_image` once per original, then render the successful derivatives together. Generation tools do not render image bytes, and display does not require `get_image_artifact`.
2. When the user wants to inspect or annotate an image, use **Open canvas** on its result card. Do not proactively call `open_image_editor` after a concrete result is already displayed; that tool is reserved for the result widget.
3. To edit an image, call `edit_image` with the parent image ID. For transparent delivery, also pass top-level `transparency` and call `deliver_image` once after success. For an ordinary edit, read the stable ID and version metadata from the result, then call `render_image_results` once. Do not call `get_image_artifact` only to display it.
4. When one user request contains multiple independent generation or ordinary edit tasks with different parameters, call `batch_images` once. For transparency or other local delivery, pass both `transparency` and `delivery` on that item. Read API originals from `artifacts` and per-image delivery state and derivatives from optional `delivery.results`. Prefer rendering all derivatives with `deliveryReady=true`; when none exists, render successful originals and report delivery state. Report item failures without retrying them. Preserve `batchId` when `manifestReady=true`; when false, report only that the batch record is unavailable and do not reverse successful publication. Mask or canvas submissions remain one separate `edit_image` call and never enter a batch.
5. After obtaining a stable image ID, call `deliver_image` once for transparency, exact dimensions, `contain` or safe margins, grid splitting, preview boards, or deterministic QA. Consume a saved transparency plan when the original has one; pass `delivery.transparency` only to specify or adjust the route for a historical image. After successful publication, read stable IDs from `artifacts` and call `render_image_results` once in order. For QA without derivatives, report QA directly and do not redisplay the original.
6. Use `get_image_artifact` to read an artifact. It returns data without creating a result card. Call `render_image_results` after reading only when the user needs to view a historical image and no result entry already exists.
7. Use `get_image_batch_manifest` with `batchId` to inspect a batch. It reads an immutable record and does not display images. To display a historical image from it, read by stable image ID and call `render_image_results`.
8. Use `get_image_delivery_receipt` with `deliveryReceiptId` to inspect local delivery or QA. It reads an immutable receipt and does not display images. To display a derivative, render the stable image ID recorded in the receipt.
9. Use `list_image_models` to inspect model capabilities.
10. On an explicit canvas submission, the widget calls `prepare_image_edit_submission` once to save annotations and obtain a server-issued `submissionId`. Never call it for unsubmitted annotations. `save_image_annotations` is not part of this atomic path.

## Batch tasks

`batch_images` accepts 1 to 64 independent items with unique `requestId` values. Each `count` is 1 to 16, the sum of all counts is at most 64, and concurrency is 1 to 8. Omitted concurrency uses the configured default. Each item is an ordinary `generate` or `edit`. An advanced batch item with `count=N` uses one provider request with `n=N`. Same-prompt conversation candidates still use one `generate_image(count=N)`, preserving N independent single-image requests and atomic group publication; never replace that route with advanced batch.

Batch results preserve input order and allow partial success per task and per returned image. `ok=true` means at least one deeply validated API original was published. `apiDelivery` records provider count, published count, and safe issue codes. Delivery success is `delivery.deliveryReady`. A delivery failure preserves and returns originals, does not reclassify the item as generation failure, and does not trigger model, endpoint, protocol, or API retries. When `manifestReady=true`, use `batchId` to read the immutable manifest. A recording failure does not reverse image publication.

## Local delivery

Use `deliverySize` for exact dimensions; `fit=contain` with `safeMargin` to preserve aspect ratio and padding; `grid`, `expectedCount`, and per-cell `deliverySize` for a known sheet layout; `preview.sizes` and `preview.backgrounds` for multi-size and multi-background inspection; `qa=true` for technical checks; and `components=true` when connected-component metrics are needed.

`deliver_image` reads one stable source image. The original stays immutable. Successful resized images, grid cells, and preview boards are stored with `operation=derive`, separate stable IDs, and a `derivedFrom` relationship outside the edit-version tree. Pass derivative IDs to `render_image_results` only when `deliveryReady=true`. When false, report `qa` and `warnings`; do not invent derivatives, transcode automatically, change format or model, or retry. Current local transforms accept PNG sources only. Preserve complete originals in other formats and report delivery as not ready.

For transparent delivery, choose `transparency.route`: `chroma-matting` for ordinary isolated subjects; `emissive-alpha` for black-background glow, fire, or particles; `mask-alpha` with a stable `maskImageId` when a deliberate mask image exists. Choose `prompt-alpha` only when configured `prompt_only_allow` exactly matches model, operation, and size. Otherwise preserve the original prompt and inspect the API original's alpha instead of claiming success. Never guess or generate `maskImageId`, and never substitute a canvas edit mask for a transparency-delivery mask.

Transparency runs before resizing, grids, and previews. If it fails, stop later derivatives and report that the original remains usable. When `parameters.transparency.llm_assisted.enabled=true`, perform at most `max_attempts` local redelivery attempts, adjusting `options` or changing local routes only when the corresponding switches allow it. Even if policy contains `allow_api_retry`, do not request the image API again; the current Plugin performs no API retry after transparency failure.

## Canvas submission

On a canvas submission message, read the latest model context fields: `projectBindingId`, `submissionId`, `imageId`, `annotationId`, `prompt`, `annotationCount`, `intents`, and `requestText`. When the task contains multiple canvas contexts, use the newest `submissionId` associated with the current user message and never merge earlier submissions. Pass `projectBindingId` unchanged to this `edit_image` call, `submissionId` unchanged as `edit_image.submissionId`, and `imageId` as `edit_image.parentImageId`. Omit `annotationId` when null; otherwise pass it unchanged. Do not call `prepare_image_edit_submission` or `save_image_annotations` again.

Combine the annotation preview, per-region instructions, and additional request into one prompt describing the complete target image, then call `edit_image` once. With mask annotations, describe the complete target image rather than only the replacement region. For protected content, name what must remain and what lighting or shading may adapt naturally to the scene. Relay only the user's target; never author, append, or override `MASK_GUARD_V2_BY_STRATEGY`. The runtime constructs final protection text from the issued submission's `maskPolicy`. Stop if the image ID, `submissionId`, or edit intent is missing. Never guess an ID or switch to `generate_image` or another route.

After `edit_image` succeeds, display the new image, stable ID, and parent-child version relationship in the current conversation. The new result retains its **Open canvas** entry.

## Canvas lifecycle

Treat the `editorSessionId` returned by `open_image_editor` as the active canvas session for this task.

- Call `destroy_image_editor` when the user explicitly asks to destroy the canvas.
- Call it when the task has clearly moved to another objective and the current image will no longer be viewed, annotated, or edited.
- Do not destroy the canvas when the user only hides or closes the side panel, discusses another topic temporarily, waits for another generation, or may continue working on the image.
- Never guess an unknown active `editorSessionId` or call the destroy tool without it.

The canvas **Destroy canvas** button and `destroy_image_editor` share one lifecycle. Destruction ends all active canvas sessions for that image within the current project binding and permanently removes its reopen entry for that binding. The state survives MCP process restarts; other project bindings are unaffected, and image artifacts and version relationships remain. After destruction, do not call `open_image_editor` or `render_image_results` for the same image to restore the entry.

The initial model is `gpt-image-2`. Model capabilities come from the catalog. After failure, do not switch model, endpoint, provider, or edit route.

## Configuration

The Plugin resolves configuration only from:

1. User configuration: `~/.codex/openai-compatible-imagegen/config.json`
2. Optional project overrides: `<project-root>/.codex/openai-compatible-imagegen/config.json`

The user configuration must exist and provides the trusted baseline with `config_version: 1`, `active_profile: "primary/gpt-image-2"`, provider, complete model, defaults, post-processing, transparency policy, and storage. The project file is validated independently before reading the user file. It may override only `defaults.size`, `defaults.quality`, `defaults.output_format`, and `storage.output_directory`. It cannot declare or indirectly change profiles, models, provider, endpoint, authentication, credential environment variables, timeout, concurrency, or route permissions. Invalid or excessive project configuration fails without being ignored or falling back, and before user credentials or network requests are accessed.

Effective priority is explicit tool arguments, then allowlisted project overrides, user defaults, and built-in defaults. When user configuration is missing, stop image work and tell the user to create it from `references/config.example.json`. Legacy `auth.json` and older Plugin configuration are never read, copied, merged, deleted, or overwritten automatically. Migration requires an explicit user command and never reveals API keys.

Use MCP configuration tools for the complete Plugin flow. Call `initialize_image_config` to create the fixed user template when missing; it always creates a `.gitignore` containing only `*` in the user configuration directory and, when given a project root, protects the project configuration directory without changing the project root `.gitignore`. Use `inspect_image_config` to read configuration and `update_image_config` to change it, which adds the same directory protection before writing. Prefer `api_key_env`. When the user explicitly requests local plaintext credentials, user-level `api_key` may be written but never returned. Project scope forbids credentials and remains limited to size, quality, output format, and `storage.output_directory`. Rebind the image project after updates.

### Explicit migration

Proceed only when the user explicitly requests migration and provides the source path and source type. Resolve `<plugin-root>` by going two levels above this `SKILL.md`; never infer it from MCP `cwd`, a project Git root, or another installation cache.

Run a redacted dry run for a legacy Standalone configuration:

```text
python "<plugin-root>/dist/scripts/migrate_image_config.py" --source "<legacy-config>" --source-kind standalone
```

For an older Plugin configuration, use the retained compatibility value `--source-kind development-plugin`. Add `--include-project-overrides --project-root "<project-root>"` to both dry-run and write only when the user explicitly wants allowlisted defaults and output directory written to the current project.

Report `sourceKind`, `sourceSha256`, `userTarget`, `projectTarget`, `readyToWrite`, and the redacted preview. After user confirmation, preserve the source path, source type, user directory, and project override arguments, then run:

```text
python "<plugin-root>/dist/scripts/migrate_image_config.py" --source "<legacy-config>" --source-kind standalone --write --expected-source-sha256 "<sourceSha256>"
```

If `readyToWrite=false` requests plaintext-key authorization, stop. Add `--allow-plaintext-api-key` only after the user separately approves plaintext-key migration. On digest mismatch, existing target, incompatible schema, or write failure, report the original migration error and stop. Do not change source, target, route, or authentication method. Preserve the source file after success; never delete or rename it automatically.

Optional `storage.output_directory` must be a safe project-relative path. When absent, use `<project-root>/output/imagegen/`. Reject the project root itself, paths outside the project, files, symbolic links, junctions, and other reparse points. Project binding creates or verifies a `.gitignore` containing only `*` in the artifact directory. Add a missing rule; stop without overwriting when the rule is wrong or the path unsafe. Binding freezes configuration; rebind the same project explicitly after changes.

The artifact root selects one active repository. Once an override is effective, images, versions, annotations, masks, submission recovery, and **Show in folder** read only that directory. Never scan, merge, migrate, or copy older artifacts from the default directory. After removing the override and rebinding, older artifacts in the default directory become available again.

Image URL downloads use the environment proxy by default. Set provider `url_download.proxy_mode` to `direct` only after explicit user approval. This affects only provider-returned image URL downloads, not generation or edit endpoints, models, protocols, or proxy routes. Never change it automatically after TLS or network failure.

## Results

`render_image_results` is the sole result-widget entry. It accepts one or more stable image IDs, returns model-visible image content and safe metadata in input order, and provides a separate **Open canvas** entry for each canvas that has not been destroyed. Destroyed images remain visible, but their entry reads **Canvas destroyed** and cannot be used.

The result widget treats only standard `ui/notifications/tool-input.arguments.imageIds` as image identity for the result. `ui/notifications/tool-result` indicates only completion or a server error. Never infer, recover, or replace image IDs from result `content`, `structuredContent`, or `_meta`. Each image is read once through App-only `read_image_artifact_data`. Stop that card on mismatched request ID, public artifact ID, private widget data ID, or MIME. Do not call `get_image_artifact` or switch read routes. Data tools `generate_image`, `edit_image`, and `get_image_artifact` do not bind the result widget.

Return the result images, stable IDs, corresponding canvas entries, version relationships, and safe error summaries to the user. Editing creates a new version and never overwrites its parent. Images and annotations stay in the project artifact root resolved from the binding configuration. That local path never enters tool results, the widget, or model context.
