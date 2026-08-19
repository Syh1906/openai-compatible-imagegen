<!-- updated: 2026-08-19 -->
# Installation

> Parent: [User guides](./README.md)

Language: [简体中文](./installation.zh-CN.md)

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
- Python 3.12 or newer
- An OpenAI-compatible image service and your own credential

The Plugin includes its prebuilt MCP server and widget. You do not run `npm install`, build the repository, or start a local web server. The same Plugin archive supports Windows, macOS, and Linux.

The `codex plugin` commands below are identical in Windows PowerShell, macOS Terminal, and a Linux shell. Platform-specific examples are separated only when paths or system utilities differ.

The runtime selects `python` on Windows and `python3` on macOS/Linux. It requires Python 3.12 or newer. To select one explicit executable, set `OPENAI_COMPATIBLE_IMAGEGEN_PYTHON`; an invalid override or failed version preflight stops the operation and does not try another command. macOS/Linux do not expose the Windows **Show in folder** action, while generation, editing, artifacts, annotations, and canvas operations remain available.

### Steps

1. Add the repository marketplace:

```text
codex plugin marketplace add Syh1906/openai-compatible-imagegen
```

2. Install the Plugin:

```text
codex plugin add openai-compatible-imagegen@openai-compatible-imagegen
```

3. Alternatively, open **Plugins** in Codex App or enter `/plugins` in an interactive Codex CLI session, select the `openai-compatible-imagegen` marketplace, and install **OpenAI-Compatible Images**.
4. Confirm the installed version with `codex plugin list --json`.
5. Start a new task after installation.
6. Continue with [Plugin configuration](./configuration.md#configure-the-codex-plugin).

The first configuration can also be created from a new task by asking the Agent to call `initialize_image_config`. Use `inspect_image_config` to review the redacted result and `update_image_config` for supported changes; the Plugin installation directory and Skill directory do not contain the user configuration.

### Install from the Plugin ZIP

Use this route when you want to install a specific GitHub Release from its downloaded Plugin archive instead of the Git-backed marketplace.

1. Download these two files from the same GitHub Release:
   - `openai-compatible-imagegen-codex-plugin-<version>.zip`
   - `SHA256SUMS`
2. Calculate the ZIP's SHA-256 digest and compare it with the matching line in `SHA256SUMS`.

   PowerShell:

   ```powershell
   (Get-FileHash -Algorithm SHA256 -LiteralPath "openai-compatible-imagegen-codex-plugin-<version>.zip").Hash.ToLowerInvariant()
   ```

   macOS Terminal:

   ```bash
   shasum -a 256 openai-compatible-imagegen-codex-plugin-<version>.zip
   ```

   Linux shell:

   ```bash
   sha256sum openai-compatible-imagegen-codex-plugin-<version>.zip
   ```

3. Extract the ZIP. The extracted `openai-compatible-imagegen` directory must contain both `.codex-plugin/plugin.json` and `.agents/plugins/marketplace.json`.
4. Add the extracted directory as a local marketplace with the path format for the current platform.

   Windows PowerShell:

   ```powershell
   codex plugin marketplace add "C:/path/to/openai-compatible-imagegen"
   ```

   macOS or Linux shell:

   ```bash
   codex plugin marketplace add "/absolute/path/to/openai-compatible-imagegen"
   ```

5. Install the Plugin from that marketplace:

   ```text
   codex plugin add openai-compatible-imagegen@openai-compatible-imagegen
   ```

6. Confirm the installed version with `codex plugin list --json`, then start a new task.
7. Continue with [Plugin configuration](./configuration.md#configure-the-codex-plugin).

Codex installs plugins from marketplace directories, not directly from ZIP files. Keep the extracted directory while this local marketplace remains configured. The Git-backed marketplace remains the recommended route for normal updates.

### Agent handoff

Give an Agent this task when you want it to prepare the supported install without changing global runtimes:

```text
Install OpenAI-Compatible Images as a Codex Plugin from the Git-backed marketplace
Syh1906/openai-compatible-imagegen. Verify Git, Node.js 20+, and Python 3.12 or newer first.
Do not install global dependencies or build the repository. Stop before entering or moving credentials.
```

## Install the Standalone Skill

### Requirements

- Python 3.12 or newer
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

### Install with the third-party Skills CLI

The `skills` package is a third-party Agent Skills CLI, not an OpenAI or Codex command. Use it only with the extracted Standalone archive. Choose the installation scope before running it:

| Scope | Availability | Installed copy |
| --- | --- | --- |
| Project (default) | Current project | `<project>/.agents/skills/openai-compatible-imagegen` |
| User (`--global`) | Current user across projects | `~/.agents/skills/openai-compatible-imagegen` |

For a project installation, run the matching command from the target project.

Windows PowerShell:

```powershell
npx --yes skills@latest add "C:/path/to/openai-compatible-imagegen" --agent codex --skill openai-compatible-imagegen --copy --yes
```

macOS or Linux shell:

```text
npx --yes skills@latest add /path/to/openai-compatible-imagegen --agent codex --skill openai-compatible-imagegen --copy --yes
```

For a user installation, add `--global`.

Windows PowerShell:

```powershell
npx --yes skills@latest add "C:/path/to/openai-compatible-imagegen" --global --agent codex --skill openai-compatible-imagegen --copy --yes
```

macOS or Linux shell:

```text
npx --yes skills@latest add /path/to/openai-compatible-imagegen --global --agent codex --skill openai-compatible-imagegen --copy --yes
```

The source directory must contain `SKILL.md` at its root together with `scripts/`, `references/`, `examples/`, and `agents/`. Do not pass the repository root. A repository-root install copies Plugin, MCP, Widget, test, and documentation files into the Skill target.

Both commands use `skills@latest` so new installations receive the current CLI. A project installation creates `skills-lock.json` in the project; a user installation does not create that project lock file.

Use this CLI route only for the first installation. Local copied installs have these maintenance limits:

- `skills update` does not update a Skill copied from a local extracted directory at either scope.
- Running `skills add` again replaces the installed directory and removes its local `auth.json`.
- Output files outside the installed Skill directory are not managed by these CLI operations.

For an update, follow [Update the Plugin or Skill](./updating.md). For a rollback, preserve the current installation and `auth.json`, extract the target version to a new directory, and follow the [Standalone rollback flow](./rollback.md#roll-back-the-standalone-skill). Keep generated outputs outside the installed Skill directory.

## Installation result

| Check | Standalone Skill | Codex Plugin |
| --- | --- | --- |
| Package identity | `SKILL.md` at install root | `.codex-plugin/plugin.json` at install root |
| Runtime entry | `scripts/imagegen.py` | `dist/server.mjs` through `.mcp.json` |
| UI | Host conversation only | Result cards and focused canvas in Codex App |
| Configuration | Installed directory `auth.json` | User and optional project `config.json` |

Public Plugins Directory availability is separate from this Git-backed release channel.

Each GitHub Release also provides `openai-compatible-imagegen-codex-plugin-<version>.zip` for version-pinned local installation, offline inspection, archive, and rollback. Verify downloaded archives against the release's `SHA256SUMS`. The Git-backed marketplace remains the normal Plugin installation channel.
