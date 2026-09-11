# Migration

> Parent: [User guides](./README.md)

Language: [简体中文](./migration.zh-CN.md)

Migration to the Codex Plugin is explicit. The Plugin does not scan, copy, merge, delete, or overwrite an older Standalone or Plugin configuration.

## Supported sources

| Source | `--source-kind` | Project overrides |
| --- | --- | --- |
| Standalone `auth.json` | `standalone` | No |
| Current Plugin v1 to v2 | `plugin-v1` | No; writes a new user configuration |
| Earlier Codex Plugin config | `development-plugin` (compatibility value) | Optional, allowlisted fields only |

## Preview the migration

For a current Plugin v1 configuration, follow [Upgrade a v1 configuration](#upgrade-a-v1-configuration) below. Use the commands in this section for other supported sources.

Run a redacted dry run with the command for the current platform.

Windows PowerShell:

```powershell
python "C:/path/to/openai-compatible-imagegen/dist/scripts/migrate_image_config.py" `
  --source "C:/path/to/legacy/auth.json" `
  --source-kind standalone
```

macOS or Linux shell:

```bash
python3 "/absolute/path/to/openai-compatible-imagegen/dist/scripts/migrate_image_config.py" \
  --source "/absolute/path/to/legacy/auth.json" \
  --source-kind standalone
```

For an earlier Codex Plugin configuration, pass `--source-kind development-plugin`. The value is retained only for command compatibility. Add both `--include-project-overrides` and `--project-root "<project-root>"` only when you also want its allowed project defaults.

Review these fields:

| Field | Meaning |
| --- | --- |
| `sourceKind` | Interpreted source format |
| `sourceSha256` | Digest that binds the reviewed source |
| `readyToWrite` | Whether the target can be written without overwrite |
| Target paths | User and optional project configuration destinations |
| Redacted preview | Values that will be written, without credential disclosure |

## Write the migration

Use the same inputs and the reviewed digest.

Windows PowerShell:

```powershell
python "C:/path/to/openai-compatible-imagegen/dist/scripts/migrate_image_config.py" `
  --source "C:/path/to/legacy/auth.json" `
  --source-kind standalone `
  --write `
  --expected-source-sha256 "<sourceSha256>"
```

macOS or Linux shell:

```bash
python3 "/absolute/path/to/openai-compatible-imagegen/dist/scripts/migrate_image_config.py" \
  --source "/absolute/path/to/legacy/auth.json" \
  --source-kind standalone \
  --write \
  --expected-source-sha256 "<sourceSha256>"
```

Environment-variable authentication migrates by default. Migrating a usable plaintext key requires explicit approval and `--allow-plaintext-api-key` on the write command.

## Migration result

The source remains unchanged. Migration preserves non-empty provider model IDs, including custom aliases; it does not restrict them to standard OpenAI model names or verify provider availability. Before writing each target, migration creates or verifies a `.gitignore` containing only `*` in that target configuration directory. Migration stops without overwriting an incompatible ignore rule if the source digest changed, a target already exists, the schema or legacy profile structure is unsupported, the model ID is invalid, an obsolete field remains, or a write fails. The project does not provide automatic Plugin-to-Standalone migration.

## Upgrade a v1 configuration

Existing v1 configurations remain supported. To use v2 per-model defaults, write a new configuration in a separate directory and keep the original. The `--user-home` argument below names an empty staging root; the target is `.codex/openai-compatible-imagegen/config.json` beneath it.

Preview first:

Windows PowerShell:

```powershell
python "C:/path/to/openai-compatible-imagegen/dist/scripts/migrate_image_config.py" `
  --source "C:/path/to/current/config.json" --source-kind plugin-v1 `
  --user-home "C:/path/to/empty-migration-root"
```

macOS or Linux shell:

```bash
python3 "/absolute/path/to/openai-compatible-imagegen/dist/scripts/migrate_image_config.py" \
  --source "/absolute/path/to/current/config.json" --source-kind plugin-v1 \
  --user-home "/absolute/path/to/empty-migration-root"
```

After reviewing `readyToWrite`, the redacted preview, and `sourceSha256`, write with the same source and staging root:

Windows PowerShell:

```powershell
python "C:/path/to/openai-compatible-imagegen/dist/scripts/migrate_image_config.py" `
  --source "C:/path/to/current/config.json" --source-kind plugin-v1 `
  --user-home "C:/path/to/empty-migration-root" `
  --write --expected-source-sha256 "<sourceSha256>"
```

macOS or Linux shell:

```bash
python3 "/absolute/path/to/openai-compatible-imagegen/dist/scripts/migrate_image_config.py" \
  --source "/absolute/path/to/current/config.json" --source-kind plugin-v1 \
  --user-home "/absolute/path/to/empty-migration-root" \
  --write --expected-source-sha256 "<sourceSha256>"
```

Image defaults move to `host_defaults` and the original active model; API transparency policy stays with that active model. Other models do not inherit those settings. Top-level `defaults` retains timeout and concurrency, while top-level transparency and local-processing settings remain intact. ChatGPT-only configurations do not gain API providers.

Credential references are preserved; plaintext-key migration still requires explicit permission and `--allow-plaintext-api-key`. Check the new file, keep a backup of the old configuration, replace the actual user configuration, and rebind the project. An existing target or a changed source stops migration; inspect the error without overwriting the source.
