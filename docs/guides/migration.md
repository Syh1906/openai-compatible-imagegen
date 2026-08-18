<!-- updated: 2026-08-19 -->
# Migration

> Parent: [User guides](./README.md)

Language: [简体中文](./migration.zh-CN.md)

Migration to the Codex Plugin is explicit. The Plugin does not scan, copy, merge, delete, or overwrite an older Standalone or Plugin configuration.

## Supported sources

| Source | `--source-kind` | Project overrides |
| --- | --- | --- |
| Standalone `auth.json` | `standalone` | No |
| Earlier Codex Plugin config | `development-plugin` (compatibility value) | Optional, allowlisted fields only |

## Preview the migration

Run a redacted dry run from the installed Plugin root:

```powershell
python "<plugin-root>/dist/scripts/migrate_image_config.py" `
  --source "<legacy-config>" `
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

Use the same inputs and the reviewed digest:

```powershell
python "<plugin-root>/dist/scripts/migrate_image_config.py" `
  --source "<legacy-config>" `
  --source-kind standalone `
  --write `
  --expected-source-sha256 "<sourceSha256>"
```

Environment-variable authentication migrates by default. Migrating a usable plaintext key requires explicit approval and `--allow-plaintext-api-key` on the write command.

## Migration result

The source remains unchanged. Before writing each target, migration creates or verifies a `.gitignore` containing only `*` in that target configuration directory. Migration stops without overwriting an incompatible ignore rule if the source digest changed, a target already exists, the schema or model is unsupported, an obsolete field remains, or a write fails. The project does not provide automatic Plugin-to-Standalone migration.
