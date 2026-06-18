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

- output sizes such as `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, and 4K-style sizes when the backend supports them
- quality values `low`, `medium`, `high`, and `auto`
- output formats `png`, `jpeg`, and `webp`
- `background=transparent` only when `capabilities.transparent_background=true`
- optional moderation and compression parameters when the backend accepts them

Backends differ. If your provider does not support a parameter, remove that parameter from the command or adjust `auth.json` defaults. The skill does not switch models, endpoints, or post-process images unless you explicitly add that behavior.

---

## Installation

### From Release Package

Download `openai-compatible-imagegen-v0.1.0.zip` from [Releases](https://github.com/Syh1906/openai-compatible-imagegen/releases), then extract it into a skills directory supported by your agent client.

### From Git

Clone this repository directly into the target skills directory when you want to update with `git pull`.

| Client | User-level install path | Command |
| --- | --- | --- |
| Codex | `~/.agents/skills/openai-compatible-imagegen` | `git clone https://github.com/Syh1906/openai-compatible-imagegen.git ~/.agents/skills/openai-compatible-imagegen` |
| Claude Code | `~/.claude/skills/openai-compatible-imagegen` | `git clone https://github.com/Syh1906/openai-compatible-imagegen.git ~/.claude/skills/openai-compatible-imagegen` |
| OpenCode | `~/.config/opencode/skills/openai-compatible-imagegen` | `git clone https://github.com/Syh1906/openai-compatible-imagegen.git ~/.config/opencode/skills/openai-compatible-imagegen` |

Project-local installs are also useful when only one repository should use the skill:

| Client | Project-local path |
| --- | --- |
| Codex / shared Agent Skills layout | `.agents/skills/openai-compatible-imagegen` |
| Claude Code | `.claude/skills/openai-compatible-imagegen` |
| OpenCode | `.opencode/skills/openai-compatible-imagegen` |

The skill directory must contain `SKILL.md` at its root.

---

## Initialize Auth

Create the local private config before first use:

```powershell
$SkillDir = "$env:USERPROFILE/.agents/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" init
```

You can initialize non-secret fields:

```powershell
$SkillDir = "$env:USERPROFILE/.agents/skills/openai-compatible-imagegen"
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

Generate an image:

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Warcraft 3 style frost skill icon, single rune, centered, no text" `
  -f "outputs/frost-rune.png" `
  --size 1024x1024 `
  --quality high
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

Post-processing is disabled by default and does not change legacy `generate`, `edit`, or `batch` behavior.
For one run, pass `--delivery-size`, `--grid`, and `--postprocess-out-dir` explicitly to `generate`, `edit`, or `batch`.

---

## Configuration

`examples/auth.example.json` is the template:

- `base_url`: OpenAI-compatible API base URL, usually ending in `/v1`.
- `api_key`: API key stored directly in the local config.
- `api_key_env`: Optional environment variable name for the API key.
- `model`: Default image model.
- `capabilities.transparent_background`: Whether the API supports `background=transparent`.
- `defaults`: Default size, quality, format, timeout, and batch concurrency.
- `postprocess.enabled`: Optional post-processing opt-in; missing or `false` preserves legacy behavior.

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

The release zip contains one top-level folder:

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
