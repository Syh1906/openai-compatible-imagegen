# Changelog

This file records user-visible changes for each release of `openai-compatible-imagegen`.

## [Unreleased]

### Added

- Add a shared 8-bit Alpha matte pipeline with edge-connected or global color range, explicit RGB mask-channel input, matte refinement, known black/white matte removal, defringing, and multi-background review records.
- Preserve trusted fully opaque mask foreground during Remove Matte/Defringe, and skip color-neighbor search immediately when no reliable replacement color exists.
- Retain successful per-image derivatives when QA fails only for another image, while keeping global delivery contracts transactional.
- Validate PNG compressed-stream completion and exact decompressed length through a 512 MiB scanline ceiling so corrupt IDAT data is never published as an original.
- Limit PNG response and local-decoder IDAT fragmentation to 4096 chunks.
- Validate complete bounded VP8L WebP entropy streams before original publication without loading a model or retaining a decoded pixel image; validate VP8 container, keyframe, dimensions, and first-partition bounds.
- Add deterministic `chroma-matting` transparency processing with edge-connected key-color removal, edge despill, and alpha validation.
- Add `emissive-alpha` and explicit `mask-alpha` local transparency routes with bounded tuning parameters.
- Add `apply-transparency` for processing existing PNG files without another image API request.
- Add exact `transparency.prompt_only_allow` rules for explicitly permitted prompt-only alpha generation.
- Add optional bounded `transparency.llm_assisted` route and parameter adjustment policy without local model runtimes or weights.
- Add technical reference-image metadata without using semantic heuristics to block edit requests.

### Changed

- Treat `--transparent` as delivery intent and never send `background=transparent` to the image API.
- Return API images unchanged with `transparency.status=unmet` and warnings when prompt alpha or local processing does not meet the transparency checks.
- Report `delivery_ready` separately from API success, and keep preserved originals available when transparency remains unmet.
- Continue 2K and 4K transparent requests when no exact prompt-only rule exists; run the configured local route when permitted, or preserve and inspect API originals without local pixel changes when processing is disabled.
- Return transparent API originals together with successful derived files, expose `derived_files`, and omit unpublished intermediate transparency files.
- Publish each complete API image independently, keep staged derivatives transactional for global QA contracts, recursively validate manifest file paths, and avoid creating an original-image duplicate when standalone transparency processing is unmet.
- Evaluate transparency independently for each returned image and skip dependent delivery transforms only for unmet images.
- Preserve API originals when publishing derived transparent files.
- Classify HTTP 4xx image requests as `api_rejected`, separate from post-response transparency checks.
- Publish every complete API image and report count, format, and pixel-size deviations through `warnings` and `api_delivery` instead of withholding originals.
- Decode, validate, and publish response items sequentially under explicit JSON, item-count, per-image, and cumulative decoded-byte limits so a later resource failure preserves earlier originals.
- Run full PNG scanline and filter validation through 96 MiB, use bounded exact-length validation through 512 MiB, and return an explicit resource-limit error above that ceiling.
- Preserve API originals when non-transparent transforms or QA fail, with `delivery_ready=false` and no partial derivative publication.
- Resolve batch input paths from the JSONL directory and output paths from `--out`, then record `output_root` and `path_contract` in the manifest.
- Run bundled Python commands in the foreground without child processes or persistent local-model workers.

### Fixed

- Catch pale directional key-color spill outside the absolute RGB extraction range.
- Keep chroma contamination QA independent from matte tuning, preventing reduced tolerances from falsely passing visible key-color edges.
- Preserve an already-valid native alpha image before any local transparency route can reprocess or reject it.
- Respect `--no-postprocess` without blocking image generation or hiding API originals.
- Treat an unverified explicit `prompt-alpha` route as source-alpha inspection instead of blocking the request or adding an unverified prompt contract.
- Keep successful peer originals and derivatives when another image cannot be published or transformed, and report only warnings for files that were actually published.
- Reserve batch directories for unexpected extra API images before workers start, preventing cross-task overwrite.
- Reserve shared derived-output names for possible extra API response items before workers start, preventing cross-task derivative overwrite.
- Exclude non-path option values such as `mask-alpha` source modes from manifest file-existence checks.
- Publish standard grayscale, indexed, 16-bit, and Adam7 PNG API originals independently from local post-processing limits.
- Decode non-interlaced 16-bit RGB/RGBA API PNG files for local processing by deterministically reducing channel samples to 8-bit RGBA.
- Reject JPEG scans that reference missing Huffman tables and truncated VP8L WebP entropy streams.

### Removed

- Remove `--background transparent` and the `capabilities.transparent_background` configuration field.

## [0.2.0] - 2026-08-10

### Added

- Add deterministic `qa.v1` delivery checks for expected size, transparency, alpha geometry, edge contact, and optional connected-component diagnostics.
- Add exact delivery sizing with selectable resampling, stretch or contain fitting, and fractional safe margins.
- Add target-size and background preview boards with a machine-readable preview manifest.

### Changed

- Expand examples and user documentation across product, editorial, brand, interface, marketing, and game image workflows.
- Document per-row batch QA and delivery controls, including `delivery_size`, `resample`, `fit`, `safe_margin`, and `components`.
- Use alpha-aware bilinear resizing by default; `nearest` remains available for intentional pixel replication.
- Respect explicit image-backend choices instead of claiming priority over other image-generation routes.

### Fixed

- Validate Base64 image structure, response item types, and requested image counts before writing output files.
- Bound API JSON, image, and error-response reads; reject format mismatches and header-only or truncated JPEG/WebP frames.
- Reject malformed, unsupported, oversized, or structurally invalid PNG local-transform inputs before transformation.
- Reject RGB PNG `tRNS` transparency instead of silently treating it as opaque.
- Preserve source edge pixels during bilinear resizing and keep large decoded PNG buffers compact.
- Preflight batch output conflicts and publish multi-file post-processing results transactionally.
- Check source and delivery transparency separately so transparent padding cannot hide an opaque API result.
- Enforce per-preview, cumulative-preview, and preview-board pixel limits before allocation.

## [0.1.4] - 2026-08-04

### Added

- Add one-shot `--allow-direct-url-download` and persistent `url_download.proxy_mode=direct` authorization for direct image URL downloads.

### Changed

- Start direct image URL downloads without first attempting the configured proxy, while keeping image API requests on the normal network path.

### Fixed

- Accept both Base64 and URL image responses without sending the DALL-E-only `response_format` parameter.
- Validate downloaded PNG, JPEG, and WebP files and report incomplete URL responses without exposing signed query parameters.

## [0.1.3] - 2026-08-04

### Added

- Add `scripts/quick-init.py` for interactive and non-interactive local authentication setup.
- Add the optional `auth.json` field `user_agent` for providers that require a specific HTTP client signature.

### Changed

- Send a browser-compatible Windows Chrome `User-Agent` by default instead of Python's `Python-urllib` identifier.
- Apply the configured `User-Agent` to JSON generation requests, multipart edit requests, and returned image URL downloads.
- Prefer this skill over built-in image-generation routes and stop with the original error instead of switching routes automatically.
- Include the effective `user_agent` in the redacted `info` output.

### Fixed

- Fix image requests rejected by provider gateways that block Python client signatures.

## [0.1.2] - 2026-06-22

### Added

- Add semantic image sizing with `--aspect` and `--resolution`.
- Validate known unsupported transparent-background and resolution combinations before sending a request.

## [0.1.1] - 2026-06-18

### Added

- Add PNG inspection, resizing, and grid-splitting workflows.
- Add explicit generated-output post-processing controls.

## [0.1.0] - 2026-06-17

### Added

- Publish the initial Agent Skills-compatible image generation workflow.
- Support OpenAI-compatible image generation, image editing, local authentication, transparent asset intent, and JSONL batches.

[0.2.0]: https://github.com/Syh1906/openai-compatible-imagegen/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/Syh1906/openai-compatible-imagegen/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Syh1906/openai-compatible-imagegen/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Syh1906/openai-compatible-imagegen/releases/tag/v0.1.2
[0.1.1]: https://github.com/Syh1906/openai-compatible-imagegen/releases/tag/v0.1.1
[0.1.0]: https://github.com/Syh1906/openai-compatible-imagegen/releases/tag/v0.1.0
