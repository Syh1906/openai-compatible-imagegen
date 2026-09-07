# Rollback

> Parent: [User guides](./README.md)

Language: [简体中文](./rollback.zh-CN.md)

Rollback changes the installed package version. It does not downgrade or rewrite your image-service configuration automatically. For a normal forward update, use [Update the Plugin or Skill](./updating.md).

The `codex plugin` rollback commands are identical in Windows PowerShell, macOS Terminal, and a Linux shell.

## Roll back the Codex Plugin

1. Record the current Plugin version with `codex plugin list --json` and choose the released tag you want to restore.
2. Remove the installed Plugin:

```text
codex plugin remove openai-compatible-imagegen@openai-compatible-imagegen --json
```

3. Remove the current marketplace source:

```text
codex plugin marketplace remove openai-compatible-imagegen --json
```

4. Add the repository marketplace pinned to the released tag:

```text
codex plugin marketplace add Syh1906/openai-compatible-imagegen --ref vX.Y.Z --json
```

5. Install **OpenAI-Compatible Images** from that marketplace snapshot:

```text
codex plugin add openai-compatible-imagegen@openai-compatible-imagegen --json
```

6. Confirm the installed version with `codex plugin list --json`, then completely quit and restart Codex before using image tools.

Do not use an unreleased commit as a rollback target. A Plugin version can read only configuration compatible with that release; consult the target release notes before reusing a newer config.

## Roll back the Standalone Skill

1. Download the target Skill ZIP and `SHA256SUMS` from the same GitHub Release and [verify the digest](./updating.md#update-a-standalone-skill).
2. Extract it to a new version-specific directory.
3. Prepare a compatible `auth.json` in the restored directory, following that release's configuration guide. Run `imagegen.py info` using the [platform command in the update guide](./updating.md#update-a-standalone-skill); preserve the current installation and configuration until it passes.
4. Switch the client to the restored Skill directory.
5. Start a new task or session.

Do not use `skills update`, repeated `skills add`, or `skills remove` as a configuration-preserving version switch for a local copied install. Do not copy newer configuration fields into the older package unless that release documents them.

## Rollback result

For Plugin, `codex plugin list --json` reports the selected version. For Standalone, `info` points to the directory extracted from the verified versioned archive. Existing image artifacts remain local and are not deleted by package rollback.
