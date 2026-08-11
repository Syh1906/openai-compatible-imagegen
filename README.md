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

Image responses may contain `data[].b64_json` or `data[].url`. JSON responses are limited to 96 MiB, and each decoded or downloaded image is limited to 64 MiB. Returned PNG files are fully parsed before writing and must be non-interlaced 8-bit RGB/RGBA with no more than 25 million pixels; RGB `tRNS` and other PNG encodings are rejected. JPEG and WebP responses are checked for container and key codec framing before delivery. API credentials are not forwarded to returned image URLs.

Supported request controls include exact pixel sizes, aspect and resolution presets, quality, output format, transparent delivery intent, moderation, and compression. Transparent delivery is handled by a declared local route or an exact prompt-only allow rule; it is not sent as an API background parameter.

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
      "allow_api_retry": false,
      "allow_generated_code": false
    }
  }
}
```

Use `api_key` for a key stored in the local file, or `api_key_env` for the name of an environment variable. Run `info` to view a redacted configuration summary:

```powershell
$SkillDir = "/path/to/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" info
```

The old `capabilities.transparent_background` setting and `background=transparent` request value are removed. Do not translate them into an API parameter. To allow local transparency processing by default, set `postprocess.enabled` to `true`; to allow prompt-only alpha generation, add exact `model`/`mode`/`size` entries under `transparency.prompt_only_allow`.

When a transparent result is requested, local processing has priority. Choose `chroma-matting` for solid key-color plates, `emissive-alpha` for light effects on black, or `mask-alpha` when an explicit mask exists. If local processing is disabled, an exact prompt-only rule may add a real-alpha prompt contract. None of these routes guarantees a valid cutout.

If the result does not meet transparency checks, the API image is returned unchanged with `ok=true`, `transparency.status=unmet`, and `delivery_ready=false`. The skill reports that state instead of rejecting or hiding the image.

Optional `transparency.llm_assisted` lets the agent inspect the failed result and make a bounded number of route or parameter adjustments. It uses only the bundled deterministic processors. It does not install a local model, download weights, execute generated image-processing code, or leave a background Python worker running.

## Ask Your Agent

Describe the subject, visual direction, final size, transparency, quantity, checks, and output directory in normal language.

- "Create a 16:9 product launch banner at 2K, then deliver a 1200x675 PNG in `outputs/campaign`."
- "Turn this product photo into a transparent 512x512 PNG cutout with a 3% safe margin. Confirm real alpha and preview it on white, black, and checker backgrounds."
- "Generate four editorial illustrations about public transit from these prompts and save a batch manifest."
- "Create a square brand mark, report connected components and edge contact, then preview it at 64x64 and 256x256."
- "Generate a 3x3 UI concept sheet and split it into nine 256x256 PNG files."
- "Create a fantasy strategy game frost ability icon, no text, and deliver 64x64 and 128x128 previews."

Generation size and delivery size are separate. A request can generate a larger source image and then produce an exact local deliverable. The returned source image must match the resolved API generation size; a backend response with different dimensions is rejected before publication.

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

Batch rows can set `postprocess`, `transparency_route`, `transparency_mask`, `transparency_options`, `qa`, `components`, `delivery_size`, `grid`, `expected_count`, `resample`, `fit`, and `safe_margin`. The command writes `manifest.json`. When a derived file is published, it appears in `files` and the API source remains in `original_files`. When transparency is unmet, `files` keeps the API source path.

For batch paths, JSONL `images`, `mask`, and `transparency_mask` values are relative to the JSONL file directory. Task or shared `file`, `out`, and `postprocess_out_dir` values are relative to batch `--out`; absolute paths remain unchanged. The manifest records the resolved `output_root` and a `path_contract` file-existence check.

### Apply transparency locally

```powershell
python "$SkillDir/scripts/imagegen.py" apply-transparency "effect.png" `
  --out "outputs/effect-transparent.png" `
  --route emissive-alpha `
  --transparency-param "black_point=8" `
  --transparency-param "gamma=1.2"
```

The command runs in the foreground and exits after writing its result. When processing is unmet, it copies the original image to `--out`, returns `delivery_ready=false`, and still exits successfully so the preserved image can be returned with its warning.

### Inspect and validate

```powershell
python "$SkillDir/scripts/imagegen.py" inspect-image "input.png" `
  --components `
  --expected-size 512x512 `
  --expect-transparent
```

`--expected-size` checks exact dimensions. `--expect-transparent` requires visible content with real alpha. `--components` adds connected-component diagnostics for isolated subjects such as cutouts, marks, interface elements, and game assets.

QA is deterministic and technical. It does not judge aesthetics, identity, layout, or semantic fidelity. Returned-PNG validation, deep inspection, and local transforms use the same parser: non-interlaced 8-bit RGB/RGBA, up to 25 million pixels and a 256 MiB PNG file limit. RGB PNG files with a `tRNS` transparency chunk are rejected instead of being treated as opaque.

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

`generate`, `edit`, and `batch` accept the same delivery controls. Add `--qa` to attach `qa.v1` results without changing generation success or retrying the request. For transparent requests, a failed transparency route skips dependent delivery transforms and returns the API file unchanged.

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
| `postprocess.enabled` | Allows the local transparency route by default |
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

## Quality Checks

```powershell
python -m unittest discover -s tests
python -m compileall -q scripts
```

These checks do not call the image API.

See [CHANGELOG.md](CHANGELOG.md) for version history.

## License

[MIT License](LICENSE)
