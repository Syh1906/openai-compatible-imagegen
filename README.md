<div align="center">

# OpenAI-Compatible Image Generation Skill

**Generate, edit, batch-create, inspect, and prepare images for delivery through an OpenAI-compatible image API.**

[![Release](https://img.shields.io/github/v/release/Syh1906/openai-compatible-imagegen?style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Syh1906/openai-compatible-imagegen/ci.yml?branch=main&style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/actions)
[![Skill](https://img.shields.io/badge/skill-SKILL.md-lightgrey?style=flat-square)](SKILL.md)

English | [简体中文](README.zh-CN.md)

</div>

---

## What It Does

This portable Agent Skill gives compatible agent clients one workflow for marketing visuals, product cutouts, editorial images, brand assets, interface graphics, game art, and other image deliverables.

| Need | Capability |
| --- | --- |
| Create or revise images | Text-to-image generation and reference-image editing |
| Produce controlled variations | JSONL batches with per-task options and limited concurrency |
| Deliver exact files | PNG resizing, contain/stretch fitting, safe margins, and grid splitting |
| Check technical requirements | Deterministic `qa.v1` checks for size, alpha, edge contact, and optional components |
| Review presentation contexts | Preview boards at multiple sizes and on multiple backgrounds |
| Keep credentials local | Ignored `auth.json` with direct key or environment-variable authentication |

The skill uses an OpenAI-compatible image backend. Local post-processing is deterministic and does not call the image API.

## Compatibility

The configured `base_url` must expose these endpoints:

| Mode | Endpoint | Request type |
| --- | --- | --- |
| `generate` | `POST /v1/images/generations` | JSON |
| `edit` | `POST /v1/images/edits` | `multipart/form-data` |

Image responses may contain `data[].b64_json` or `data[].url`. One request accepts `n=1..16`. JSON responses are limited to 96 MiB, each decoded or downloaded image to 64 MiB, the cumulative decoded response to 256 MiB, and processing to 64 response items. Items are decoded, validated, and published one at a time, so a later limit or collision preserves earlier originals. PNG checks accept at most 4096 `IDAT` chunks. Full scanline validation uses a 96 MiB work budget; low-memory exact-length validation covers up to 512 MiB of decompressed scanlines. Larger PNGs receive an explicit resource-limit error. WebP publication checks the RIFF container and declared chunk bounds; VP8 adds keyframe, dimension, and first-partition checks, while VP8L receives full bounded entropy-stream validation. PNG, JPEG, and WebP originals are also published when the backend returns a different count, pixel size, or format than requested; those deviations are recorded after publication. API keys are not forwarded to returned image URLs.

Supported request controls include exact pixel sizes, aspect and resolution presets, quality, output format, transparent delivery intent, moderation, and compression. Transparent delivery is handled after the API response by a declared local route or, for an exact verified combination, a prompt-only alpha request; it is not sent as an API background parameter.

## Installation

Download `openai-compatible-imagegen-<version>.zip` from [Releases](https://github.com/Syh1906/openai-compatible-imagegen/releases) and extract it into a skills directory supported by your agent client. You can also clone the repository into that directory.

| Client | User-level path | Project-level path |
| --- | --- | --- |
| Codex | `~/.codex/skills/openai-compatible-imagegen` | `.codex/skills/openai-compatible-imagegen` |
| Claude Code | `~/.claude/skills/openai-compatible-imagegen` | `.claude/skills/openai-compatible-imagegen` |
| OpenCode | `~/.config/opencode/skill/openai-compatible-imagegen` | `.opencode/skill/openai-compatible-imagegen` |

The installed directory must contain `SKILL.md` at its root.

## Configure the Backend

Run the setup wizard from the installed skill directory:

```powershell
$SkillDir = "/path/to/openai-compatible-imagegen"
python "$SkillDir/scripts/quick-init.py"
```

For manual setup, copy `examples/auth.example.json` to `auth.json` in the skill directory, then set the backend URL, model, and authentication source. `auth.json` is ignored by git.

```json
{
  "base_url": "https://example.com/v1",
  "api_key": "",
  "api_key_env": "OPENAI_API_KEY",
  "model": "gpt-image-2",
  "postprocess": {
    "enabled": false
  },
  "transparency": {
    "default_route": "chroma-matting",
    "prompt_only_allow": [],
    "llm_assisted": {
      "enabled": false,
      "max_attempts": 2,
      "allow_parameter_tuning": true,
      "allow_route_change": true,
      "allow_api_retry": false
    }
  }
}
```

Use `api_key` for a key stored in the local file, or `api_key_env` for the name of an environment variable. Run `info` to view a redacted configuration summary:

```powershell
$SkillDir = "/path/to/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" info
```

The old `capabilities.transparent_background` setting and `background=transparent` request value are removed. Do not translate them into an API parameter. `postprocess.enabled` controls whether a local transparency route may change pixels by default. When local processing is disabled, transparent requests still reach the API: an exact prompt-only rule may request alpha, otherwise the original prompt is preserved and returned images are inspected without local pixel changes. Add exact `model`/`mode`/`size` entries under `transparency.prompt_only_allow` only after verifying prompt-only alpha for that backend combination.

When a transparent result is requested and local processing is allowed, the selected route runs after the API image is written. The workflow is not limited to chroma keying: choose color-range matting for controlled solid plates, luminance-to-alpha for black-backed emissive effects, or an explicit alpha/luminance/RGB channel mask for channel-selection and layer-mask workflows. The shared 8-bit Alpha pipeline adds edge expansion or contraction, feathering, component cleanup, known black/white Remove Matte, Defringe, and multi-background checks where each route permits them. A trusted explicit mask protects fully opaque foreground colors while cleanup is limited to its partial-alpha edge. Hair, fur, glass, translucent fabric, and mixed smoke backgrounds need a controlled plate or trusted mask; otherwise the original is returned as unmet. `--no-postprocess` disables pixel changes but never blocks the API request or hides an original. Verified prompt-only rules remain probabilistic, and 2K/4K requests are never downgraded to match them.

If the result does not meet transparency checks, the API image is returned unchanged with `ok=true`, `transparency.status=unmet`, and `delivery_ready=false`. The skill reports that state instead of rejecting or hiding the image.

Optional `transparency.llm_assisted` lets the agent inspect an unmet result and make a bounded number of route or parameter adjustments. The configured attempt limit and quality checks still apply, and another API request occurs only when `allow_api_retry=true`.

## Ask Your Agent

Describe the subject, visual direction, final size, transparency, quantity, checks, and output directory in normal language.

- "Create a 16:9 product launch banner at 2K, then deliver a 1200x675 PNG in `outputs/campaign`."
- "Turn this product photo into a transparent 512x512 PNG cutout with a 3% safe margin. Confirm real alpha and preview it on white, black, and checker backgrounds."
- "Generate four editorial illustrations about public transit from these prompts and save a batch manifest."
- "Create a square brand mark, report connected components and edge contact, then preview it at 64x64 and 256x256."
- "Generate a 3x3 UI concept sheet and split it into nine 256x256 PNG files."
- "Create a fantasy strategy game frost ability icon, no text, and deliver 64x64 and 128x128 previews."

Generation size and delivery size are separate. A request can generate a larger source image and then produce an exact local deliverable. If the backend returns different source dimensions, the actual original is still published and the mismatch is recorded; an explicit `delivery_size` can then produce a separate derivative.

## Manual Commands

Manual commands are available for verification and scripted workflows. Set `$SkillDir` to the installed skill directory first.

### Generate and edit

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Editorial illustration about urban shade, clear focal subject, no text" `
  -f "outputs/urban-shade.png" `
  --aspect 4:3 `
  --resolution 2K `
  --quality high

python "$SkillDir/scripts/imagegen.py" edit `
  -p "Convert this product photo into a clean catalog cutout" `
  -i "input.png" `
  -f "outputs/product-cutout.png" `
  --asset `
  --transparent `
  --postprocess
```

### Run a batch

```powershell
python "$SkillDir/scripts/imagegen.py" batch `
  --input "examples/batch.example.jsonl" `
  --out "outputs/imagegen" `
  --concurrency 3
```

Batch rows can set `postprocess`, `transparency_route`, `transparency_mask`, `transparency_options`, `qa`, `components`, `delivery_size`, `grid`, `expected_count`, `resample`, `fit`, and `safe_margin`. The command writes `manifest.json`. `original_files` lists every published API source; `files` contains each source followed by any successful derivative, and `derived_files` lists only derived paths. A failed transform or transparency check keeps the source and records `delivery_ready=false`. `api_delivery` preserves requested-versus-actual count, format, size, paths, and warnings.

For batch paths, JSONL `images`, `mask`, and `transparency_mask` values are relative to the JSONL file directory. Task or shared `file`, `out`, and `postprocess_out_dir` values are relative to batch `--out`; absolute paths remain unchanged. The manifest records the resolved `output_root` and checks every declared file path. Output conflicts are rejected before generation. API originals publish per item. A failed transform returns that original while successful peer derivatives remain available; global file-count and QA requirements still apply to the complete derived set.

### Apply transparency locally

```powershell
python "$SkillDir/scripts/imagegen.py" apply-transparency "effect.png" `
  --out "outputs/effect-transparent.png" `
  --route emissive-alpha `
  --transparency-param "black_point=8" `
  --transparency-param "gamma=1.2"
```

When processing is unmet, the command returns the source image path with `delivery_ready=false`, does not create an `--out` duplicate, and exits successfully so the source image remains available with its warning.

### Inspect and validate

```powershell
python "$SkillDir/scripts/imagegen.py" inspect-image "input.png" `
  --components `
  --expected-size 512x512 `
  --expect-transparent
```

`--expected-size` checks exact dimensions. `--expect-transparent` requires visible content with real alpha. `--components` adds connected-component diagnostics for isolated subjects such as cutouts, marks, interface elements, and game assets.

QA is deterministic and technical. It does not judge aesthetics, identity, layout, or semantic fidelity. Deep inspection and local transforms support non-interlaced 8-bit or 16-bit RGB/RGBA PNG files, up to 25 million pixels, a 256 MiB PNG file limit, and 4096 `IDAT` chunks. The local codec reduces 16-bit channel samples to 8-bit RGBA for processing. RGB PNG files with a `tRNS` transparency chunk are rejected instead of being treated as opaque.

### Prepare delivery files

```powershell
python "$SkillDir/scripts/imagegen.py" normalize "input.png" `
  --delivery-size 512x512 `
  --fit contain `
  --safe-margin 0.03 `
  --resample bilinear `
  --out "outputs/final.png"

python "$SkillDir/scripts/imagegen.py" split-grid "sheet.png" `
  --grid 3x3 `
  --delivery-size 256x256 `
  --expected-count 9 `
  --resample bilinear `
  --out-dir "outputs/candidates"
```

`stretch` fills the exact delivery size. `contain` preserves aspect ratio on a transparent canvas. `--safe-margin` reserves a fractional margin on every edge when using `contain`. `bilinear` is the default resampler; use `nearest` for intentional pixel replication.

`generate`, `edit`, and `batch` accept the same delivery controls. Add `--qa` to attach `qa.v1` results without changing generation success or retrying the request. For transparent requests, a failed transparency route skips dependent delivery transforms and returns the API file unchanged; a successful route returns the API source together with the final derived delivery file(s).

### Build a preview board

```powershell
python "$SkillDir/scripts/imagegen.py" preview-board "input.png" `
  --size 64x64 `
  --size 256x256 `
  --preview-background transparent `
  --preview-background white `
  --preview-background checker `
  --out-dir "outputs/previews"
```

The output directory contains each size and background variant, a combined board, and `preview-manifest.json`.

## Configuration

Key `auth.json` fields:

| Field | Purpose |
| --- | --- |
| `base_url` | OpenAI-compatible API base URL, usually ending in `/v1` |
| `api_key` / `api_key_env` | Local credential or environment-variable name |
| `model` | Default image model |
| `user_agent` | HTTP client signature used for API and image URL requests |
| `url_download.proxy_mode` | `environment` by default, or explicit `direct` URL downloading |
| `defaults.*` | Default size, aspect, resolution, quality, format, timeout, and concurrency |
| `postprocess.enabled` | Allows local transparency processing by default; it does not block large transparent requests |
| `transparency.default_route` | Default local transparency route |
| `transparency.prompt_only_allow` | Exact model/mode/size rules for prompt-only alpha generation |
| `transparency.llm_assisted.*` | Bounded agent-guided route and parameter adjustment policy |

If image URL downloads repeatedly fail with TLS EOF through a proxy, choose direct downloading explicitly with `--allow-direct-url-download` for one command or `url_download.proxy_mode="direct"` for a known provider. Image API requests continue to use the normal network path.

When transparency is unmet, the command remains successful if the API image was written. Read the warning and the `transparency` record in the manifest before deciding whether the file is suitable for the final use.

HTTP 4xx responses are API rejections, reported as `error_kind=api_rejected` with `status_code`; they are not transparency failures because no image exists yet. Edit results and edit errors may include technical reference metadata with semantic status `not_evaluated`. Unusual reference dimensions are reported, not automatically blocked.

## Supported Commands

| Command | Purpose |
| --- | --- |
| `info` | Show a redacted configuration summary |
| `generate` | Generate images from a prompt |
| `edit` | Edit one or more reference images |
| `batch` | Run JSONL generation and edit tasks |
| `inspect-image` | Inspect PNG properties and optional expectations |
| `normalize` | Write an exact-size PNG delivery file |
| `split-grid` | Extract an explicit grid into separate PNG files |
| `preview-board` | Render target-size and background previews |
| `apply-transparency` | Apply a declared local transparency route to an existing PNG |

Detailed behavior is documented in [references/prompting.md](references/prompting.md), [references/parameters.md](references/parameters.md), [references/postprocess.md](references/postprocess.md), and [references/qa.md](references/qa.md).

See [CHANGELOG.md](CHANGELOG.md) for version history.

## License

[MIT License](LICENSE)
