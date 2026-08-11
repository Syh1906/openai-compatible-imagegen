---
name: openai-compatible-imagegen
description: Generate, edit, and batch-process images through the bundled OpenAI-compatible image API script. Use for photos, illustrations, product visuals, posters, covers, diagrams, UI references, game art, transparent subjects, reference-image edits, inpainting, multi-reference compositions, and image batches when this local OpenAI-compatible workflow is the requested backend. Do not force this workflow when the user explicitly selects another image tool or backend.
---

# OpenAI-Compatible Image Generation

Use the bundled script for API calls. Do not rewrite the API client inline.

## Workflow

1. Run `info` to inspect the local configuration. If `auth.json` is missing, run `scripts/quick-init.py`.
2. Choose one mode:
   - `generate`: text-to-image.
   - `edit`: image editing, inpainting, or reference-image work.
   - `batch`: JSONL generation with limited concurrency.
   - `info`: redacted configuration summary.
3. Before constructing the command, interpret the request and decide the purpose, subject, composition, visual style, target size, aspect ratio, quality, format, background, transparency, reference files, and output location. Preserve explicit per-row and shared values; use agent judgment only for omitted intent, and leave a parameter unset when `auth.json` should decide it.
4. After command construction, runtime parameter priority is `per-row batch fields > shared command flags > auth.json defaults > built-in defaults`. An agent-inferred value emitted as a shared flag follows this runtime rule and overrides `auth.json`.
5. Call `scripts/imagegen.py` and report the output paths and any manifest.

The script validates every returned image against the resolved API pixel `size` before writing it. A backend size mismatch fails without publishing the mismatched file. Treat `delivery_size` as a separate local transform and report both source and derived paths when it is used.

When the user describes an image, form a concise, structured prompt. Include the intended use, subject and relationships, composition, style or medium, audience or context, delivery constraints, text requirements, and concrete exclusions. For a batch, state which properties stay consistent and which properties vary. Do not add domain-specific assumptions that the user did not provide.

Treat game art as one peer industry use case alongside product, editorial, marketing, interface, diagram, and photographic work. Preserve game-specific details when the user supplies them, but do not make them the default for unrelated requests.

Never read, print, quote, or summarize secret values in `auth.json`.

The script accepts `data[].b64_json` and `data[].url` responses. Do not add `response_format` for GPT Image models. JSON responses are limited to 96 MiB and each decoded or downloaded image to 64 MiB. Returned PNG files are fully parsed before writing and must be non-interlaced 8-bit RGB/RGBA with no more than 25 million pixels; RGB `tRNS` and other PNG encodings are rejected. JPEG and WebP responses receive bounded container and codec-framing checks before delivery. URL responses use the configured `user_agent` without API credentials.

If a returned image URL fails with a TLS EOF while direct download is disabled, explain the two explicit authorization choices: `--allow-direct-url-download` for one command or `auth.json url_download.proxy_mode="direct"` persistently. Do not enable either choice without user approval.

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
- `url_download.proxy_mode`: `environment` or explicitly authorized `direct`.
- `defaults`: values used when a request omits a parameter.
- `postprocess.enabled`: whether generated-output post-processing may run when requested.
- `transparency.prompt_only_allow`: exact model/mode/size combinations allowed to use prompt-only alpha generation when local post-processing is disabled.

The old `capabilities.transparent_background` setting is removed. If it remains in `auth.json`, report the migration error and ask for that field to be removed; do not send the old API background parameter.

## Transparency Workflow

Treat `--transparent` as a delivery intent, not as an API `background` parameter. Never send `background=transparent` to the image API. The script selects the first available declared route:

Map an explicit user preference to an explicit per-run switch: use `--postprocess` when the user allows or requests local transparency processing, and use `--no-postprocess` when the user prohibits it. Omitting both switches inherits `postprocess.enabled`; omission must never represent an explicit prohibition.

1. When local post-processing is allowed, append a chroma-key prompt contract, request an ordinary PNG, and remove only edge-connected key-color pixels locally.
2. When local post-processing is disabled, use prompt-only alpha generation only if `transparency.prompt_only_allow` exactly matches the model, mode, and pixel size.
3. When neither route is declared, report that no image request was sent. Do not silently change the model, endpoint, size, prompt, or retry policy.

Keep `transparency.prompt_only_allow` empty unless the configured backend has been verified for that exact model, mode, and pixel size. A `1K` rule is an exact pixel-size rule such as `1024x1024`; do not downgrade a 2K or 4K request to make it match.

The prompt-only route is a request to the model, not a guarantee. After an API response is written:

- If alpha or chroma-key processing passes, report `transparency.status=pass`.
- If it does not pass, keep `ok=true`, return the API image unchanged, and add a warning explaining the unmet transparency condition.
- If a delivery resize or grid transform depends on transparency and transparency is unmet, skip that transform for that image and return the API image unchanged.

For multiple returned images, evaluate each image independently. A failed transparency check must not discard successful images or turn a successful API response into a command failure.

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
- `--n`: number of images returned by one request.
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
- `--postprocess` / `--no-postprocess`: allow or prohibit the local post-processing transparency route for this run.

An explicit output filename extension must match the resolved format. Transparent and `--asset` requests resolve to PNG, including during batch preflight.

Read `references/prompting.md` when constructing a prompt or controlled batch. Read `references/parameters.md` for parameter resolution, `references/postprocess.md` for delivery transforms and preview boards, and `references/qa.md` for deterministic QA.

## Batch Format

`batch` input is JSONL, one task per line. See `examples/batch.example.jsonl`.

Common fields include `id`, `mode`, `prompt`, `file`, `size`, `aspect`, `resolution`, `quality`, `n`, `format`, `background`, `transparent`, `asset`, `images`, `mask`, `model`, `timeout`, `postprocess`, `qa`, `components`, `delivery_size`, `grid`, `expected_count`, `resample`, `fit`, and `safe_margin`.

Batch path contract:

- `--input` is resolved from the caller's working directory, then JSONL input fields `images` and `mask` are resolved relative to the JSONL file directory.
- Task and shared output fields `file`, `out`, and `postprocess_out_dir` are resolved relative to `--out`; absolute paths remain absolute.
- The same normalized paths are used for preflight and worker execution. `manifest.json` records `output_root` and `path_contract`, including any missing published files.

Concurrency priority is:

```text
command --concurrency > auth.json defaults.concurrency > 3
```

Do not switch models or endpoints, retry with changed parameters, or infer semantic quality from deterministic metrics. Local transparency processing is used only when the selected route explicitly allows it.

Post-processing and QA are opt-in. Without the relevant flags, generation and editing only save the API results and preserve their existing output contract.

## Transparency and QA Boundaries

Use `--transparent` only when the user explicitly requests a transparent result. It forces PNG and selects a local chroma-key route when post-processing is allowed; it never becomes an API `background` parameter. With post-processing disabled, only an exact `transparency.prompt_only_allow` rule can authorize prompt-only alpha generation.

`inspect-image` reports technical facts such as dimensions, alpha coverage, margins, edge contact, and optional connected components. `--expect-transparent` checks for a real alpha channel and visible content. Transparency processing validates the returned image before publishing a derived file. If validation fails, the API file remains the result and the record carries `status=unmet` plus warnings. It does not prove semantic isolation.

`preview-board` writes target-size variants on transparent, white, black, gray, or checker backgrounds. Per-preview, cumulative-preview, and board pixel limits are checked before allocation. This is a visual inspection aid, not an automatic readability or aesthetic verdict.

QA results use `qa.v1` and status values `pass`, `fail`, `partial`, or `not_evaluated`. Unsupported formats and semantic conditions are reported explicitly. Existing generation success fields and exit codes remain independent from optional QA.

Returned-PNG validation, current post-processing, and deep QA parse non-interlaced 8-bit RGB/RGBA PNG files up to 25 million pixels and a 256 MiB PNG file limit. RGB PNG files that use a `tRNS` transparency chunk and other PNG encodings are rejected instead of being guessed. JPEG and WebP generation remains supported, but their deep local inspection is reported as unsupported rather than guessed.

## Output

The script saves images and writes `manifest.json` in batch mode. When a derived file is published, the record keeps `original_files`, derived `files`, and transform details. A transparency record includes its route, status, checks, and warnings. When `--qa` is requested, it adds a `qa` object with inspections, checks, conditions, warnings, and errors. API success remains `ok=true` when transparency is unmet; report that state instead of refusing the image. A request rejected by the API has no deliverable image and is reported separately with its HTTP classification.

Report output paths, manifest paths, success and failure counts, and short failure summaries. Do not show API keys, full request headers, or secret configuration values.
