<div align="center">

# OpenAI-Compatible Images

**Generate, edit, batch-process, inspect, and deliver images through your OpenAI-compatible image API.**

[![Release](https://img.shields.io/github/v/release/Syh1906/openai-compatible-imagegen?style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Syh1906/openai-compatible-imagegen/ci.yml?branch=main&style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/actions)

English | [简体中文](README.zh-CN.md)

</div>

OpenAI-Compatible Images ships one image core in two installation shapes. Use the portable Standalone Skill with Agent clients and command-line workflows, or install the Codex Plugin for result cards, focused canvas editing, annotations, immutable artifacts, and version history.

## Choose your package

| Package | Best for | Includes |
| --- | --- | --- |
| **Standalone Skill** | Codex CLI, Claude Code, OpenCode, and other Agent Skills clients | Generation, editing, JSONL batches, transparency, delivery, and QA |
| **Codex Plugin** | Codex App users who want the complete image workflow | All shared capabilities plus MCP tools, result cards, canvas editing, artifacts, and versions |

Install one or both. They share code and versions but keep separate local configuration and artifact directories.

## Install the Codex Plugin

Requirements: a Codex version with Plugin support, Git, Node.js 20+, Python 3.12, and your own OpenAI-compatible image service.

```text
codex plugin marketplace add Syh1906/openai-compatible-imagegen
codex plugin add openai-compatible-imagegen@openai-compatible-imagegen
```

You can also open **Plugins** in Codex App, select the `openai-compatible-imagegen` marketplace, and install **OpenAI-Compatible Images**. In an interactive Codex CLI session, enter `/plugins` to use the same browser.

The Git-backed package already contains the MCP server and widget. You do not build the repository or run a local web server.

[Plugin installation and configuration](docs/guides/installation.md#install-the-codex-plugin)

## Install the Standalone Skill

Download `openai-compatible-imagegen-skill-<version>.zip` from [GitHub Releases](https://github.com/Syh1906/openai-compatible-imagegen/releases). Extract it into your client's skills directory so `SKILL.md` is at the package root, then start a new session.

[Standalone installation paths and setup](docs/guides/installation.md#install-the-standalone-skill)

## What it does

- Generate images and edit one or more references.
- Run bounded multi-image and heterogeneous batch jobs.
- Preserve every complete API original before delivery transforms.
- Resize, fit, add safe margins, split grids, and build preview boards.
- Prepare transparency through declared chroma, emissive, mask, or verified prompt-alpha routes.
- Run deterministic checks for dimensions, alpha, edge contact, margins, and components.
- Keep credentials local and return only safe error summaries.
- In Codex App, review results in conversation and continue through a focused annotation canvas.

The backend must expose `POST /v1/images/generations` and `POST /v1/images/edits`, returning `data[].b64_json` or `data[].url`.

## Use it

Describe the subject, composition, size, quantity, transparency, checks, and output you need:

> Create a 16:9 product launch banner at 2K, then deliver a 1200x675 PNG.

> Protect the notebook, recolor the mug, and open the result in the focused canvas for review.

> Generate four editorial illustrations and keep an auditable batch manifest.

The Plugin presents results and canvas actions in Codex App. The Standalone Skill runs its bundled CLI and reports output and manifest paths.

## Documentation

| Task | Guide |
| --- | --- |
| Choose and install a package | [Installation](docs/guides/installation.md) |
| Connect a provider and model | [Configuration](docs/guides/configuration.md) |
| Move from an older installation | [Migration](docs/guides/migration.md) |
| Restore a released version | [Rollback](docs/guides/rollback.md) |
| Diagnose install or runtime errors | [Troubleshooting](docs/guides/troubleshooting.md) |
| Understand repository boundaries | [Architecture](docs/arch.md) |
| Browse all public docs | [Documentation index](docs/README.md) |

## For AI agents

- Installing for a user: read [the installation guide](docs/guides/installation.md), then stop before handling credentials.
- Configuring an installed package: read [the configuration guide](docs/guides/configuration.md).
- Maintaining this repository: read [AGENTS.md](AGENTS.md) before changing code or docs.
- Running image work: use the installed package's `SKILL.md`; it is the runtime tool-routing contract.

Raw installation guide for Agent handoff:

```text
https://raw.githubusercontent.com/Syh1906/openai-compatible-imagegen/main/docs/guides/installation.md
```

## Security

Credentials stay in user-controlled files or environment variables. The project does not run a hosted image service or collect prompts and outputs. See [SECURITY.md](SECURITY.md) for reporting and trust boundaries.

## License

[MIT](LICENSE)
