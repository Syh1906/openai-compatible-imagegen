# Rollback

> Parent: [User guides](./README.md)

Rollback changes the installed package version. It does not downgrade or rewrite your image-service configuration automatically.

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

6. Confirm the installed version with `codex plugin list --json`, then start a new task before using image tools.

Do not use an unreleased commit as a rollback target. A Plugin version can read only configuration compatible with that release; consult the target release notes before reusing a newer config.

## Roll back the Standalone Skill

1. Download the requested versioned Skill ZIP from GitHub Releases.
2. Extract it to a new version-specific directory.
3. Preserve the current installation and `auth.json` until the older version passes `info`.
4. Switch the client to the restored Skill directory.
5. Start a new task or session.

Do not copy newer configuration fields into the older package unless that release documents them.

## Rollback result

The active package reports the selected released version. Existing image artifacts remain local and are not deleted by package rollback.
