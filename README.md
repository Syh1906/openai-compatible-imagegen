<div align="center">

# OpenAI-Compatible Image Generation Skill

**Generate, edit, and batch-create images from agent clients through an OpenAI-compatible image API.**

[![Release](https://img.shields.io/github/v/release/Syh1906/openai-compatible-imagegen?style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Syh1906/openai-compatible-imagegen/ci.yml?branch=main&style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/actions)
[![Skill](https://img.shields.io/badge/skill-SKILL.md-lightgrey?style=flat-square)](SKILL.md)

English | [简体中文](README.zh-CN.md)

</div>

---

## Why Use It

This repository is a portable agent skill. It gives Codex, Claude Code, OpenCode, and other Agent Skills-compatible clients the same local workflow for image generation.

| Need | What this skill provides |
| --- | --- |
| Generate images from prompts | `generate` command for text-to-image requests |
| Edit or transform reference images | `edit` command with one or more input images |
| Produce many assets at once | `batch` command with JSONL input and limited concurrency |
| Create icons, sprites, and transparent assets | `--asset` and `--transparent` intent switches |
| Optional post-processing | Explicit `inspect-image`, `normalize`, and `split-grid` commands |
| Keep credentials local | ignored `auth.json`, direct `api_key`, or `api_key_env` support |

---

## Compatibility

This skill targets OpenAI-compatible image APIs that expose the following endpoints under `base_url`:

| Mode | Endpoint | Request type |
| --- | --- | --- |
| `generate` | `POST /v1/images/generations` | JSON |
| `edit` | `POST /v1/images/edits` | `multipart/form-data` |

`base_url` should usually end with `/v1`, for example:

```json
{
  "base_url": "https://example.com/v1",
  "model": "gpt-image-2"
}
```

The default model in `examples/auth.example.json` is only a template value. Set `model` to any image model supported by your backend, such as an OpenAI-compatible image generation model exposed by your gateway or provider.

Supported script-level options include:

- exact output sizes such as `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, and 4K-style sizes when the backend supports them
- semantic size selection with `--aspect` (`1:1`, `16:9`, `4:3`, `3:4`, `9:16`) and `--resolution` (`1K`, `2K`, `4K`)
- quality values `low`, `medium`, `high`, and `auto`
- output formats `png`, `jpeg`, and `webp`
- `background=transparent` only when `capabilities.transparent_background=true`
- optional moderation and compression parameters when the backend accepts them

Backend parameter support varies. Keep command flags and `auth.json` defaults aligned with the provider you use.

---

## Installation

### From Release Package

Download `openai-compatible-imagegen-v0.1.1.zip` from [Releases](https://github.com/Syh1906/openai-compatible-imagegen/releases), then extract it into a skills directory supported by your agent client.

### From Git

Clone this repository directly into the target skills directory when you want to update with `git pull`.

| Client | User-level install path | Command |
| --- | --- | --- |
| Codex | `~/.codex/skills/openai-compatible-imagegen` | `git clone https://github.com/Syh1906/openai-compatible-imagegen.git ~/.codex/skills/openai-compatible-imagegen` |
| Claude Code | `~/.claude/skills/openai-compatible-imagegen` | `git clone https://github.com/Syh1906/openai-compatible-imagegen.git ~/.claude/skills/openai-compatible-imagegen` |
| OpenCode | `~/.config/opencode/skill/openai-compatible-imagegen` | `git clone https://github.com/Syh1906/openai-compatible-imagegen.git ~/.config/opencode/skill/openai-compatible-imagegen` |

Project-local installs are also useful when only one repository should use the skill:

| Client | Project-local path |
| --- | --- |
| Codex | `.codex/skills/openai-compatible-imagegen` |
| Claude Code | `.claude/skills/openai-compatible-imagegen` |
| OpenCode | `.opencode/skill/openai-compatible-imagegen` |

The skill directory must contain `SKILL.md` at its root.

---

## Initialize Auth

Create the local private config before first use:

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" init
```

You can initialize non-secret fields:

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" init `
  --base-url "https://example.com/v1" `
  --model "gpt-image-2" `
  --api-key-env "OPENAI_API_KEY"
```

`auth.json` is local and ignored by git. You can provide the API key in either way:

- Write it directly to `auth.json` as `api_key`.
- Set `api_key_env` in `auth.json`, then put the key in that environment variable.

When both are present, the script prefers `api_key`. If `api_key` is still the template placeholder, the script reads `api_key_env`.

Check the config summary:

```powershell
python "$SkillDir/scripts/imagegen.py" info
```

`info` redacts the API key and only shows its source.

---

## Usage

### Ask Your Agent

After installing the skill and configuring `auth.json`, ask your agent for the image result you want. Mention the final asset shape, transparency, count, and post-processing need in normal language.

Examples:

- "Use the OpenAI-compatible image generation skill to create a 1024x1024 Warcraft 3 style frost skill icon, no text. Save the final PNG under `outputs/`."
- "Create a 16:9 2K livestream banner in a product showcase style. Save it as WebP."
- "Create a 9:16 4K phone wallpaper with a cyberpunk market stall scene."
- "Create a transparent-background item asset for a centered fire orb. I need a PNG with real alpha if the backend supports it."
- "Generate a 3x3 sheet of game item candidates, then split it into 9 separate 128x128 PNG files."
- "Use this reference image and convert it to a dark magic UI style. Keep the result as a PNG."
- "Generate four independent icon concepts from these prompts and save a batch manifest."

For post-processing requests, describe both the source generation size and the final delivery size:

- "Generate a 1024x1024 source icon, then deliver a 128x128 PNG."
- "Inspect this PNG, confirm whether it has alpha, then resize it to 128x128."
- "Split this 3x3 candidate sheet into 9 normalized 128x128 files."

### Manual Commands

Generate an image:

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Warcraft 3 style frost skill icon, single rune, centered, no text" `
  -f "outputs/frost-rune.png" `
  --aspect 1:1 `
  --resolution 1K `
  --quality high
```

Choose a size from shape and clarity:

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Livestream shopping banner for discounted transit-station tokens, bold product showcase style" `
  -f "outputs/token-banner.webp" `
  --aspect 16:9 `
  --resolution 2K `
  --format webp `
  --quality medium
```

Edit with a reference image:

```powershell
python "$SkillDir/scripts/imagegen.py" edit `
  -p "Convert this to a dark magic UI style" `
  -i "input.png" `
  -f "outputs/dark-ui.png"
```

Run a batch:

```powershell
python "$SkillDir/scripts/imagegen.py" batch `
  --input "examples/batch.example.jsonl" `
  --out "outputs/imagegen" `
  --concurrency 3
```

Generate a transparent-background asset intent:

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Centered fire orb game item asset, no text" `
  -f "outputs/fire-orb.png" `
  --asset `
  --transparent
```

If the selected model and resolution cannot use transparent background, the script stops before sending the request. Choose one path: switch to a transparent-capable model and keep transparency, or keep the current model and use `background=auto`.

Optional post-processing:

```powershell
python "$SkillDir/scripts/imagegen.py" inspect-image "input.png"

python "$SkillDir/scripts/imagegen.py" normalize "input.png" `
  --delivery-size 128x128 `
  --out "output.png"

python "$SkillDir/scripts/imagegen.py" split-grid "grid.png" `
  --grid 3x3 `
  --delivery-size 128x128 `
  --out-dir "candidates"
```

Post-processing turns returned PNG files into delivery-ready files. It covers three common tasks:

| Task | Command | Result |
| --- | --- | --- |
| Inspect a PNG | `inspect-image` | Prints width, height, alpha-channel status, and alpha bounds. |
| Resize one PNG | `normalize` | Writes one PNG at the requested `--delivery-size`. |
| Split a candidate sheet | `split-grid` | Writes one normalized PNG per grid cell. |

The image API request size and the final delivery size are separate. For example, a backend may return a `1024x1024` PNG while you need a `128x128` icon. Use `--delivery-size 128x128` to write the final icon file.

`generate`, `edit`, and `batch` can also write post-processed outputs when you pass `--delivery-size`, `--grid`, or `--postprocess-out-dir`. In that mode, the command keeps the original returned file path under `original_files` and returns the processed files in `files`.

---

## Configuration

`examples/auth.example.json` is the local config template.

Important fields:

- `base_url`: OpenAI-compatible API base URL, usually ending in `/v1`.
- `api_key`: API key stored directly in the local config. Do not commit real values.
- `api_key_env`: Environment variable name used when `api_key` is empty or still a placeholder.
- `model`: Default image model for `generate`, `edit`, and `batch`.
- `capabilities.transparent_background`: Set `true` only when the API accepts `background=transparent`.
- `defaults.size`: API request size used when `--size` is omitted.
- `defaults.aspect`: Optional default aspect used with `defaults.resolution` when `--size` is omitted.
- `defaults.resolution`: Optional default `1K`, `2K`, or `4K` resolution used with `defaults.aspect`.
- `defaults.quality`: Quality used when `--quality` is omitted.
- `defaults.output_format`: Output format used when `--format` is omitted.
- `defaults.timeout_seconds`: Per-request timeout in seconds.
- `defaults.concurrency`: Batch concurrency used when `--concurrency` is omitted.
- `postprocess.enabled`: Enables generated-output post-processing. The final output size is not stored in `auth.json`; use `--delivery-size` on commands that resize or split images.

Post-processing request examples:

- Single icon: "Generate a 1024x1024 source image, then deliver a 128x128 PNG in `outputs/final`."
- Candidate sheet: "Generate a 3x3 candidate sheet and split it into 9 normalized 128x128 PNG files."
- Existing file: "Resize `raw.png` to `128x128` and save it as `icon.png` without calling the image API."

---

## Quality

Run local checks:

```powershell
python -m unittest discover -s tests
python -m py_compile scripts/imagegen.py
```

Tests do not call the image API.

---

## Release Package

The release zip contains one top-level folder and the current post-processing documentation:

```text
openai-compatible-imagegen/
├── SKILL.md
├── agents/openai.yaml
├── scripts/imagegen.py
├── references/parameters.md
├── references/postprocess.md
└── examples/
```

Local `auth.json` is not included.

---

## License

[MIT License](LICENSE)
