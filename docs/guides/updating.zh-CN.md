<!-- updated: 2026-08-21 -->
# 更新 Plugin 或 Skill

> 上级：[用户指南](./README.zh-CN.md)

[English](./updating.md) | 简体中文

本指南用于把已有安装更新到较新的 Git revision 或已发布版本。更新发行包不会重写图片服务凭据、用户配置或已生成的产物。

## 更新前检查

- 先选择更新渠道。Git marketplace 跟随仓库默认分支，Release ZIP 提供固定版本。
- 使用固定版本时，阅读目标版本的 release notes，确认配置是否有不兼容变化。
- 在新版本通过冒烟检查前保留当前安装和本地配置。
- 需要固定版本的本地发行包时，从同一个 GitHub Release 下载 ZIP 和 `SHA256SUMS`。

## 迁移透明配置

新配置默认启用原生透明。升级时会保留已有 `config.json`，避免静默改变图片路线。升级后调用 `inspect_image_config`；如果提示缺少 `transparency.native`，使用 `update_image_config` 把 `transparency.default_route` 设为 `native-alpha`，并把 `transparency.native.enabled` 设为 `true`。

`transparency.native.retry_without_parameter` 默认值为 `true`。只有希望供应商拒绝透明参数时直接失败、不发起第二次请求，才把它设为 `false`。无论是否重试，最终图片结果都会说明是否发送原生透明参数、是否发生重试，以及最终采用的路线。

修改配置后重新绑定项目，再次调用 `inspect_image_config`。在检查通过前保留旧安装和旧配置。

## 更新 Git marketplace Plugin

Plugin 系统启动时，Codex 会检查已经配置的 Git marketplace。如果本仓库默认分支 `main` 出现新的 revision，Codex 会刷新 marketplace 快照和已安装 Plugin 的缓存。需要立即检查时，运行 marketplace upgrade 命令，不必等待下一次启动。

下面的 `codex plugin` 生命周期命令在 Windows PowerShell、macOS 终端和 Linux shell 中相同。只有本地路径和平台工具不同。

1. 检查新的 marketplace revision：

   ```text
   codex plugin marketplace upgrade openai-compatible-imagegen --json
   ```

2. 确认已安装 Plugin：

   ```text
   codex plugin list --json
   ```

3. 完全退出并重新启动 Codex 一次，再开始新任务或 CLI 会话。重启后会加载更新后的 Skill、MCP 工具和包内依赖。

日常 Git marketplace 更新不需要删除并重新添加 Plugin。需要固定 Release、归档版本、其他来源、tag 或分支时，改用 Plugin ZIP 或[回滚](./rollback.zh-CN.md)路线。

## 从 Plugin ZIP 更新

离线、固定版本或归档场景使用这条路线。

1. 从同一个 [GitHub Release](https://github.com/Syh1906/openai-compatible-imagegen/releases) 下载 `openai-compatible-imagegen-codex-plugin-<version>.zip` 和 `SHA256SUMS`。
2. 按当前平台校验 ZIP 摘要。

   Windows PowerShell：

   ```powershell
   (Get-FileHash -Algorithm SHA256 -LiteralPath "openai-compatible-imagegen-codex-plugin-<version>.zip").Hash.ToLowerInvariant()
   ```

   macOS 终端：

   ```bash
   shasum -a 256 openai-compatible-imagegen-codex-plugin-<version>.zip
   ```

   Linux shell：

   ```bash
   sha256sum openai-compatible-imagegen-codex-plugin-<version>.zip
   ```

3. 解压到新的版本专用目录。在新目录确认前保留旧目录。
4. 删除旧 Plugin 和本地 marketplace：

   ```text
   codex plugin remove openai-compatible-imagegen@openai-compatible-imagegen --json
   codex plugin marketplace remove openai-compatible-imagegen --json
   ```

5. 按当前平台的路径格式添加解压目录。

   Windows PowerShell：

   ```powershell
   codex plugin marketplace add "C:/path/to/openai-compatible-imagegen" --json
   ```

   macOS 或 Linux shell：

   ```bash
   codex plugin marketplace add "/absolute/path/to/openai-compatible-imagegen" --json
   ```

6. 安装并确认 Plugin：

   ```text
   codex plugin add openai-compatible-imagegen@openai-compatible-imagegen --json
   codex plugin list --json
   ```

7. 开始新任务。只要本地 marketplace 仍指向该目录，就不要删除解压目录。

本地 marketplace 路线独立于 Git marketplace 路线。Git marketplace 的升级不会替换来源为本地解压目录的 marketplace。

## 更新 Standalone Skill

Standalone 包会复制到客户端管理的 Skill 目录。第三方 `skills` CLI 不会更新从本地来源复制的 Skill。

1. 从同一个 [GitHub Release](https://github.com/Syh1906/openai-compatible-imagegen/releases) 下载新的 `openai-compatible-imagegen-skill-<version>.zip` 和 `SHA256SUMS`。
2. 按当前平台校验 Skill ZIP。

   Windows PowerShell：

   ```powershell
   (Get-FileHash -Algorithm SHA256 -LiteralPath "openai-compatible-imagegen-skill-<version>.zip").Hash.ToLowerInvariant()
   ```

   macOS 终端：

   ```bash
   shasum -a 256 openai-compatible-imagegen-skill-<version>.zip
   ```

   Linux shell：

   ```bash
   sha256sum openai-compatible-imagegen-skill-<version>.zip
   ```

3. 解压到新的版本专用目录，确认解压包根部存在 `SKILL.md`。
4. 只有确认目标版本接受相同配置后，才把现有 `auth.json` 复制到新目录。不要提交或粘贴其中的密钥值。
5. 把客户端指向新目录。直接安装时，先准备好新副本，再替换客户端路径。
6. 使用当前平台的 Python 命令运行包内冒烟检查。

   Windows PowerShell：

   ```powershell
   python "C:/path/to/openai-compatible-imagegen/scripts/imagegen.py" info
   ```

   macOS 或 Linux shell：

   ```bash
   python3 "/absolute/path/to/openai-compatible-imagegen/scripts/imagegen.py" info
   ```

7. 开始新任务或新会话，让客户端重新加载 `SKILL.md`。

不要对本地复制的压缩包使用 `skills update`。不要把再次运行 `skills add` 当作更新捷径：它可能替换安装目录并删除其中的 `auth.json`。生成的图片和 manifest 应保存在 Skill 目录之外。

## 验证与恢复

- Plugin：`codex plugin list --json` 报告预期版本，且新任务可以使用 Plugin 工具。
- Standalone：`imagegen.py info` 返回的 `script_path` 和 `auth_json` 都位于新的 Skill 目录内。
- 冒烟检查失败时，恢复旧目录并参照[回滚](./rollback.zh-CN.md)。

## 相关指南

- [安装](./installation.zh-CN.md)
- [回滚](./rollback.zh-CN.md)
- [故障排查](./troubleshooting.zh-CN.md)
