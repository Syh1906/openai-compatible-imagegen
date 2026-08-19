<!-- updated: 2026-08-19 -->
# Update the Plugin or Skill

> Parent: [User guides](./README.md)

Language: [简体中文](./updating.zh-CN.md)

Use this guide to move an existing installation to a newer released version. Updating the package does not rewrite image-service credentials, user configuration, or generated artifacts.

## Before you update

- Read the target release notes for breaking configuration changes.
- Keep the current installation and local configuration until the new version passes its smoke check.
- Download release ZIP files and `SHA256SUMS` from the same GitHub Release when you need a fixed local package.

## Update a Git marketplace Plugin

The marketplace command refreshes the configured Git snapshot. It is not a separate `plugin update` command and does not replace the installed Plugin by itself.

The `codex plugin` lifecycle commands below are identical in Windows PowerShell, macOS Terminal, and a Linux shell. Only local paths and platform utilities differ.

1. Refresh the marketplace snapshot:

   ```text
   codex plugin marketplace upgrade openai-compatible-imagegen --json
   ```

2. Replace the installed Plugin from the refreshed snapshot:

   ```text
   codex plugin remove openai-compatible-imagegen@openai-compatible-imagegen --json
   codex plugin add openai-compatible-imagegen@openai-compatible-imagegen --json
   ```

3. Confirm the installed version:

   ```text
   codex plugin list --json
   ```

4. Start a new task in Codex App or a new CLI session before using the updated Skill or MCP tools. [OpenAI's official Plugin documentation](https://developers.openai.com/codex/plugins) requires a new chat or CLI session after installation.

If the marketplace source itself changed, remove and add the marketplace again before step 2. Do not use `--ref` unless you intentionally want a tag or branch snapshot.

## Update from a Plugin ZIP

Use this route for an offline, pinned, or archived version.

1. Download `openai-compatible-imagegen-codex-plugin-<version>.zip` and `SHA256SUMS` from the same [GitHub Release](https://github.com/Syh1906/openai-compatible-imagegen/releases).
2. Verify the ZIP digest with the command for the current platform.

   Windows PowerShell:

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

3. Extract the archive to a new version-specific directory. Keep the previous directory until the new one is confirmed.
4. Remove the old Plugin and local marketplace:

   ```text
   codex plugin remove openai-compatible-imagegen@openai-compatible-imagegen --json
   codex plugin marketplace remove openai-compatible-imagegen --json
   ```

5. Add the extracted directory with the path format for the current platform.

   Windows PowerShell:

   ```powershell
   codex plugin marketplace add "C:/path/to/openai-compatible-imagegen" --json
   ```

   macOS or Linux shell:

   ```bash
   codex plugin marketplace add "/absolute/path/to/openai-compatible-imagegen" --json
   ```

6. Install and verify the Plugin:

   ```text
   codex plugin add openai-compatible-imagegen@openai-compatible-imagegen --json
   codex plugin list --json
   ```

7. Start a new task. Keep the extracted directory while the local marketplace is configured to use it.

The local marketplace route is independent from the Git marketplace route. A Git marketplace upgrade does not replace a marketplace whose source is an extracted local directory.

## Update a Standalone Skill

Standalone packages are copied into a client-owned Skill directory. The third-party `skills` CLI does not update a copied local source.

1. Download the new `openai-compatible-imagegen-skill-<version>.zip` and `SHA256SUMS` from the same [GitHub Release](https://github.com/Syh1906/openai-compatible-imagegen/releases).
2. Verify the Skill ZIP with the command for the current platform.

   Windows PowerShell:

   ```powershell
   (Get-FileHash -Algorithm SHA256 -LiteralPath "openai-compatible-imagegen-skill-<version>.zip").Hash.ToLowerInvariant()
   ```

   macOS Terminal:

   ```bash
   shasum -a 256 openai-compatible-imagegen-skill-<version>.zip
   ```

   Linux shell:

   ```bash
   sha256sum openai-compatible-imagegen-skill-<version>.zip
   ```

3. Extract it to a new version-specific directory. Confirm that `SKILL.md` is at the extracted package root.
4. Copy the existing `auth.json` to the new directory only after checking that the target release accepts the same configuration. Never commit or paste its secret values.
5. Point the client at the new directory. For a direct installation, replace the client path only after the new copy is ready.
6. Run the bundled smoke check with the platform's Python command.

   Windows PowerShell:

   ```powershell
   python "C:/path/to/openai-compatible-imagegen/scripts/imagegen.py" info
   ```

   macOS or Linux shell:

   ```bash
   python3 "/absolute/path/to/openai-compatible-imagegen/scripts/imagegen.py" info
   ```

7. Start a new task or session so the client reloads `SKILL.md`.

Do not use `skills update` for a local copied archive. Do not run `skills add` again as an update shortcut: it can replace the installed directory and delete its local `auth.json`. Keep generated images and manifests outside the Skill directory.

## Verify and recover

- Plugin: `codex plugin list --json` reports the expected version and the new task exposes the Plugin tools.
- Standalone: `imagegen.py info` resolves `script_path` and `auth_json` inside the new Skill directory.
- If the smoke check fails, restore the previous directory and follow [Rollback](./rollback.md).

## Related guides

- [Installation](./installation.md)
- [Rollback](./rollback.md)
- [Troubleshooting](./troubleshooting.md)
