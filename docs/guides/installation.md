<!-- updated: 2026-08-16 -->

# Installation

Choose one package. Both packages use the same image core, but they target different hosts and keep separate local configuration.

## Choose a package

| Package | Install it when | What you get |
| --- | --- | --- |
| Standalone Skill | Your agent supports Agent Skills, or you want the CLI | Generation, editing, JSONL batch, delivery, transparency, and QA |
| Codex Plugin | You use Codex App and want image result cards and the focused canvas | All shared image capabilities plus MCP tools, annotations, artifacts, and versions |

You do not need to install both. The Codex Plugin does not depend on the Standalone Skill.

## Install the Codex Plugin

### Requirements

- A Codex App version with Plugin support
- Git
- Node.js 20 or later
- Python 3.12
- An OpenAI-compatible image service and your own credential

The Plugin includes its prebuilt MCP server and widget. You do not run `npm install`, build the repository, or start a local web server.

### Steps

1. Add the repository marketplace:

```text
codex plugin marketplace add Syh1906/openai-compatible-imagegen
```

2. In Codex App, open **Plugins**, select the `openai-compatible-imagegen` marketplace, and install **OpenAI-Compatible Images**.
3. For Codex CLI, start `codex`, enter `/plugins`, select the same marketplace, and install the Plugin.
4. Start a new task after installation.
5. Continue with [Plugin configuration](./configuration.md#configure-the-codex-plugin).

### Agent handoff

Give an Agent this task when you want it to prepare the supported install without changing global runtimes:

```text
Install OpenAI-Compatible Images as a Codex Plugin from the Git-backed marketplace
Syh1906/openai-compatible-imagegen. Verify Git, Node.js 20+, and Python 3.12 first.
Do not install global dependencies or build the repository. Stop before entering or moving credentials.
```

## Install the Standalone Skill

### Requirements

- Python 3.12
- An Agent client that loads Agent Skills
- An OpenAI-compatible image service and your own credential

### Steps

1. Download `openai-compatible-imagegen-skill-<version>.zip` from the GitHub Release.
2. Extract it so the resulting `openai-compatible-imagegen` directory has `SKILL.md` at its root.
3. Place that directory in a skills location supported by your client:

| Client | User location | Project location |
| --- | --- | --- |
| Codex | `~/.codex/skills/openai-compatible-imagegen` | `.codex/skills/openai-compatible-imagegen` |
| Claude Code | `~/.claude/skills/openai-compatible-imagegen` | `.claude/skills/openai-compatible-imagegen` |
| OpenCode | `~/.config/opencode/skill/openai-compatible-imagegen` | `.opencode/skill/openai-compatible-imagegen` |

4. Start a new task or session so the client reloads skills.
5. Continue with [Standalone configuration](./configuration.md#configure-the-standalone-skill).

### Agent handoff

```text
Install the OpenAI-Compatible Images Standalone Skill from the requested GitHub Release.
Place the extracted openai-compatible-imagegen directory in this client's supported skills directory
with SKILL.md at the package root. Do not overwrite an existing installation or move credentials.
Report the installed version and final skill path.
```

## Installation result

| Check | Standalone Skill | Codex Plugin |
| --- | --- | --- |
| Package identity | `SKILL.md` at install root | `.codex-plugin/plugin.json` at install root |
| Runtime entry | `scripts/imagegen.py` | `dist/server.mjs` through `.mcp.json` |
| UI | Host conversation only | Result cards and focused canvas in Codex App |
| Configuration | Installed directory `auth.json` | User and optional project `config.json` |

Public Plugins Directory availability is separate from this Git-backed release channel.

Each GitHub Release also provides `openai-compatible-imagegen-codex-plugin-<version>.zip` for offline inspection, checksum verification, archive, and rollback. The Git-backed marketplace remains the normal Plugin installation channel.
