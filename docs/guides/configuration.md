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

`storage.output_directory` is a relative directory inside the project. The default is `output/imagegen/`. Absolute paths, project-root output, outside paths, files, symbolic links, junctions, and other reparse points are rejected.

## Backend contract

The configured service must expose:

- `POST /v1/images/generations`
- `POST /v1/images/edits`

Responses may return `data[].b64_json` or `data[].url`. The runtime does not forward the image API credential when it downloads a returned URL.

Transparency is delivery intent. Neither package sends `background=transparent` to the image API, and legacy `transparent_background` configuration is rejected during migration.

## Configuration result

After configuration, start a new task and ask the Agent to list configured image models or inspect the redacted runtime summary. Do not paste credentials into the conversation.
