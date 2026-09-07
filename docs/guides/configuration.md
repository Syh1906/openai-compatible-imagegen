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
| `protocol` | `openai-compatible` (default) or `atlas` |
| `base_url` | Base URL for the selected image service |
| `model` | Provider-specific image model ID; any non-empty ID accepted |
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

Start in the conversation, for example: “Configure OpenAI-Compatible Images for this project using the ChatGPT route.” For API Key, provide the service URL, model ID, and credential environment variable name, without sending the key value in chat. Codex creates missing configuration, preserves existing settings, and returns a redacted summary.

For manual setup, use `skills/openai-compatible-imagegen/references/config.example.json` in the installed Plugin. Its proxy is an example; remove `proxy` to retain environment proxy behavior.

An API Key user baseline declares the active profile, provider, provider-specific model ID, authentication, defaults, transparency policy, resource limits, and storage. A ChatGPT-only baseline may omit the active profile, providers, and models. Prefer an environment variable for API credentials.

Set `auth_mode` to choose the default image route:

```json
{
  "config_version": 1,
  "auth_mode": "chatgpt",
  "defaults": { "size": "1536x1024", "quality": "auto", "output_format": "png" },
  "postprocess": { "enabled": true },
  "storage": { "output_directory": "output/imagegen" }
}
```

Use `"apikey"` for the configured image API provider, or `"chatgpt"` for host generation and semantic canvas edits through the Codex App. ChatGPT projects may omit provider and model fields. Both routes accept canvas mask annotations as edit guidance. API Key editing requires a model that supports edits; Atlas supports generation only. A dedicated mask parameter is used when the selected API model declares that capability; otherwise marked regions remain semantic guidance. The selected image model determines how closely the result follows the guidance. API Key projects can also request batches and multiple candidates. The route is selected explicitly and is not changed automatically when another route is unavailable.

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

### Check and change configuration

After initialization, API Key users set the variable named by `api_key_env` in the environment used to launch Codex; ChatGPT needs no API credential. Ask Codex to check the configuration with `inspect_image_config` and bind this project. To change settings, describe the new values; Codex applies them with `update_image_config` and refreshes the project binding. A new task is not required.

Configuration tools never return keys. Writes protect user and project configuration directories with a `.gitignore` containing only `*`, without changing the project root ignore file. Local plaintext credentials can be stored only in user configuration when explicitly chosen.

`storage.output_directory` is a relative directory inside the project. The default is `output/imagegen/`. Project binding creates or verifies a `.gitignore` containing only `*` in the resolved output directory, so images, prompts, annotations, and metadata remain local. An incompatible ignore rule stops binding without being overwritten. Absolute paths, project-root output, outside paths, files, symbolic links, junctions, and other reparse points are rejected.

## Configure Atlas Cloud

Atlas Cloud is an optional API Key provider for text-to-image generation. A Standalone `auth.json` can use:

```json
{
  "protocol": "atlas",
  "base_url": "https://api.atlascloud.ai",
  "api_key_env": "ATLASCLOUD_API_KEY",
  "model": "openai/gpt-image-2/text-to-image",
  "capabilities": {
    "generate": true,
    "edit": false,
    "mask": false,
    "multi_reference": false
  },
  "defaults": {
    "size": "1024x1024",
    "quality": "medium",
    "output_format": "png"
  }
}
```

For the Codex Plugin, configure the same provider and model in the user baseline:

```json
{
  "config_version": 1,
  "auth_mode": "apikey",
  "active_profile": "primary/gpt-image-2",
  "providers": {
    "primary": {
      "protocol": "atlas",
      "base_url": "https://api.atlascloud.ai",
      "api_key_env": "ATLASCLOUD_API_KEY"
    }
  },
  "models": {
    "primary/gpt-image-2": {
      "provider": "primary",
      "model": "openai/gpt-image-2/text-to-image",
      "capabilities": {
        "generate": true,
        "edit": false,
        "mask": false,
        "multi_reference": false
      }
    }
  },
  "defaults": { "size": "1024x1024", "quality": "medium", "output_format": "png" },
  "postprocess": { "enabled": false },
  "transparency": { "default_route": "chroma-matting" },
  "storage": { "output_directory": "output/imagegen" }
}
```

Set `ATLASCLOUD_API_KEY` in the environment before generation.

## Image service requirements

The default `openai-compatible` protocol uses these endpoints. The service and selected model must support the operations you need:

- `POST /v1/images/generations` — generation
- `POST /v1/images/edits` — editing, when needed

Responses may return `data[].b64_json` or `data[].url`. The runtime does not forward the image API credential when it downloads a returned URL.

The Atlas protocol supports text-to-image generation with JPEG or PNG output. It does not support edits or native transparency; choose local transparency processing when needed.

## Transparency settings

New OpenAI-compatible API Key templates enable native transparency. Installation and updates preserve existing configuration. To enable it in an older configuration, ask Codex to merge these settings. ChatGPT does not use these provider parameters; Atlas requires a local transparency route.

```json
{
  "transparency": {
    "default_route": "native-alpha",
    "native": {
      "enabled": true,
      "retry_without_parameter": true,
      "fallback_route": "chroma-matting"
    }
  }
}
```

Transparency is delivery intent. For `native-alpha`, the runtime sends `background=transparent` and PNG output only when transparency is requested, with a real-alpha prompt contract. The optional `transparency.native.model_ids` list is a capability declaration, not a code whitelist; an explicit native route is sent to the configured model even when the list is empty or does not contain that ID. A transparency-related provider HTTP 400/422 is retried once without the parameter by default, using the same model and endpoint, then the configured local fallback route is applied. Set `retry_without_parameter` to `false` to disable this retry. Results explain rejection, retry, final route, and QA. Legacy `transparent_background` configuration is rejected during migration.

Standalone has two native-transparency limitations: a successful native request that returns an opaque image is reported as unmet, while the Plugin can attempt local fallback; and after native-parameter rejection, Standalone's enabled retry selects local fallback even with `--no-postprocess`. If local pixel changes are forbidden, disable `transparency.native.retry_without_parameter` before making a native request.

## Configuration result

- Plugin: ask Codex to inspect the redacted summary and refresh the project binding in the current task. Confirm the route, API model when applicable, delivery settings, and output directory.
- Standalone: the `info` command above reports the configured model and settings from the installed Skill directory.

Use [troubleshooting](./troubleshooting.md) if a check fails.
