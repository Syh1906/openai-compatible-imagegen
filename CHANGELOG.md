# Changelog

This file records user-visible changes for each release of `openai-compatible-imagegen`.

## [Unreleased]

### Fixed

- Prevent concurrent Codex Plugin tools from intermittently reporting a valid project binding as unavailable while another Plugin process refreshes it.
- Update result cards immediately when the Codex host locale changes instead of waiting for a later artifact refresh.

## [1.1.0] - 2026-08-19

### Added

- Add one platform-neutral Codex Plugin runtime for Windows, macOS, and Linux with platform-specific secure repository filesystem adapters.
- Add explicit Python command mapping (`python` on Windows, `python3` on macOS/Linux) and the `OPENAI_COMPATIBLE_IMAGEGEN_PYTHON` override with a Python 3.12-or-newer preflight.
- Expand CI and release candidates to Windows, Linux, and macOS, requiring identical candidate file sets and SHA-256 bytes before publication.

### Changed

- Keep the platform filesystem adapters and MCP runtime files Plugin-only; the Standalone Skill release remains independent.

### Fixed

- Accept the macOS system `/var` alias to `/private/var` while continuing to reject project-owned symbolic links outside the safe repository path contract.

### Known limitations

- macOS and Linux do not provide the Windows **Show in folder** action. Generation, editing, artifacts, annotations, and canvas workflows remain supported.

## [1.0.2] - 2026-08-19

### Added

- Localize the Plugin result cards, focused canvas, accessibility labels, tooltips, confirmations, status messages, and runtime toasts in English and Chinese.
- Preserve focused-canvas drafts when users switch tasks, return to the conversation, or reopen the same image.
- Add Simplified Chinese mirrors for the public guides and architecture documentation, with language-matched navigation.
- Document first-time Standalone installation from the versioned archive with the third-party `skills@latest` CLI.

### Changed

- Use English for both Standalone and Codex Plugin runtime Skill instructions and for public Plugin and MCP metadata.
- Treat every Chinese locale variant as one Chinese Widget locale; missing and non-Chinese locales use English.

### Fixed

- Restore each image candidate's latest canvas draft without allowing an older save to replace newer edits.
- Open and resume the focused canvas without the unnecessary delay introduced by sequential startup work and repeated localization passes.
- Keep versioned Widget resource identities stable when equivalent source checkouts use different text line endings.

### Known limitations

- The third-party `skills@latest` CLI supports first-time project and user installation from the extracted Standalone archive, but it does not update local copied sources and repeating `add` removes the installed `auth.json`. Project-level `remove` can leave the installation registered; the verified user-level `remove --global` completed cleanly. Use versioned ZIP directories for updates and rollback.

## [1.0.1] - 2026-08-18

### Added

- Include a ready-to-use local marketplace in the Codex Plugin ZIP and document the supported download, checksum, extraction, and local installation flow.
- Publish verified release artifacts from an existing annotated version tag with a GitHub Release title equal to that tag.

### Fixed

- Protect user and project configuration directories during initialization, update, and migration by creating or verifying a local `.gitignore` containing only `*`.
- Protect the resolved image artifact directory during project binding so generated images, prompts, annotations, and metadata are not added to Git accidentally.

## [1.0.0] - 2026-08-18

### Added

- Add the `OpenAI-Compatible Images` Codex App Plugin with conversation image results, focused canvas editing, annotations, immutable artifacts, edit versions, advanced batch delivery, and deterministic QA.
- Add a versioned Plugin configuration with a trusted user baseline and allowlisted project overrides for default size, quality, format, and project-local output directory.
- Add an explicit, redacted migration workflow for older Standalone and Plugin configurations. Migration never overwrites an existing target or deletes the source.
- Publish separate Standalone Skill and Codex Plugin archives from the same shared image core.
- Add a Git-backed Codex marketplace with a prebuilt MCP server, widget, and Python runtime so Plugin installation does not require a source build or local web server.
- Add task-focused installation, configuration, migration, rollback, troubleshooting, architecture, contribution, security, and Agent guidance.
- Add deterministic `SHA256SUMS` for both package archives and shared-core evidence.
- Add MCP tools to initialize, inspect, and safely update Plugin configuration without locating the installed Plugin directory.

### Changed

- Present the repository as the `OpenAI-Compatible Images` product family. Users choose either the portable `OpenAI-Compatible Images Skill` or the complete Codex Plugin; the Plugin includes the Standalone generation and delivery capabilities.
- Use `openai-compatible-imagegen` as the stable technical identity across the Plugin, configuration directory, bundled Skill, and release artifacts.
- Keep the root README focused on package choice and first installation, with detailed operations routed to audience-specific guides.
- Use the documented `codex plugin` and `codex plugin marketplace` lifecycle commands for installation, inspection, removal, marketplace refresh, and version pinning.

### Fixed

- Match the focused canvas to Codex host theme colors, including custom host palettes, instead of rendering with a fixed light palette.
- Serve the active widget from a content-fingerprinted resource URI so Plugin updates do not reopen a cached older UI, while retaining fixed and historical URIs for earlier conversations.
- Fix result cards that could remain blank or show `IMG-SCHEMA` after Codex projected a large image result. Cards now bind their ordered image IDs from the standard tool input and load each image once through the App-only data tool.
- Reject artifact reads whose returned stable image ID differs from the requested ID before exposing image content or widget data.
- Serialize same-process editor state mutations per project binding so concurrent canvas opens do not fail with `editor_state_unavailable` on slower Windows filesystems.
- Preserve an unsent canvas draft when Codex restores the side panel to the inline result after switching tasks, so the same image can be reopened without rebuilding the edit.

### Known limitations

- After switching tasks, Codex may restore the side panel to the result card instead of the open canvas. Use **Continue editing** on that card to reopen the preserved draft.

### Security

- Reject project configuration that attempts to change the active profile, model, provider, endpoint, authentication source, credential environment variable, timeout, concurrency, or route permissions.
- Require project output directories and migration targets to pass path, reparse-point, non-overwrite, and source-integrity checks before writing.
- Keep API keys out of configuration tool outputs, prefer environment-variable credentials, and allow explicit user-level plaintext storage when requested. Project-aware initialization creates a local `*` ignore rule inside the project configuration directory without changing the root `.gitignore`.

## [0.3.0] - 2026-08-13

### Added

- Add deterministic transparent-background processing for controlled solid-color plates, black-backed emissive effects, and trusted alpha, luminance, or RGB-channel masks.
- Add matte refinement controls for edge expansion or contraction, feathering, small-component cleanup, known black or white matte removal, and defringing.
- Add `apply-transparency` for processing an existing PNG without another image API request.
- Add exact `transparency.prompt_only_allow` rules for backend combinations verified for prompt-guided alpha output.
- Add optional bounded `transparency.llm_assisted` route and parameter adjustment.
- Add stricter bounded validation for PNG, JPEG, and WebP originals before publication.

### Changed

- Treat `--transparent` as delivery intent and never send `background=transparent` to the image API.
- Return API images unchanged with `transparency.status=unmet` and warnings when prompt alpha or local processing does not meet the transparency checks.
- Report `delivery_ready` separately from API success, and keep preserved originals available when transparency remains unmet.
- Continue 2K and 4K transparent requests when no exact prompt-only rule exists; run the configured local route when permitted, or preserve and inspect API originals without local pixel changes when processing is disabled.
- Return API originals together with successful transparent derivatives, expose `derived_files`, and omit unpublished intermediate files.
- Evaluate transparency for each returned image. One unmet image no longer hides successful peer originals or derivatives.
- Classify HTTP 4xx image requests as `api_rejected`, separate from post-response transparency checks.
- Publish every complete API image and report count, format, and pixel-size deviations through `warnings` and `api_delivery` instead of withholding originals.
- Preserve API originals when non-transparent transforms or QA fail, with `delivery_ready=false` and no partial derivative publication.
- Resolve batch input paths from the JSONL directory and output paths from `--out`, then record `output_root` and `path_contract` in the manifest.

### Fixed

- Detect directional key-color spill and keep contamination checks independent from matte tuning.
- Preserve an already-valid native alpha image before any local transparency route can reprocess or reject it.
- Respect `--no-postprocess` without blocking image generation or hiding API originals.
- Treat an unverified explicit `prompt-alpha` route as source-alpha inspection instead of blocking the request or adding an unverified prompt contract.
- Prevent batch output collisions for corrected formats, unexpected extra API images, and derived files.
- Publish standard grayscale, indexed, 16-bit, and Adam7 PNG API originals independently from local post-processing limits.
- Support non-interlaced 16-bit RGB/RGBA PNG files in local processing through deterministic 8-bit conversion.
- Reject incomplete JPEG and WebP codec streams before publication.

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

[Unreleased]: https://github.com/Syh1906/openai-compatible-imagegen/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Syh1906/openai-compatible-imagegen/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/Syh1906/openai-compatible-imagegen/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Syh1906/openai-compatible-imagegen/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Syh1906/openai-compatible-imagegen/compare/v0.3.0...v1.0.0
[0.3.0]: https://github.com/Syh1906/openai-compatible-imagegen/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Syh1906/openai-compatible-imagegen/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/Syh1906/openai-compatible-imagegen/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Syh1906/openai-compatible-imagegen/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Syh1906/openai-compatible-imagegen/releases/tag/v0.1.2
[0.1.1]: https://github.com/Syh1906/openai-compatible-imagegen/releases/tag/v0.1.1
[0.1.0]: https://github.com/Syh1906/openai-compatible-imagegen/releases/tag/v0.1.0
