<!-- updated: 2026-08-21 -->
# Update the Plugin or Skill

> Parent: [User guides](./README.md)

Language: [简体中文](./updating.zh-CN.md)

Use this guide to move an existing installation to a newer Git revision or released version. Updating the package does not rewrite image-service credentials, user configuration, or generated artifacts.

## Before you update

- Choose the update channel. The Git marketplace follows the repository's default branch, while Release ZIP files provide fixed versions.
- For a fixed version, read the target release notes for breaking configuration changes.
- Keep the current installation and local configuration until the new version passes its smoke check.
- Download release ZIP files and `SHA256SUMS` from the same GitHub Release when you need a fixed local package.

## Migrate transparency settings

New configurations enable native transparency by default. Updates preserve an existing `config.json` so that an upgrade does not silently change image routing. After updating, call `inspect_image_config`; if it warns that `transparency.native` is missing, use `update_image_config` to set `transparency.default_route` to `native-alpha` and `transparency.native.enabled` to `true`.

The default `transparency.native.retry_without_parameter` value is `true`. Set it to `false` only when you want a provider rejection to stop without a second request. In either case, the final image result reports whether the native parameter was sent, whether a retry occurred, and which route produced the result.

After changing configuration, rebind the project and run `inspect_image_config` again. Keep the previous installation and configuration until this check succeeds.

## Update a Git marketplace Plugin

When the Plugin system starts, Codex checks configured Git marketplaces. If this repository's default branch (`main`) has a new revision, Codex refreshes the marketplace snapshot and the installed Plugin cache. Run the marketplace upgrade command when you need to check immediately instead of waiting for the next startup.

The `codex plugin` lifecycle commands below are identical in Windows PowerShell, macOS Terminal, and a Linux shell. Only local paths and platform utilities differ.

1. Check for a new marketplace revision:

   ```text
   codex plugin marketplace upgrade openai-compatible-imagegen --json
   ```

2. Confirm the installed Plugin:

   ```text
   codex plugin list --json
   ```

3. Completely quit and restart Codex once, then start a new task or CLI session. The restart loads the updated Skill, MCP tools, and bundled dependencies.

Do not remove and add the Plugin during a normal Git marketplace update. Use the Plugin ZIP or [Rollback](./rollback.md) route when you need a fixed release, archived build, different source, tag, or branch.

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
