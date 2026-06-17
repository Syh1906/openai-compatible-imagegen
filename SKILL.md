---
name: openai-compatible-imagegen
description: Generate, edit, and batch-generate images through a local OpenAI-compatible image API script. Use when an agent needs to create images, icons, transparent-background assets, sprites, UI mockups, posters, covers, reference-image edits, inpainting, multi-reference image composition, concurrent batch image generation, or initialize a local auth.json for an OpenAI-compatible image API.
---

# OpenAI-Compatible Image Generation

Use this skill to call the bundled image generation script. Do not rewrite the API client inline.

## Workflow

1. Run `info` first to inspect the local configuration. If `auth.json` is missing, run `init`.
2. Choose the mode:
   - `generate`: text-to-image
   - `edit`: image editing, inpainting, or reference-image generation
   - `batch`: JSONL batch generation with limited concurrency
   - `info`: configuration summary
3. Resolve parameters in this order:
   - explicit user request
   - per-row batch parameters
   - agent judgment from the prompt
   - `auth.json` defaults
4. Choose quality deliberately:
   - use `low` or `medium` for drafts and broad exploration
   - use `high` for final assets, UI, posters, covers, dense text, or user requests for finished detail
   - use `auto` only when leaving the decision to the backend is acceptable
5. Before execution, decide output path, image count, size, quality, transparency intent, and reference images.
6. Call `scripts/imagegen.py`.
7. Report output image paths, manifest path, success count, failure count, and short failure summaries.

Never read, print, quote, or summarize the secret value in `auth.json`.

## Local Auth

The private config file is always `auth.json` in this skill directory. It is local-only and must not be committed.

Initialize it:

```powershell
$SkillDir = "$env:USERPROFILE/.agents/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" init
```

Initialize non-secret fields:

```powershell
$SkillDir = "$env:USERPROFILE/.agents/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" init `
  --base-url "https://example.com/v1" `
  --model "gpt-image-2" `
  --api-key-env "OPENAI_API_KEY"
```

API key options:

- Put the key directly in `auth.json` as `api_key`.
- Put an environment variable name in `api_key_env`, then set that environment variable.

If both are present, the script uses `api_key`. If `api_key` is still the template placeholder, the script reads `api_key_env`.

Config fields:

- `base_url`: OpenAI-compatible API base URL, usually ending in `/v1`.
- `api_key`: API key stored directly in local `auth.json`.
- `api_key_env`: optional environment variable name for the API key.
- `model`: default image model, for example `gpt-image-2`.
- `capabilities.transparent_background`: whether the backend supports `background=transparent`.
- `defaults`: weak defaults used only when parameters are missing.

## Commands

All commands can be run from any working directory.

Configuration summary:

```powershell
$SkillDir = "$env:USERPROFILE/.agents/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" info
```

Text-to-image:

```powershell
$SkillDir = "$env:USERPROFILE/.agents/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Warcraft 3 style frost skill icon, single rune, centered, no text" `
  -f "outputs/frost-rune.png" `
  --size 1024x1024 `
  --quality high
```

Reference-image edit:

```powershell
$SkillDir = "$env:USERPROFILE/.agents/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" edit `
  -p "Convert this to a dark magic UI style" `
  -i "input.png" `
  -f "outputs/dark-ui.png"
```

Batch generation:

```powershell
$SkillDir = "$env:USERPROFILE/.agents/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" batch `
  --input "prompts.jsonl" `
  --out "outputs/imagegen" `
  --concurrency 3
```

Transparent-background asset intent:

```powershell
$SkillDir = "$env:USERPROFILE/.agents/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Centered fire orb game item asset, no text" `
  -f "outputs/fire-orb.png" `
  --asset `
  --transparent
```

## Parameters

Core parameters:

- `-p, --prompt`: required for `generate` and `edit`.
- `-f, --file`: output file. If omitted, the script writes to the current directory.
- `-i, --image`: reference image. Repeat for multiple images. Uses the edit endpoint.
- `-m, --mask`: mask image for edit mode.
- `--size`: examples include `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `3840x2160`.
- `--quality`: `low`, `medium`, `high`, or `auto`.
- `--n`: number of images returned by one request.
- `--format`: `png`, `jpeg`, or `webp`.
- `--background`: `auto`, `opaque`, or `transparent`. The script sends `transparent` only when the config declares backend support.
- `--transparent`: transparent-background asset intent shortcut. Forces PNG and injects transparent-background constraints into the prompt. If supported, also sends `background=transparent`.
- `--asset`: asset shortcut. Prefers PNG and is suitable for icons, game items, textures, and sprites.
- `--concurrency`: limited batch concurrency.

Read `references/parameters.md` for detailed behavior.

## Batch Format

`batch` input is JSONL, one task per line. See `examples/batch.example.jsonl`.

Common fields:

- `id`
- `mode`
- `prompt`
- `file`
- `size`
- `quality`
- `n`
- `format`
- `background`
- `transparent`
- `asset`
- `images`
- `mask`
- `model`
- `timeout`

Batch mode uses limited concurrency. Concurrency priority:

```text
command --concurrency > auth.json defaults.concurrency > 3
```

Do not add model switching, endpoint switching, background removal, retries with altered parameters, or any other fallback strategy unless the user explicitly asks for it.

## Transparent Assets

When the user asks for assets, icons, items, textures, sprites, transparent background, or transparent PNG, prefer `--asset`. Add `--transparent` when the user explicitly wants a transparent background.

Transparency has two layers:

- prompt layer: always available; asks the model for an isolated subject and alpha-friendly edges
- API parameter layer: only sent when `capabilities.transparent_background=true`

Do not promise a real alpha channel unless the backend actually returns one. Do not add local background-removal post-processing unless the user explicitly asks for that implementation.

## Output

The script saves images and writes `manifest.json` in batch mode.

Report only:

- output image paths
- manifest path
- success and failure counts
- short failure summaries

Do not show API keys, full request headers, or config content that contains secrets.
