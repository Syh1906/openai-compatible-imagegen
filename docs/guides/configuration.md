# Configuration

> Parent: [User guides](./README.md)

Configure only the package you installed. The Standalone Skill and Codex Plugin do not scan, merge, or fall back to each other's configuration.

## Configure the Standalone Skill

The Standalone Skill reads `auth.json` from its installed directory.

1. Run the setup wizard from the installed Skill:

```powershell
python "<skill-root>/scripts/quick-init.py"
```

2. Or copy `examples/auth.example.json` to `<skill-root>/auth.json` and set:

| Field | Purpose |
| --- | --- |
| `base_url` | Base URL for the OpenAI-compatible service |
| `model` | Default image model |
| `api_key_env` | Preferred environment variable containing the credential |
| `api_key` | Optional local plaintext credential when explicitly chosen |

3. Inspect the redacted effective configuration:

```powershell
python "<skill-root>/scripts/imagegen.py" info
```

Command flags override `auth.json` defaults. Per-row JSONL fields override shared batch flags.

`url_download.proxy_mode` defaults to the environment proxy. If provider-returned image URLs repeatedly fail with TLS EOF through that proxy, approve one direct download with `--allow-direct-url-download`. Set the persistent mode to `direct` only after approving that provider's URL route. This setting affects returned image downloads, not image API requests, and the runtime never sends the API key to a returned URL.

## Configure the Codex Plugin

The Plugin reads these fixed paths:

| Scope | Path | Required |
| --- | --- | --- |
| User baseline | `~/.codex/openai-compatible-imagegen/config.json` | Yes |
| Project overrides | `<project>/.codex/openai-compatible-imagegen/config.json` | No |

Start from `skills/openai-compatible-imagegen/references/config.example.json` in the installed Plugin.

The user baseline declares the active profile, provider, model, authentication, defaults, transparency policy, resource limits, and storage. Prefer an environment variable for the credential.

The project file may override only:

- `defaults.size`
- `defaults.quality`
- `defaults.output_format`
- `storage.output_directory`

The project file cannot replace the active profile, provider, model, endpoint, authentication source, credential environment variable, timeout, concurrency, or route permissions. A rejected override stops before a network request.

### Configure through MCP

The Codex Plugin exposes three configuration tools so an Agent can complete the setup without locating the Plugin installation directory:

- `initialize_image_config` creates the user template at `~/.codex/openai-compatible-imagegen/config.json` only when the file does not exist. When called with `projectRoot`, it also adds `.codex/openai-compatible-imagegen/config.json` to that project's `.gitignore` exactly once.
- `inspect_image_config` reads the user file and an optional project override as redacted data. It never returns `api_key` values.
- `update_image_config` updates a user or project file through the same schema and scope rules as runtime binding. It rejects credentials and forbidden project fields.

After initialization, set the environment variable named by `providers.primary.api_key_env`, then ask the Agent to query the configuration and bind the project. The user baseline lives outside Git; if a project override is used, initialize with the project root so its local file is ignored. After any update, bind the project again so the new configuration digest is used. The tools do not accept, read, or print API keys.

`storage.output_directory` is a relative directory inside the project. The default is `output/imagegen/`. Absolute paths, project-root output, outside paths, files, symbolic links, junctions, and other reparse points are rejected.

## Backend contract

The configured service must expose:

- `POST /v1/images/generations`
- `POST /v1/images/edits`

Responses may return `data[].b64_json` or `data[].url`. The runtime does not forward the image API credential when it downloads a returned URL.

Transparency is delivery intent. Neither package sends `background=transparent` to the image API, and legacy `transparent_background` configuration is rejected during migration.

## Configuration result

After configuration, start a new task and ask the Agent to list configured image models or inspect the redacted runtime summary. Do not paste credentials into the conversation.
