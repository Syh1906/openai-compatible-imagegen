# OpenAI-Compatible Image Generation Skill

[中文](README.md)

This repository provides a Codex skill for calling an OpenAI-compatible image API through a local Python script. It supports text-to-image generation, reference-image editing, batch generation, and transparent-background asset intent.

## Install

Clone this repository into your Codex skills directory:

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
git clone https://github.com/Syh1906/openai-compatible-imagegen.git $SkillDir
```

Use your own Codex skills directory if it is different.

## Initialize Auth

Create the local private config before first use:

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" init
```

You can also initialize non-secret fields:

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
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" info
```

`info` redacts the API key and only shows its source.

## Usage

Generate an image:

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Warcraft 3 style frost skill icon, single rune, centered, no text" `
  -f "outputs/frost-rune.png" `
  --size 1024x1024 `
  --quality high
```

Edit with a reference image:

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" edit `
  -p "Convert this to a dark magic UI style" `
  -i "input.png" `
  -f "outputs/dark-ui.png"
```

Run a batch:

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" batch `
  --input "examples/batch.example.jsonl" `
  --out "outputs/imagegen" `
  --concurrency 3
```

Generate a transparent-background asset intent:

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Centered fire orb game item asset, no text" `
  -f "outputs/fire-orb.png" `
  --asset `
  --transparent
```

## Config Fields

`examples/auth.example.json` is the template:

- `base_url`: OpenAI-compatible API base URL, usually ending in `/v1`.
- `api_key`: API key stored directly in the local config.
- `api_key_env`: Optional environment variable name for the API key.
- `model`: Default image model.
- `capabilities.transparent_background`: Whether the API supports `background=transparent`.
- `defaults`: Default size, quality, format, timeout, and batch concurrency.

## Verify

Run local tests:

```powershell
python -m unittest discover -s tests
```

Tests do not call the image API.
