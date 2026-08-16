<!-- updated: 2026-08-16 -->

# Rollback

Rollback changes the installed package version. It does not downgrade or rewrite your image-service configuration automatically.

## Roll back the Codex Plugin

1. Record the current Plugin version and the released tag you want to restore.
2. Uninstall the Plugin from the Codex App Plugins page or CLI `/plugins` browser.
3. Remove the current marketplace source:

```text
codex plugin marketplace remove openai-compatible-imagegen
```

4. Add the repository marketplace pinned to the released tag:

```text
codex plugin marketplace add Syh1906/openai-compatible-imagegen@vX.Y.Z
```

5. Reopen the Plugins page or `/plugins` browser and install **OpenAI-Compatible Images** from that marketplace snapshot.
6. Start a new task and confirm the installed version before using image tools.

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
