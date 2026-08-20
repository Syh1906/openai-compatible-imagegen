---
name: openai-compatible-imagegen
description: Generate, edit, and batch-process images through the bundled OpenAI-compatible image API script. Use for photos, illustrations, product visuals, posters, covers, diagrams, UI references, game art, transparent subjects, reference-image edits, inpainting, multi-reference compositions, and image batches when this local OpenAI-compatible workflow is the requested backend. Do not force this workflow when the user explicitly selects another image tool or backend.
---

# OpenAI-Compatible Images Skill

This is the Standalone distribution. Read configuration only from `auth.json` beside this installed skill; do not discover, merge, or fall back to the Codex Plugin configuration under `~/.codex/openai-compatible-imagegen/`. When the Codex Plugin distribution is active, follow its bundled `skills/openai-compatible-imagegen/SKILL.md` instead of this CLI workflow.

Use the bundled script for API calls. Resolve `$SkillDir` from the physical directory containing this `SKILL.md`; never substitute another same-named installation. Run `$SkillDir/scripts/imagegen.py info` before an API request and require both `script_path` and `auth_json` to remain under `$SkillDir`. Stop and report the path mismatch instead of using a different copy. When validating this skill through another agent, require it to report the absolute `imagegen.py` path actually executed.

Do not rewrite the API client inline. The script is the authority for request validity: do not reject, rewrite, or ask the user to change a model, size, or transparency request based on remembered provider limitations. Run the command and report its actual result. Only a validation error emitted by the script or an API response can establish that the request failed.

## Workflow

1. Run `info` to inspect the local configuration. If `auth.json` is missing, run `scripts/quick-init.py`.
2. Choose one mode:
   - `generate`: text-to-image.
   - `edit`: image editing, inpainting, or reference-image work.
   - `batch`: JSONL generation with limited concurrency.
   - `apply-transparency`: run one declared local transparency route on an existing PNG.
   - `info`: redacted configuration summary.
3. Before constructing the command, interpret the request and decide the purpose, subject, composition, visual style, target size, aspect ratio, quality, format, background, transparency, reference files, and output location. Preserve explicit per-row and shared values; use agent judgment only for omitted intent, and leave a parameter unset when `auth.json` should decide it.
4. After command construction, runtime parameter priority is `per-row batch fields > shared command flags > auth.json defaults > built-in defaults`. An agent-inferred value emitted as a shared flag follows this runtime rule and overrides `auth.json`.
5. Call `scripts/imagegen.py` and report the output paths and any manifest.

Do not replace an execution with a handwritten error record. In particular, `gpt-image-2` requests at 2K or 4K with `--transparent` must reach the script unchanged. Do not claim they require 1K, `gpt-image-1.5`, or an opaque background, and do not offer those changes before the script or API returns an error. `--transparent` is local delivery intent and is never sent as the removed API transparency parameter.

Publish every complete, decodable API image. Requested count, pixel size, or format deviations are factual warnings, never reasons to hide a valid original. `ok=true` means at least one API original was published; `delivery_ready` independently reports whether requested transparency, transforms, and QA passed. Treat `delivery_size` as a separate local transform and report both source and derived paths when it is used.

When the user describes an image, form a concise, structured prompt. Include the intended use, subject and relationships, composition, style or medium, audience or context, delivery constraints, text requirements, and concrete exclusions. For a batch, state which properties stay consistent and which properties vary. Do not add domain-specific assumptions that the user did not provide.

Treat game art as one peer industry use case alongside product, editorial, marketing, interface, diagram, and photographic work. Preserve game-specific details when the user supplies them, but do not make them the default for unrelated requests.

Never read, print, quote, or summarize secret values in `auth.json`.

The script accepts `data[].b64_json` and `data[].url` responses. Do not add `response_format` for GPT Image models. One request accepts `n=1..16`. JSON responses are limited to 96 MiB, each decoded or downloaded image to 64 MiB, the cumulative decoded response to 256 MiB, and response processing to 64 items. Decode, validate, and publish one item before reading the next. If a later item exceeds a cumulative limit, preserve already published originals and report the exact resource warning. PNG container structure, chunk ordering, CRCs, dimensions, compressed-stream completeness, and a 4096-`IDAT`-chunk limit are checked before publication. Full scanline and filter validation has a 96 MiB work budget; a low-memory exact-length check covers inputs up to a 512 MiB decompressed-scanline ceiling. An image above that ceiling is rejected with an explicit resource-limit error, not reported as a content or reference failure. Standard PNG color types, bit depths, and Adam7 interlacing are accepted for original publication when they fit these limits, even when the local post-processing codec cannot transform them. JPEG receives bounded framing checks. WebP receives RIFF and chunk-bound checks; VP8 also checks the keyframe header, dimensions, and first-partition bound, while VP8L receives full bounded entropy-stream validation. No image validation path loads a model. An unusable item or target collision is reported without suppressing other valid items from the same response; fail only when no publishable PNG, JPEG, or WebP can be returned. URL responses use the configured `user_agent` without API credentials.

If a returned image URL fails with a TLS EOF while direct download is disabled, explain the two explicit authorization choices: `--allow-direct-url-download` for one command or `auth.json url_download.proxy_mode="direct"` persistently. Do not enable either choice without user approval.

When `auth.json proxy.url` is configured, generation, edit, and returned image URL requests use that HTTP proxy. Do not expose the URL or change it automatically. A proxy failure stops the operation; never retry through the environment proxy or a direct connection. `url_download.proxy_mode="direct"` overrides the proxy only for returned image downloads.

## Local Auth

`auth.json` is local-only and must not be committed.

Initialize it after installation:

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/quick-init.py"
```

For scripted setup with environment-variable authentication:

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/quick-init.py" `
  --non-interactive `
  --base-url "https://example.com/v1" `
  --model "gpt-image-2" `
  --auth-method env `
  --api-key-env "OPENAI_API_KEY" `
  --postprocess
```

The `imagegen.py init` command remains available for copying the template.

API key options:

- Put the key directly in `auth.json` as `api_key`.
- Put an environment variable name in `api_key_env`, then set that variable.

If both are present, the script uses `api_key` unless it is a template placeholder.

Important configuration fields:

- `base_url`: OpenAI-compatible API base URL, usually ending in `/v1`.
- `api_key` or `api_key_env`: local authentication.
- `model`: default image model.
- `proxy.url`: optional complete `http://` or `https://` proxy URL for this provider. Credentials, paths, queries, fragments, and SOCKS URLs are not accepted.
- `url_download.proxy_mode`: `environment` or explicitly authorized `direct`.
- `defaults`: values used when a request omits a parameter.
- `postprocess.enabled`: default permission for local transparency processing; when false, transparent requests still reach the API and the returned originals are inspected without local pixel changes.
- `transparency.default_route`: default local route: `chroma-matting`, `emissive-alpha`, or `mask-alpha`.
- `transparency.prompt_only_allow`: exact model/mode/size combinations verified for prompt-only alpha generation, primarily used when local processing is not preferred.
- `transparency.llm_assisted`: bounded agent-guided route selection and parameter tuning after an unmet result.

The old `capabilities.transparent_background` setting is removed. If it remains in `auth.json`, report the migration error and ask for that field to be removed; do not send the old API background parameter.

## Transparency Workflow

Treat `--transparent` as a delivery intent, not as an API `background` parameter. Never send `background=transparent` to the image API.

Map an explicit user preference to an explicit per-run switch: use `--postprocess` when the user allows or requests local processing. `--no-postprocess` disables local transparency pixel changes. With an exact prompt-only rule it selects `prompt-alpha`; without one it keeps the user's prompt unchanged, still calls the API, and only inspects whether each returned original already has usable alpha. Explicit delivery transforms may still run after transparency passes. Omitting both switches inherits `postprocess.enabled`.

Choose the request route before sending the request:

1. Honor an explicit `--transparency-route` or batch `transparency_route`; an explicit local route conflicts with `--no-postprocess`.
2. Otherwise use `transparency.default_route` when local post-processing is allowed.
3. When local processing is disabled, use `prompt-alpha` only if `transparency.prompt_only_allow` exactly matches the model, mode, and pixel size.
4. For every other size, including 2K and 4K, continue the API request with the user's requested model, size, and prompt unchanged, preserve every returned original, and inspect source alpha without local pixel changes. Never turn model/size folklore into a local refusal.
5. Report only incomplete or contradictory local route contracts before the request, such as `mask-alpha` without a mask or a local route combined with `--no-postprocess`. An explicit `prompt-alpha` without an exact allow rule becomes source-alpha inspection: keep the prompt unchanged, call the API, and report the returned original. Do not silently change the model, endpoint, size, or retry policy.

Choose among all declared deterministic routes rather than treating chroma keying as the universal method. Use `chroma-matting` for isolated subjects rendered against a known solid key color. Its default edge-connected color range protects matching subject colors; select `background_scope=global` only when the declared key background must also be removed from enclosed holes such as rings, handles, counters, and lettering. Use `emissive-alpha` for particles, fire, lightning, smoke, and glow rendered against pure black; it converts luminance to continuous alpha and preserves disconnected falloff. Use `mask-alpha` when an explicit alpha, luminance, red, green, or blue mask channel exists, including masks prepared with traditional channel-selection or layer-mask workflows. A mask path and any black/white source matte color are input facts, not values the deterministic processor guesses. Hair, fur, glass, translucent fabric, reflected light, and mixed smoke/background imagery without a trusted mask or controlled plate are outside reliable deterministic extraction; preserve the original and report `unmet` instead of guessing.

Build the base prompt from the user's subject, composition, style, and semantic color requirements only. Treat transparency as a delivery flag, not prompt text. Do not manually add a transparent-background instruction, real-alpha contract, `alpha 0`, checkerboard background, key-color background, pure-black emissive contract, or mask contract before invoking the command. `resolve_plan` selects and appends the verified route contract exactly once. When an explicit `prompt-alpha` has no exact allow rule, the resolved `inspect-alpha` plan must send the semantic base prompt unchanged. Preserve colors the user explicitly requires on the subject; do not reinterpret them as a background instruction.

Keep `transparency.prompt_only_allow` empty unless the configured backend has been verified for that exact model, mode, and pixel size. A `1K` rule is an exact pixel-size rule such as `1024x1024`; do not downgrade a 2K or 4K request to make it match. A 2K or 4K request always proceeds: it uses the selected local route when processing is allowed, otherwise it returns and inspects the API original unchanged.

The prompt-only route is a request to the model, not a guarantee. After an API response is written:

- If native alpha or local processing passes, report `transparency.status=pass` and `delivery_ready=true`.
- If it does not pass, keep `ok=true`, set `delivery_ready=false`, return the API image unchanged, and add a warning explaining the unmet transparency condition.
- If a delivery resize or grid transform depends on transparency and transparency is unmet, skip that transform for that image and return the API image unchanged.

For multiple returned images, evaluate and publish each API original independently. A malformed item, target collision, transform failure, or failed transparency check must not discard other valid originals or successful derivatives. Fail the image request only when no complete API image can be published.

### LLM-assisted adjustment

Read the effective policy from `info`.

When `llm_assisted.enabled=true` and the first result is `unmet`:

1. Inspect the original API image, route checks, warnings, and previews. Count the first local processing run as attempt 1.
2. Re-run the original image with `apply-transparency` only while the total attempt count remains within `max_attempts`.
3. Tune only documented route parameters when `allow_parameter_tuning=true`. Treat them as processing controls, not QA controls: every attempt must pass the unchanged deterministic quality gate and multi-background preview review. Never lower a tolerance merely to make a failed result report `pass`.
4. Change routes only when `allow_route_change=true` and the candidate route's input contract is satisfied. Never invent a mask.
5. Send another image API request only when `allow_api_retry=true`; keep the configured model, endpoint, and requested size.
6. Never generate or execute image-processing code, install a runtime, download weights, or start a local model.

If every permitted attempt remains unmet, return the original API image and its factual warnings. The skill informs the user; it does not hard-block or hide the image.

Each local route records an 8-bit `alpha_pipeline`: background or mask profiling, matte method, refinement, optional Remove Matte/Defringe cleanup, and the black/white/gray/checker preview contract. Do not apply hard component cleanup to emissive effects; disconnected particles and soft falloff are intentional. For explicit masks, use `threshold`, `expand`, `feather`, `gamma`, and `min_component_area` only when the requested matte needs those operations. Use `matte=black|white` only when that source matte color is known; this cleanup changes partial-alpha edge colors and preserves pixels that the trusted mask marks fully opaque.

An HTTP error happens before an image exists and is separate from transparency QA. A 4xx response is recorded as `error_kind=api_rejected` with its `status_code`; it is not reported as `transparency.status=unmet`. For edit requests, technical reference metadata may be attached with `status=not_evaluated`; reference semantics are not automatically judged or used to block the API request.

## Commands

All commands can run from any working directory.

Configuration summary:

```powershell
python "$SkillDir/scripts/imagegen.py" info
```

Text-to-image:

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Editorial still life of a ceramic tea set on a light wood table, soft window light, space for a headline on the left, no text" `
  -f "outputs/tea-set.png" `
  --aspect 4:3 `
  --resolution 1K `
  --quality high
```

Reference-image edit:

```powershell
python "$SkillDir/scripts/imagegen.py" edit `
  -p "Keep the subject and camera angle, replace the background with a neutral studio wall, preserve realistic shadows" `
  -i "input.png" `
  -f "outputs/studio-edit.png"
```

Batch generation:

```powershell
python "$SkillDir/scripts/imagegen.py" batch `
  --input "prompts.jsonl" `
  --out "outputs/imagegen" `
  --concurrency 3
```

Transparent single-subject output:

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "A clean isolated ceramic vase, front three-quarter view, no lettering" `
  -f "outputs/vase.png" `
  --asset `
  --transparent
```

Apply a declared local route to an existing image:

```powershell
python "$SkillDir/scripts/imagegen.py" apply-transparency "source.png" `
  --out "outputs/source-transparent.png" `
  --route emissive-alpha `
  --transparency-param "black_point=8" `
  --transparency-param "gamma=1.2"
```

The command exits after writing its JSON result. `status=unmet` returns the source image path, does not create an `--out` duplicate, and still exits successfully; use `delivery_ready` to distinguish a valid transparent delivery from a preserved original.

Inspect and validate a delivered file:

```powershell
python "$SkillDir/scripts/imagegen.py" inspect-image "outputs/tea-set.png" `
  --components `
  --expected-size 1536x1152
```

Create delivery-size previews:

```powershell
python "$SkillDir/scripts/imagegen.py" preview-board "outputs/vase.png" `
  --size 64x64 `
  --size 256x256 `
  --preview-background transparent `
  --preview-background white `
  --out-dir "outputs/vase-previews"
```

## Parameters

Core parameters:

- `-p, --prompt`: required for `generate` and `edit`.
- `-f, --file`: output file.
- `-i, --image`: reference image; repeat for multiple files.
- `-m, --mask`: edit mask.
- `--size`: exact pixel size.
- `--aspect`: `1:1`, `16:9`, `4:3`, `3:4`, or `9:16`.
- `--resolution`: `1K`, `2K`, or `4K` when using `--aspect`.
- `--quality`: `low`, `medium`, `high`, or `auto`.
- `--n`: number of images returned by one request, from 1 to 16.
- `--format`: `png`, `jpeg`, or `webp`.
- `--background`: `auto` or `opaque`; `transparent` was removed.
- `--transparent`: explicit transparent delivery intent; forces PNG but is not sent as an API background parameter.
- `--asset`: explicit single visual-deliverable intent; prefers PNG and does not imply a particular industry.
- `--concurrency`: limited batch concurrency.
- `--allow-direct-url-download`: explicit one-command authorization for direct returned-URL downloads.

Post-processing parameters:

- `--qa`: attach deterministic delivery QA to a generation, edit, or batch result.
- `--components`: include connected-component diagnostics.
- `--delivery-size`: final output size, such as `128x128` or `1600x900`.
- `--grid`: split a known sheet such as `3x3`.
- `--expected-count`: require a per-source grid count, or a delivery count when no grid is used.
- `--resample`: `bilinear` (default) or `nearest`.
- `--fit`: `stretch` (compatibility default) or `contain`.
- `--safe-margin`: fractional edge margin used with `--fit contain`, for example `0.03`.
- `--postprocess-out-dir`: directory for derived files.
- `--postprocess` / `--no-postprocess`: allow or disable local transparency pixel processing for this run; disabled requests still call the API, preserve originals, and inspect source alpha.
- `--transparency-route`: `chroma-matting`, `emissive-alpha`, `mask-alpha`, or `prompt-alpha`; an unverified `prompt-alpha` preserves the prompt and becomes source-alpha inspection.
- `--transparency-mask`: explicit mask input required by `mask-alpha`.
- `--transparency-param NAME=VALUE`: repeatable, route-specific parameter override.

An explicit output filename extension must match the resolved format. Transparent and `--asset` requests resolve to PNG, including during batch preflight.

Read `references/prompting.md` when constructing a prompt or controlled batch. Read `references/parameters.md` for parameter resolution, `references/postprocess.md` for delivery transforms and preview boards, and `references/qa.md` for deterministic QA.

## Batch Format

`batch` input is JSONL, one task per line. See `examples/batch.example.jsonl`.

Common fields include `id`, `mode`, `prompt`, `file`, `size`, `aspect`, `resolution`, `quality`, `n`, `format`, `background`, `transparent`, `asset`, `images`, `mask`, `model`, `timeout`, `postprocess`, `transparency_route`, `transparency_mask`, `transparency_options`, `qa`, `components`, `delivery_size`, `grid`, `expected_count`, `resample`, `fit`, and `safe_margin`.

Batch path contract:

- `--input` is resolved from the caller's working directory, then JSONL input fields `images`, `mask`, and `transparency_mask` are resolved relative to the JSONL file directory.
- Task and shared output fields `file`, `out`, and `postprocess_out_dir` are resolved relative to `--out`; absolute paths remain absolute.
- The same normalized paths are used for preflight and worker execution. `manifest.json` records `output_root` and `path_contract`, including any missing published files.

Concurrency priority is:

```text
command --concurrency > auth.json defaults.concurrency > 3
```

Do not switch models or endpoints or infer semantic quality from deterministic metrics. Do not retry an API request unless `llm_assisted.enabled` and `allow_api_retry` are both true. Local transparency processing is used only when the selected route explicitly allows it.

Run every bundled Python command in the foreground and wait for its exit. Do not launch it with `Start-Process`, `Popen`, a daemon, a scheduled task, or a detached shell. If the launcher is interrupted or times out, close the launched process before continuing. The bundled scripts do not spawn child processes, start local model servers, or keep background workers after completion; batch threads are bounded and joined before exit.

Non-transparent post-processing and QA remain opt-in. A transparent request always records the intent and performs the declared post-response transparency check so that a large request is not rejected before generation.

## Transparency and QA Boundaries

Use `--transparent` only when the user explicitly requests a transparent result. It forces PNG and selects the explicit route, an exact prompt-only rule when applicable, or `transparency.default_route`; it never becomes an API `background` parameter. A missing exact prompt-only rule for 2K/4K is not a reason to block the API request.

`inspect-image` reports technical facts such as dimensions, alpha coverage, margins, edge contact, and optional connected components. `--expect-transparent` checks for a real alpha channel and visible content. Transparency processing validates the returned image before publishing a derived file. If validation fails, the API file remains the result and the record carries `status=unmet` plus warnings. It does not prove semantic isolation.

`preview-board` writes target-size variants on transparent, white, black, gray, or checker backgrounds. Per-preview, cumulative-preview, and board pixel limits are checked before allocation. This is a visual inspection aid, not an automatic readability or aesthetic verdict.

QA results use `qa.v1` and status values `pass`, `fail`, `partial`, or `not_evaluated`. Unsupported formats and semantic conditions are reported explicitly. Existing generation success fields and exit codes remain independent from optional QA.

Original-response publication validates standard PNG structure, chunk ordering, CRCs, dimensions, encoding fields, compressed-stream completeness, and a maximum of 4096 `IDAT` chunks independently from the post-processing codec. Full scanline, filter, and Adam7 pass validation runs when expected decompressed scanlines fit the 96 MiB work budget. From 96 MiB through 512 MiB, a bounded streaming pass validates zlib completion and exact decompressed length without retaining scanlines; a complete source is published unchanged with `api_response_validation_budget_exceeded`. Above 512 MiB, publication stops with `api_response_item_resource_limited`. Corrupt, incomplete, or excessively fragmented IDAT data is rejected at every size. Current post-processing and deep QA support non-interlaced 8-bit or 16-bit RGB/RGBA PNG files up to 25 million pixels and a 256 MiB PNG file limit. The local codec deterministically reduces 16-bit channel samples to 8-bit RGBA for processing and enforces the same IDAT chunk limit. A source outside that local transform subset is still published unchanged when it passes original-response limits; an unavailable transform or deep inspection affects `delivery_ready` and warnings, not `ok` or source visibility. JPEG and WebP originals remain supported, including full bounded VP8L entropy-stream validation, but their deep local QA is reported as unsupported rather than guessed.

## Output

The script saves images and writes `manifest.json` in batch mode. `original_files` always identifies published API images. When a derived result succeeds, `files` contains each API original followed by its derived result and `derived_files` contains only derivatives. API originals publish per item, so a malformed item or target collision does not hide successful peers. Per-image transparency, transform, or QA failure keeps successful peer derivatives and returns the failed image's original; global derivative count and QA conditions still roll back staged derivatives. Either case records `delivery_ready=false` and factual warnings without changing `ok=true` after an original is published. `api_delivery` records requested and actual published count, format, size, and paths. The batch manifest recursively verifies declared file paths. A request rejected by the API, or a response with no complete image that can be published, has no deliverable original and is reported as failure.

Report output paths, manifest paths, success and failure counts, and short failure summaries. Do not show API keys, full request headers, or secret configuration values.
