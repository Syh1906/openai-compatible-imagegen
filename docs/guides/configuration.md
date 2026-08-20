<!-- updated: 2026-08-20 -->
# Configuration

> Parent: [User guides](./README.md)

Language: [简体中文](./configuration.zh-CN.md)

Configure only the package you installed. The Standalone Skill and Codex Plugin do not scan, merge, or fall back to each other's configuration.

## Configure the Standalone Skill

The Standalone Skill reads `auth.json` from its installed directory.

1. Run the setup wizard from the installed Skill with the command for the current platform.

Windows PowerShell:

```powershell
python "C:/path/to/openai-compatible-imagegen/scripts/quick-init.py"
```

macOS or Linux shell:

```bash
python3 "/absolute/path/to/openai-compatible-imagegen/scripts/quick-init.py"
```

2. Or copy `examples/auth.example.json` to `<skill-root>/auth.json` and set:

| Field | Purpose |
| --- | --- |
| `base_url` | Base URL for the OpenAI-compatible service |
| `model` | Default image model |
| `api_key_env` | Preferred environment variable containing the credential |
| `api_key` | Optional local plaintext credential when explicitly chosen |

3. Inspect the redacted effective configuration with the same platform mapping.

Windows PowerShell:

```powershell
python "C:/path/to/openai-compatible-imagegen/scripts/imagegen.py" info
```

macOS or Linux shell:

```bash
python3 "/absolute/path/to/openai-compatible-imagegen/scripts/imagegen.py" info
```

Command flags override `auth.json` defaults. Per-row JSONL fields override shared batch flags.

### Configure a provider proxy

Leave `proxy` absent to keep the environment proxy behavior. To route this provider through a specific HTTP proxy and port, add this object to `auth.json`:

```json
{
  "proxy": {
    "url": "http://127.0.0.1:7890"
  }
}
```

The configured proxy handles generation requests, edit requests, and provider-returned image URL downloads. `proxy.url` must be a complete `http://` or `https://` URL with a host; an explicit port must be valid. SOCKS URLs, credentials, paths, queries, fragments, and control characters are rejected.

`url_download.proxy_mode` defaults to `environment`. In that mode, downloads use `proxy.url` when configured and otherwise use the environment proxy. If provider-returned image URLs repeatedly fail with TLS EOF, approve one direct download with `--allow-direct-url-download`. Set the persistent mode to `direct` only after approving that provider's URL route. Direct mode overrides the configured proxy only for returned image downloads; generation and edit requests continue through `proxy.url`.

A failed configured proxy request stops with its original network error. The runtime does not retry through the environment proxy or a direct connection, and it does not expose the proxy URL in the redacted configuration summary or public error details.

## Configure the Codex Plugin

The Plugin reads these fixed paths:

| Scope | Path | Required |
| --- | --- | --- |
| User baseline | `~/.codex/openai-compatible-imagegen/config.json` | Yes |
| Project overrides | `<project>/.codex/openai-compatible-imagegen/config.json` | No |

Start from `skills/openai-compatible-imagegen/references/config.example.json` in the installed Plugin. Its `proxy` object demonstrates the optional provider proxy; remove that object to retain environment proxy behavior.

The user baseline declares the active profile, provider, model, authentication, defaults, transparency policy, resource limits, and storage. Prefer an environment variable for the credential.

To route one Plugin provider through a specific proxy, add `proxy` to that provider in the user baseline:

```json
{
  "providers": {
    "primary": {
      "proxy": {
        "url": "http://127.0.0.1:7890"
      }
    }
  }
}
```

The same proxy validation and request routing apply to both packages. Plugin project configuration cannot declare or override `proxy`. After changing a user-level proxy, bind the project again so the runtime uses the new configuration digest. Configuration inspection reports only whether a proxy is configured, not its URL.

The project file may override only:

- `defaults.size`
- `defaults.quality`
- `defaults.output_format`
- `storage.output_directory`

The project file cannot replace the active profile, provider, model, endpoint, proxy, authentication source, credential environment variable, timeout, concurrency, or route permissions. A rejected override stops before a network request.

### Configure through MCP

The Codex Plugin exposes three configuration tools so an Agent can complete the setup without locating the Plugin installation directory:

- `initialize_image_config` creates the user template at `~/.codex/openai-compatible-imagegen/config.json` only when the file does not exist. It always creates or verifies a `.gitignore` containing only `*` in the user configuration directory. When called with `projectRoot`, it protects the project configuration directory the same way; the project root `.gitignore` is not changed.
- `inspect_image_config` reads the user file and an optional project override as redacted data. It never returns `api_key` values.
- `update_image_config` updates a user or project file through the same schema and scope rules as runtime binding. Before writing, it creates or verifies the target configuration directory's local `*` ignore rule. Prefer `api_key_env`; when a user explicitly chooses local plaintext storage, the tool may write user-level `api_key` but never returns it. Project credentials and forbidden project fields are rejected.

After initialization, set the environment variable named by `providers.primary.api_key_env`, then ask the Agent to query the configuration and bind the project. Both user and project configuration directories are protected at every configuration write. After any update, bind the project again so the new configuration digest is used. Query and update results never print API keys.

`storage.output_directory` is a relative directory inside the project. The default is `output/imagegen/`. Project binding creates or verifies a `.gitignore` containing only `*` in the resolved output directory, so images, prompts, annotations, and metadata remain local. An incompatible ignore rule stops binding without being overwritten. Absolute paths, project-root output, outside paths, files, symbolic links, junctions, and other reparse points are rejected.

## Backend contract

The configured service must expose:

- `POST /v1/images/generations`
- `POST /v1/images/edits`

Responses may return `data[].b64_json` or `data[].url`. The runtime does not forward the image API credential when it downloads a returned URL.

Transparency is delivery intent. Neither package sends `background=transparent` to the image API, and legacy `transparent_background` configuration is rejected during migration.

## Configuration result

After configuration, start a new task and ask the Agent to list configured image models or inspect the redacted runtime summary. Do not paste credentials into the conversation.
