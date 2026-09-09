---
name: openai-compatible-imagegen
description: Generate, edit, and batch-process images through the bundled script and configured API Key provider (OpenAI-compatible or Atlas Cloud). Use for photos, illustrations, product visuals, posters, covers, diagrams, UI references, game art, transparent subjects, reference-image edits, inpainting, multi-reference compositions, and image batches when this local OpenAI-compatible workflow is the requested backend. Do not force this workflow when the user explicitly selects another image tool or backend.
---

# OpenAI-Compatible Images Skill

This is the Standalone distribution. Read configuration only from `auth.json` beside this installed skill; do not discover, merge, or fall back to the Codex Plugin configuration under `~/.codex/openai-compatible-imagegen/`. When the Codex Plugin distribution is active, follow its bundled `skills/openai-compatible-imagegen/SKILL.md` instead of this CLI workflow. Standalone uses the configured API Key provider: `openai-compatible` by default, or the optional `atlas` protocol. ChatGPT subscription handoff is a Plugin-only capability. Atlas supports text-to-image generation with PNG or JPEG output; edits and native transparency are unsupported. Never switch protocols to work around a failure.

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

Do not replace an execution with a handwritten error record. In particular, `gpt-image-2` requests at 2K or 4K with `--transparent` must reach the script unchanged. Do not claim they require 1K, `gpt-image-1.5`, or an opaque background, and do not offer those changes before the script or API returns an error. `--transparent` is delivery intent; only the resolved `native-alpha` route sends the API transparency parameter.

Publish every complete, decodable API image. Requested count, pixel size, or format deviations are factual warnings, never reasons to hide a valid original. `ok=true` means at least one API original was published; `delivery_ready` independently reports whether requested transparency, transforms, and QA passed. Treat `delivery_size` as a separate local transform and report both source and derived paths when it is used.

When the user describes an image, form a concise, structured prompt. Include the intended use, subject and relationships, composition, style or medium, audience or context, delivery constraints, text requirements, and concrete exclusions. For a batch, state which properties stay consistent and which properties vary. Do not add domain-specific assumptions that the user did not provide.

Treat game art as one peer industry use case alongside product, editorial, marketing, interface, diagram, and photographic work. Preserve game-specific details when the user supplies them, but do not make them the default for unrelated requests.

Never read, print, quote, or summarize secret values in `auth.json`.

The script accepts Base64 and URL image responses and validates them before publication. Do not add `response_format` for GPT Image models. Preserve valid peers when another item is invalid or exceeds resource limits. Use the [parameter reference](references/parameters.md#delivery-transform-parameters) for count, format, and validation limits; do not infer semantic quality from these checks. Returned image URLs are downloaded without API credentials.

If a returned image URL fails with a TLS EOF while direct download is disabled, explain the two explicit authorization choices: `--allow-direct-url-download` for one command or `auth.json url_download.proxy_mode="direct"` persistently. Do not enable either choice without user approval.

When `auth.json proxy.url` is configured, generation, edit, and returned image URL requests use that HTTP proxy. Do not expose the URL or change it automatically. A proxy failure stops the operation; never retry through the environment proxy or a direct connection. `url_download.proxy_mode="direct"` overrides the proxy only for returned image downloads.

## Local Auth

`auth.json` is local-only and must not be committed.

Requires Python 3.12 or newer. Set `SkillDir` to the physical installed directory before using the examples. Windows uses `python`; macOS/Linux use `python3`.

Initialize it after installation:

Windows PowerShell:

```powershell
$SkillDir = "C:/path/to/openai-compatible-imagegen"
python "$SkillDir/scripts/quick-init.py"
```

macOS or Linux shell:

```bash
SkillDir="/absolute/path/to/openai-compatible-imagegen"
python3 "$SkillDir/scripts/quick-init.py"
```

For scripted setup with environment-variable authentication:

Windows PowerShell:

```powershell
$SkillDir = "C:/path/to/openai-compatible-imagegen"
python "$SkillDir/scripts/quick-init.py" `
  --non-interactive `
  --base-url "https://example.com/v1" `
  --model "gpt-image-2" `
  --auth-method env `
  --api-key-env "OPENAI_API_KEY" `
  --postprocess
```

macOS or Linux shell:

```bash
SkillDir="/absolute/path/to/openai-compatible-imagegen"
python3 "$SkillDir/scripts/quick-init.py" \
  --non-interactive \
  --base-url "https://example.com/v1" \
  --model "gpt-image-2" \
  --auth-method env \
  --api-key-env "OPENAI_API_KEY" \
  --postprocess
```

The `imagegen.py init` command remains available for copying the template.

API key options:

- Put the key directly in `auth.json` as `api_key`.
- Put an environment variable name in `api_key_env`, then set that variable.

If both are present, the script uses `api_key` unless it is a template placeholder.

Important configuration fields:

- `protocol`: `openai-compatible` (default) or `atlas`.
- `base_url`: provider base URL; OpenAI-compatible services usually use `/v1`, while Atlas uses its service root.
- `api_key` or `api_key_env`: local authentication.
- `model`: default image model.
- `proxy.url`: optional complete `http://` or `https://` proxy URL for this provider. Credentials, paths, queries, fragments, and SOCKS URLs are not accepted.
- `url_download.proxy_mode`: `environment` or explicitly authorized `direct`.
- `defaults`: values used when a request omits a parameter.
- `postprocess.enabled`: default permission for local transparency processing, including native fallback.
- `transparency.default_route`: `native-alpha`, `chroma-matting`, `emissive-alpha`, or `mask-alpha`.
- `transparency.native`: native transparency permission, optional model capability declaration, parameter retry policy, and local fallback route.
- `transparency.prompt_only_allow`: exact model/mode/size combinations verified for prompt-only alpha generation, primarily used when local processing is not preferred.
- `transparency.llm_assisted`: bounded agent-guided route selection and parameter tuning after an unmet result.

The old `capabilities.transparent_background` setting is removed. If it remains in `auth.json`, report the migration error and ask for that field to be removed. Native transparency uses the current `transparency.native` policy.

## Transparency Workflow

Treat `--transparent` as delivery intent. The CLI `--background` accepts only `auto` or `opaque`. When the resolved route is `native-alpha`, the runtime sends API `background=transparent`, PNG output, and a real-alpha prompt contract; local routes omit that parameter.

Map an explicit user preference to an explicit per-run switch: use `--postprocess` when the user allows or requests local processing. `--no-postprocess` disables local transparency pixel changes, including native fallback. For non-native routes, an exact prompt-only rule selects `prompt-alpha`; otherwise the runtime keeps the prompt unchanged and inspects returned alpha. The switch does not disable a selected native request. Explicit delivery transforms may still run after transparency passes. Omitting both switches inherits `postprocess.enabled`.

Choose the request route before sending the request:

1. Honor an explicit `--transparency-route` or batch `transparency_route`; an explicit local route conflicts with `--no-postprocess`.
2. Select a configured `native-alpha` default regardless of the local processing switch; it requires `transparency.native.enabled=true`. Otherwise use `transparency.default_route` when local post-processing is allowed.
3. When local processing is disabled, use `prompt-alpha` only if `transparency.prompt_only_allow` exactly matches the model, mode, and pixel size.
4. For every other size, including 2K and 4K, continue the API request with the user's requested model, size, and prompt unchanged, preserve every returned original, and inspect source alpha without local pixel changes. Never turn model/size folklore into a local refusal.
5. Report incomplete or contradictory contracts, such as disabled native transparency, `mask-alpha` without a mask, or a local route combined with `--no-postprocess`. An explicit `prompt-alpha` without an exact allow rule becomes source-alpha inspection: keep the prompt unchanged, call the API, and report the returned original. Do not silently change the model, endpoint, size, or retry policy.

Ordinary API requests omit `background` by default. Pass `auto` or `opaque` only when the user explicitly requests that API option. If an explicit background option is rejected, explain the failure and ask before submitting a new request without it; do not infer parameter rejection from a timeout or an ambiguous error. The configured, limited retry for native transparency remains unchanged.

Native transparency has a separate configured retry: a transparency-related HTTP 400/422 allows one same-request retry without the background parameter when `transparency.native.retry_without_parameter=true`. The model, provider, endpoint, prompt, size, and editing inputs remain the same. Set the switch to `false` to stop on rejection. A successful retry uses `transparency.native.fallback_route` only when local processing is allowed; otherwise it inspects the returned alpha without local pixel changes. A successful native request that returns an opaque image is preserved with unmet transparency in Standalone; the Plugin additionally selects its local fallback for that case when processing is allowed. See [the parameter reference](references/parameters.md#visual-deliverables-and-transparency) for policy fields.

Retry permission and local processing permission are independent. Keep the user's processing choice throughout retries. Preserve originals, include validated derivatives when local processing succeeds, and report the final route, API attempts, and delivery status.

Choose among all declared deterministic routes rather than treating chroma keying as the universal method. Use `chroma-matting` for isolated subjects rendered against a known solid key color. Its default edge-connected color range protects matching subject colors; select `background_scope=global` only when the declared key background must also be removed from enclosed holes such as rings, handles, counters, and lettering. Use `emissive-alpha` for particles, fire, lightning, smoke, and glow rendered against pure black; it converts luminance to continuous alpha and preserves disconnected falloff. Use `mask-alpha` when an explicit alpha, luminance, red, green, or blue mask channel exists, including masks prepared with traditional channel-selection or layer-mask workflows. A mask path and any black/white source matte color are input facts, not values the deterministic processor guesses. Hair, fur, glass, translucent fabric, reflected light, and mixed smoke/background imagery without a trusted mask or controlled plate are outside reliable deterministic extraction; preserve the original and report `unmet` instead of guessing.

Build the base prompt from the user's subject, composition, style, and semantic color requirements only. Treat transparency as a delivery flag, not prompt text. Do not manually add a transparent-background instruction, real-alpha contract, `alpha 0`, checkerboard background, key-color background, pure-black emissive contract, or mask contract before invoking the command. `resolve_plan` selects and appends the verified route contract exactly once. When an explicit `prompt-alpha` has no exact allow rule, the resolved `inspect-alpha` plan must send the semantic base prompt unchanged. Preserve colors the user explicitly requires on the subject; do not reinterpret them as a background instruction.

Keep `transparency.prompt_only_allow` empty unless the configured backend has been verified for that exact model, mode, and pixel size. A `1K` rule is an exact pixel-size rule such as `1024x1024`; do not downgrade a 2K or 4K request to make it match. Size alone does not block generation; follow the route-selection order above.

The prompt-only route is a request to the model, not a guarantee. After an API response is written:

- If native alpha or local processing passes, report `transparency.status=pass` and `delivery_ready=true`.
- If it does not pass, keep `ok=true`, set `delivery_ready=false`, return the API image unchanged, and add a warning explaining the unmet transparency condition.
- If a delivery resize or grid transform depends on transparency and transparency is unmet, skip that transform for that image and return the API image unchanged.

For multiple items in a completed API response, evaluate and publish each original independently. A malformed item, target collision, transform failure, or failed transparency check must not discard valid peers. Atlas multi-candidate requests collect one response per candidate before publication; if any candidate request fails, the group is not published. Do not split or repeat an unsuccessful group automatically.

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

Windows PowerShell:

```powershell
python "$SkillDir/scripts/imagegen.py" info
```

macOS or Linux shell:

```bash
python3 "$SkillDir/scripts/imagegen.py" info
```

Text-to-image:

Windows PowerShell:

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Editorial still life of a ceramic tea set on a light wood table, soft window light, space for a headline on the left, no text" `
  -f "outputs/tea-set.png" `
  --aspect 4:3 `
  --resolution 1K `
  --quality high
```

macOS or Linux shell:

```bash
python3 "$SkillDir/scripts/imagegen.py" generate \
  -p "Editorial still life of a ceramic tea set on a light wood table, soft window light, space for a headline on the left, no text" \
  -f "outputs/tea-set.png" \
  --aspect 4:3 \
  --resolution 1K \
  --quality high
```

Reference-image edit:

Windows PowerShell:

```powershell
python "$SkillDir/scripts/imagegen.py" edit `
  -p "Keep the subject and camera angle, replace the background with a neutral studio wall, preserve realistic shadows" `
  -i "input.png" `
  -f "outputs/studio-edit.png"
```

macOS or Linux shell:

```bash
python3 "$SkillDir/scripts/imagegen.py" edit \
  -p "Keep the subject and camera angle, replace the background with a neutral studio wall, preserve realistic shadows" \
  -i "input.png" \
  -f "outputs/studio-edit.png"
```

Batch generation:

Windows PowerShell:

```powershell
python "$SkillDir/scripts/imagegen.py" batch `
  --input "prompts.jsonl" `
  --out "outputs/imagegen" `
  --concurrency 3
```

macOS or Linux shell:

```bash
python3 "$SkillDir/scripts/imagegen.py" batch \
  --input "prompts.jsonl" \
  --out "outputs/imagegen" \
  --concurrency 3
```

Transparent single-subject output:

Windows PowerShell:

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "A clean isolated ceramic vase, front three-quarter view, no lettering" `
  -f "outputs/vase.png" `
  --asset `
  --transparent
```

macOS or Linux shell:

```bash
python3 "$SkillDir/scripts/imagegen.py" generate \
  -p "A clean isolated ceramic vase, front three-quarter view, no lettering" \
  -f "outputs/vase.png" \
  --asset \
  --transparent
```

Apply a declared local route to an existing image:

Windows PowerShell:

```powershell
python "$SkillDir/scripts/imagegen.py" apply-transparency "source.png" `
  --out "outputs/source-transparent.png" `
  --route emissive-alpha `
  --transparency-param "black_point=8" `
  --transparency-param "gamma=1.2"
```

macOS or Linux shell:

```bash
python3 "$SkillDir/scripts/imagegen.py" apply-transparency "source.png" \
  --out "outputs/source-transparent.png" \
  --route emissive-alpha \
  --transparency-param "black_point=8" \
  --transparency-param "gamma=1.2"
```

The command exits after writing its JSON result. `status=unmet` returns the source image path, does not create an `--out` duplicate, and still exits successfully; use `delivery_ready` to distinguish a valid transparent delivery from a preserved original.

Inspect and validate a delivered file:

Windows PowerShell:

```powershell
python "$SkillDir/scripts/imagegen.py" inspect-image "outputs/tea-set.png" `
  --components `
  --expected-size 1536x1152
```

macOS or Linux shell:

```bash
python3 "$SkillDir/scripts/imagegen.py" inspect-image "outputs/tea-set.png" \
  --components \
  --expected-size 1536x1152
```

Create delivery-size previews:

Windows PowerShell:

```powershell
python "$SkillDir/scripts/imagegen.py" preview-board "outputs/vase.png" `
  --size 64x64 `
  --size 256x256 `
  --preview-background transparent `
  --preview-background white `
  --out-dir "outputs/vase-previews"
```

macOS or Linux shell:

```bash
python3 "$SkillDir/scripts/imagegen.py" preview-board "outputs/vase.png" \
  --size 64x64 \
  --size 256x256 \
  --preview-background transparent \
  --preview-background white \
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
- `--quality`: `auto`, `low`, `medium`, `high`, `xhigh`, or `max`. The last two require model/provider support; Atlas retains `low`, `medium`, and `high`. Never downgrade quality automatically.
- `--n`: number of images returned by one request, from 1 to 16.
- `--format`: `png`, `jpeg`, or `webp`.
- `--background`: `auto` or `opaque`; `transparent` was removed.
- `--transparent`: transparent delivery intent; forces PNG and lets the resolved route decide whether to send the native API parameter.
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
- `--postprocess` / `--no-postprocess`: allow or disable local transparency pixel processing for this run, including fallback after a native-parameter retry.
- `--transparency-route`: `native-alpha`, `chroma-matting`, `emissive-alpha`, `mask-alpha`, or `prompt-alpha`; an unverified `prompt-alpha` preserves the prompt and becomes source-alpha inspection.
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

Do not switch models or endpoints or infer semantic quality from deterministic metrics. Apart from the configured native-parameter retry, an additional image request requires both `llm_assisted.enabled` and `allow_api_retry`. Atlas prediction GET polling does not resubmit generation. Local transparency processing is used only when the selected route explicitly allows it.

Run every bundled Python command in the foreground and wait for its exit. Do not launch it with `Start-Process`, `Popen`, a daemon, a scheduled task, or a detached shell. If the launcher is interrupted or times out, close the launched process before continuing. The bundled scripts do not spawn child processes, start local model servers, or keep background workers after completion; batch threads are bounded and joined before exit.

Non-transparent post-processing and QA remain opt-in. A transparent request always records the intent and performs the declared post-response transparency check so that a large request is not rejected before generation.

## Transparency and QA Boundaries

Use `--transparent` only when the user explicitly requests a transparent result. It forces PNG and selects the explicit route, an exact prompt-only rule when applicable, or `transparency.default_route`; only `native-alpha` sends API `background=transparent`. A missing exact prompt-only rule for 2K/4K is not a reason to block the API request.

`inspect-image` reports technical facts such as dimensions, alpha coverage, margins, edge contact, and optional connected components. `--expect-transparent` checks for a real alpha channel and visible content. Transparency processing validates the returned image before publishing a derived file. If validation fails, the API file remains the result and the record carries `status=unmet` plus warnings. It does not prove semantic isolation.

`preview-board` writes target-size variants on transparent, white, black, gray, or checker backgrounds. Per-preview, cumulative-preview, and board pixel limits are checked before allocation. This is a visual inspection aid, not an automatic readability or aesthetic verdict.

QA results use `qa.v1` and status values `pass`, `fail`, `partial`, or `not_evaluated`. Unsupported formats and semantic conditions are reported explicitly. Existing generation success fields and exit codes remain independent from optional QA.

Original publication and local processing have different format and resource limits. A valid API image can remain usable even when local resizing, transparency, or deep QA is unavailable. See [validation limits](references/parameters.md#delivery-transform-parameters) and [QA boundaries](references/qa.md#boundaries); report an unavailable transform without hiding its source.

## Output

The script saves images and writes `manifest.json` in batch mode. `original_files` always identifies published API images. When a derived result succeeds, `files` contains each API original followed by its derived result and `derived_files` contains only derivatives. API originals publish per item, so a malformed item or target collision does not hide successful peers. Per-image transparency, transform, or QA failure keeps successful peer derivatives and returns the failed image's original; global derivative count and QA conditions still roll back staged derivatives. Either case records `delivery_ready=false` and factual warnings without changing `ok=true` after an original is published. `api_delivery` records requested and actual published count, format, size, and paths. The batch manifest recursively verifies declared file paths. A request rejected by the API, or a response with no complete image that can be published, has no deliverable original and is reported as failure.

Report output paths, manifest paths, success and failure counts, and short failure summaries. Do not show API keys, full request headers, or secret configuration values.
