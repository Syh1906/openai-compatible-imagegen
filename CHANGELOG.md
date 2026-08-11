# Changelog

This file records user-visible changes for each release of `openai-compatible-imagegen`.

## [Unreleased]

### Added

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
- Evaluate transparency independently for each returned image and skip dependent delivery transforms only for unmet images.
- Preserve API originals when publishing derived transparent files.
- Classify HTTP 4xx image requests as `api_rejected`, separate from post-response transparency checks.
- Reject API images whose actual pixel dimensions differ from the resolved generation size before publication.
- Resolve batch input paths from the JSONL directory and output paths from `--out`, then record `output_root` and `path_contract` in the manifest.
- Run bundled Python commands in the foreground without child processes or persistent local-model workers.

### Fixed

- Keep chroma contamination QA independent from matte tuning, preventing reduced tolerances from falsely passing visible key-color edges.
- Preserve an already-valid native alpha image before any local transparency route can reprocess or reject it.

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
- Reject malformed, interlaced, unsupported-encoding, oversized, or structurally invalid PNG responses and local inputs before delivery or transformation.
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
