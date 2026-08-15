<div align="center">

# OpenAI-Compatible Images

**Generate, edit, batch-process, inspect, and deliver images through an OpenAI-compatible image API.**

[![Release](https://img.shields.io/github/v/release/Syh1906/openai-compatible-imagegen?style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Syh1906/openai-compatible-imagegen/ci.yml?branch=main&style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/actions)

English | [Simplified Chinese](README.zh-CN.md)

</div>

---

## Choose a Package

This repository publishes the same image-generation core in two alternative packages. Install the one that matches where you work.

| Package | Use it when | Adds |
| --- | --- | --- |
| **OpenAI-Compatible Images Skill** | You want a portable Agent Skill or command-line workflow, including clients outside Codex App | Standalone CLI, local `auth.json`, JSONL batch, delivery tools, and QA |
| **OpenAI-Compatible Images** | You work in Codex App and want the complete image workflow | MCP tools, conversation results, focused canvas editing, annotations, immutable artifacts, and version history |

The Codex Plugin includes the Standalone package's generation, editing, batch, transparency, delivery, and QA capabilities. It does not require the Standalone Skill to be installed. The first combined release treats the two packages as alternatives; it does not promise simultaneous routing, automatic configuration sync, or a shared artifact directory between installations.

## Shared Capabilities

| Need | Capability |
| --- | --- |
| Create or revise images | Text-to-image generation, reference-image editing, masks, and multiple references |
| Produce controlled variations | One-request multi-image output and JSONL batches with bounded concurrency |
| Preserve source results | Every complete API original is published before optional delivery transforms |
| Deliver exact files | PNG resizing, contain/stretch fitting, safe margins, grid splitting, and preview boards |
| Prepare transparency | Declared chroma, emissive-alpha, mask-alpha, or verified prompt-alpha routes |
| Check technical requirements | Deterministic `qa.v1` checks for dimensions, alpha, edge contact, and components |
| Keep credentials local | Direct-key or environment-variable authentication without returning secrets in results |

The configured backend must expose `POST /v1/images/generations` and `POST /v1/images/edits`. Responses may contain `data[].b64_json` or `data[].url`. Returned image URLs never receive the API key.

## Install

Release artifacts identify their installation shape:

```text
openai-compatible-imagegen-skill-<version>.zip
openai-compatible-imagegen-codex-plugin-<version>.zip
```

### Standalone Skill

Extract the Skill archive into a skills directory supported by your agent client. The extracted `openai-compatible-imagegen` directory must contain `SKILL.md` at its root.

| Client | User-level path | Project-level path |
| --- | --- | --- |
| Codex | `~/.codex/skills/openai-compatible-imagegen` | `.codex/skills/openai-compatible-imagegen` |
| Claude Code | `~/.claude/skills/openai-compatible-imagegen` | `.claude/skills/openai-compatible-imagegen` |
| OpenCode | `~/.config/opencode/skill/openai-compatible-imagegen` | `.opencode/skill/openai-compatible-imagegen` |

### Codex Plugin

Use the Codex Plugin archive with the plugin installation flow supported by your Codex App version. Its root contains `.codex-plugin/plugin.json`, `.mcp.json`, the prebuilt MCP server and widget, and the bundled Plugin Skill. It does not require a local web server.

The release notes provide the exact installation and update steps for the supported channel. Public-directory availability and automatic updates are not implied by the downloadable archive.

## Configure

The two packages adapt their local configuration to one shared runtime. They do not discover, merge, or fall back to each other's configuration files.

### Standalone Configuration

The Standalone Skill reads `auth.json` from its installed directory. Run the setup wizard there:

```powershell
$SkillDir = "/path/to/openai-compatible-imagegen"
python "$SkillDir/scripts/quick-init.py"
```

For manual setup, copy [`examples/auth.example.json`](examples/auth.example.json) to `auth.json`. Set `base_url`, `model`, and either `api_key_env` or `api_key`. Git ignores `auth.json`. `url_download.proxy_mode` uses the environment proxy by default. If returned image URLs repeatedly fail with TLS EOF through that proxy, authorize direct downloading for one command with `--allow-direct-url-download`, or set `direct` only for a provider whose URL route has been approved.

Runtime priority is:

```text
per-row batch fields > shared command flags > auth.json defaults > built-in defaults
```

Run `info` to inspect a redacted summary:

```powershell
python "$SkillDir/scripts/imagegen.py" info
```

### Plugin Configuration

The Codex Plugin reads only these fixed paths:

1. Required user configuration: `~/.codex/openai-compatible-imagegen/config.json`
2. Optional project configuration: `<project>/.codex/openai-compatible-imagegen/config.json`

Start from [`skills/openai-compatible-imagegen/references/config.example.json`](skills/openai-compatible-imagegen/references/config.example.json). The user file is the trusted baseline and declares `config_version: 1`, an active profile, provider, model, defaults, post-processing, transparency policy, and storage.

The project file may override only:

- `defaults.size`
- `defaults.quality`
- `defaults.output_format`
- `storage.output_directory`

It cannot change the active profile, model, provider, endpoint, authentication source, credential environment variable, timeout, concurrency, or route permissions. An invalid or unauthorized project file stops binding before credentials are read or a network request starts.

Plugin priority is:

```text
explicit tool values > project allowlisted overrides > user defaults > built-in defaults
```

`storage.output_directory` must be a safe relative directory inside the project. The default is `output/imagegen/`. Project-root output, outside paths, files, symbolic links, junctions, and other reparse points are rejected. Configuration is frozen when the project binds; restart the MCP server and bind again after changing it.

## Migrate to the Plugin

Migration is explicit. The Plugin never scans for, reads, copies, merges, deletes, or overwrites a legacy `auth.json` or development Plugin configuration.

From the installed Plugin root, run a redacted dry-run with the exact legacy path and source kind:

```powershell
python "<plugin-root>/dist/scripts/migrate_image_config.py" `
  --source "<legacy-config>" `
  --source-kind standalone
```

Use `--source-kind development-plugin` for a development Plugin configuration. Only that source kind can also migrate safe project overrides, and only when both runs include `--include-project-overrides --project-root "<project-root>"`.

Review `sourceKind`, `sourceSha256`, target paths, `readyToWrite`, and the redacted preview. Then write with the same inputs and the reviewed digest:

```powershell
python "<plugin-root>/dist/scripts/migrate_image_config.py" `
  --source "<legacy-config>" `
  --source-kind standalone `
  --write `
  --expected-source-sha256 "<sourceSha256>"
```

Environment-variable authentication migrates by default. A usable plaintext key requires separate approval and `--allow-plaintext-api-key` on the write command. A changed source digest, existing target, unsupported model, removed `transparent_background` field, invalid schema, or write failure stops the migration. The source file remains unchanged. Automatic Plugin-to-Standalone migration is not provided.

## Use

Describe the subject, composition, visual direction, size, quantity, transparency, checks, and output location in normal language.

- "Create a 16:9 product launch banner at 2K, then deliver a 1200x675 PNG."
- "Edit this product photo into a transparent 512x512 cutout with a 3% safe margin and preview it on white, black, and checker backgrounds."
- "Generate four editorial illustrations from these prompts and keep a batch manifest."
- "Protect the notebook, recolor the mug, and open the result in the focused canvas for review."

In Codex App, the Plugin routes generation and editing through MCP, renders stable conversation results, and opens a focused canvas when annotations are needed. In the Standalone package, the agent invokes the bundled CLI and reports file and manifest paths.

### Standalone Commands

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Editorial still life, soft window light, room for a headline, no text" `
  -f "outputs/still-life.png" `
  --aspect 4:3 `
  --resolution 2K `
  --quality high

python "$SkillDir/scripts/imagegen.py" edit `
  -p "Preserve the subject and camera angle; replace the background with a neutral studio wall" `
  -i "input.png" `
  -f "outputs/studio-edit.png"

python "$SkillDir/scripts/imagegen.py" batch `
  --input "examples/batch.example.jsonl" `
  --out "outputs/imagegen" `
  --concurrency 3
```

Supported commands are `info`, `generate`, `edit`, `batch`, `inspect-image`, `normalize`, `split-grid`, `preview-board`, and `apply-transparency`.

## Originals and Delivery

Generation success and delivery readiness are separate:

- `ok=true` means at least one complete API original was published.
- Standalone reports `delivery_ready`; the Plugin maps the same fact to `deliveryReady`.
- Transparency, transform, or QA failure preserves the original and reports the unmet condition.
- API count, size, or format deviations are recorded as warnings rather than reasons to hide a valid original.

Generation size and delivery size are independent. A larger source can produce an exact local derivative without replacing the source. The Plugin stores originals, derivatives, QA, delivery receipts, batch manifests, and edit versions as immutable related artifacts.

## Transparency

`--transparent` and the Plugin transparency option are delivery intent. They force PNG but never send `background=transparent` to the image API.

Use a route only when its input contract is true:

| Route | Suitable input |
| --- | --- |
| `chroma-matting` | Isolated subject on a known, controlled solid plate |
| `emissive-alpha` | Fire, particles, lightning, glow, or smoke on pure black |
| `mask-alpha` | A trusted alpha, luminance, or RGB channel mask |
| `prompt-alpha` | An exact backend model/mode/size combination verified for prompt-only alpha |

Hair, glass, translucent fabric, and mixed smoke backgrounds need a controlled plate or trusted mask. If the contract is not met, the original is returned with an unmet status. The editor's protected/edit regions and a transparency alpha mask are separate concepts.

## QA and Limits

`qa.v1` reports `pass`, `fail`, `partial`, or `not_evaluated`. It checks deterministic technical facts such as dimensions, alpha coverage, edge contact, margins, and optional connected components. It does not judge aesthetics, identity, layout, or semantic fidelity, and it does not change a request to force a pass.

One API request accepts `n=1..16`. The runtime bounds response size, decoded image size, cumulative response work, batch concurrency, and image count before publication. PNG, JPEG, and WebP originals receive bounded structural validation. Deep local transforms and QA operate on the documented PNG subset; unsupported deep inspection affects delivery readiness, not visibility of an already validated original.

No route automatically switches the model, provider, endpoint, protocol, authentication source, or download proxy. Another image API request occurs only through an explicitly allowed workflow; the Codex Plugin does not retry the image API after a transparency delivery failure.

## Documentation

- [Prompting guide](references/prompting.md)
- [Parameter reference](references/parameters.md)
- [Post-processing reference](references/postprocess.md)
- [Delivery QA reference](references/qa.md)
- [Version history](CHANGELOG.md)

## License

[MIT License](LICENSE)
