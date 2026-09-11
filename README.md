<div align="center">

# OpenAI-Compatible Images

**Generate, inspect, edit, and deliver images through configured API providers or the Codex App ChatGPT route.**

[![Release](https://img.shields.io/github/v/release/Syh1906/openai-compatible-imagegen?style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Syh1906/openai-compatible-imagegen/ci.yml?branch=main&style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/actions)

English | [简体中文](README.zh-CN.md)

</div>

OpenAI-Compatible Images ships one image core in two installation shapes. Use the portable Standalone Skill with Agent clients and command-line workflows, or install the Codex Plugin for result cards, focused canvas editing, annotations, immutable artifacts, and version history.

## Choose your package

API Key profiles support OpenAI-compatible, Atlas, xAI Images, Gemini Interactions, and Gemini generateContent protocols. Configure provider connections, aliases, and native parameter fields independently, then choose a model for one request or canvas edit. See [model configuration](docs/guides/models.md).

| Package | Best for | Includes |
| --- | --- | --- |
| **Standalone Skill** | Codex CLI, Claude Code, OpenCode, and other Agent Skills clients | Generation, editing, JSONL batches, transparency, delivery, and QA |
| **Codex Plugin** | Codex App users who want result cards and a focused canvas | API Key: full image workflow. ChatGPT: host generation and semantic canvas edits, with artifacts, delivery, and versions |

Choose one installation shape for each environment. The packages share code and versions but keep separate local configuration and artifact directories. Follow the [migration guide](docs/guides/migration.md) when moving an existing configuration to the Codex Plugin.

## Codex App workflow

API Key generation and edits use durable asynchronous jobs. Track long batches, recover confirmed results after a wait times out, and resume local processing with saved originals. See [long-running generation and batches](docs/guides/image-jobs.md).

Generate an image in the conversation, then open its focused canvas to mark regions and add instructions for each change.

**Conversation result**

![OpenAI-Compatible Images result card in Codex App](docs/images/codex-result-card.png)

**Focused editing canvas**

![Theme-aware image canvas with region and arrow annotations](docs/images/codex-editing-canvas.png)

## Install the Codex Plugin

Requirements: a Codex version with Plugin support, Git, Node.js 20+, and Python 3.12 or newer. The Plugin ZIP is platform-neutral and supports Windows, macOS, and Linux. Choose the API Key route with your own image API service, or choose the ChatGPT route when the Codex App host provides its image generation capability.

```text
codex plugin marketplace add Syh1906/openai-compatible-imagegen
codex plugin add openai-compatible-imagegen@openai-compatible-imagegen
```

If the `openai-compatible-imagegen` marketplace is already registered, skip the first command. After installation, completely quit and restart Codex once so it loads the Plugin's Skill, MCP tools, and bundled dependencies.

The Plugin is prebuilt. Continue with [configuration](docs/guides/configuration.md#configure-the-codex-plugin); see the [installation guide](docs/guides/installation.md#install-the-codex-plugin) for other installation methods and platform requirements.

## Install the Standalone Skill

Download `openai-compatible-imagegen-skill-<version>.zip` from [GitHub Releases](https://github.com/Syh1906/openai-compatible-imagegen/releases). Extract it into your client's skills directory so `SKILL.md` is at the package root, then start a new session.

Requires Python 3.12 or newer and an image-service credential. The [installation guide](docs/guides/installation.md#install-the-standalone-skill) covers client paths and the third-party Skills CLI; then complete [Standalone configuration](docs/guides/configuration.md#configure-the-standalone-skill). Follow the [update guide](docs/guides/updating.md) to preserve configuration when switching an existing installation.

## What it does

- Generate images and edit one or more references.
- Generate multiple images or batch different image requests.
- Preserve published API originals when local delivery fails.
- Resize, fit, add safe margins, split grids, and build preview boards.
- Prepare transparency through configured native-alpha, chroma, emissive, mask, or verified prompt-alpha routes.
- Run deterministic checks for dimensions, alpha, edge contact, margins, and components.
- Keep credentials local and return only safe error summaries.
- In Codex App, review results in conversation and continue through a focused annotation canvas.

Available operations depend on the selected route and model. Atlas Cloud currently supports text-to-image generation only. See [configuration](docs/guides/configuration.md#configure-atlas-cloud).

## Use it

Describe the subject, composition, size, quantity, transparency, checks, and output you need:

> Create a 16:9 product launch banner at 2K, then deliver a 1200x675 PNG.

> Protect the notebook, recolor the mug, and open the result in the focused canvas for review.

> Generate four editorial illustrations and keep a manifest of each batch result.

The Plugin presents results and canvas actions in Codex App. The Standalone Skill runs its bundled CLI and reports output and manifest paths.

## Documentation

Use the [documentation index](docs/README.md) to find installation, configuration, migration, updating, rollback, troubleshooting, and architecture guides.

## Security

Credentials stay in user-controlled files or environment variables. The project does not run a hosted image service or collect prompts and outputs. See [SECURITY.md](SECURITY.md) for reporting and trust boundaries.

## License

[MIT](LICENSE)
