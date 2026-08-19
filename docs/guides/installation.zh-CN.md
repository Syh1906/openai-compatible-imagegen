<!-- updated: 2026-08-19 -->
# 安装

> 上级：[用户指南](./README.zh-CN.md)

[English](./installation.md) | 简体中文

选择一种发行包。两种发行包使用同一个图片核心，但面向不同宿主，并分别保存本地配置。

## 选择发行包

| 发行包 | 适用情况 | 能力 |
| --- | --- | --- |
| Standalone Skill | Agent 支持 Agent Skills，或需要 CLI | 生成、编辑、JSONL 批处理、交付、透明处理和 QA |
| Codex Plugin | 使用 Codex App，并需要图片结果卡和聚焦画布 | 全部共享图片能力，以及 MCP 工具、标注、产物和版本 |

不需要同时安装两者。Codex Plugin 不依赖 Standalone Skill。

## 安装 Codex Plugin

### 使用前提

- 支持 Plugin 的 Codex App 版本
- Git
- Node.js 20 或更高版本
- Python 3.12 或更高版本
- OpenAI-compatible 图片服务和你自己的凭据

Plugin 已包含预构建的 MCP server 和 Widget。无需运行 `npm install`、构建仓库或启动本地 Web server。同一个 Plugin 压缩包支持 Windows、macOS 和 Linux。

运行时在 Windows 默认调用 `python`，在 macOS/Linux 默认调用 `python3`，并要求 Python 3.12 或更高版本。需要指定一个明确的可执行文件时，设置 `OPENAI_COMPATIBLE_IMAGEGEN_PYTHON`；覆盖值无效或版本预检失败时会停止，不会尝试其他命令。macOS/Linux 不提供 Windows 的“在文件夹中显示”，但生成、编辑、产物、标注和画布操作仍可用。

### 操作步骤

1. 添加仓库 marketplace：

```text
codex plugin marketplace add Syh1906/openai-compatible-imagegen
```

2. 安装 Plugin：

```text
codex plugin add openai-compatible-imagegen@openai-compatible-imagegen
```

3. 也可以在 Codex App 中打开 **Plugins**，或在交互式 Codex CLI 会话中输入 `/plugins`，选择 `openai-compatible-imagegen` marketplace，然后安装 **OpenAI-Compatible Images**。
4. 使用 `codex plugin list --json` 确认已安装版本。
5. 安装后开始一个新任务。
6. 继续完成 [Plugin 配置](./configuration.zh-CN.md#配置-codex-plugin)。

第一次配置也可以在新任务中要求 Agent 调用 `initialize_image_config`。使用 `inspect_image_config` 查看脱敏结果，使用 `update_image_config` 修改支持的字段。Plugin 安装目录和 Skill 目录不保存用户配置。

### 从 Plugin ZIP 安装

需要从下载的 GitHub Release 压缩包安装指定版本，而不是使用 Git marketplace 时，使用此方式。

1. 从同一个 GitHub Release 下载：
   - `openai-compatible-imagegen-codex-plugin-<version>.zip`
   - `SHA256SUMS`
2. 计算 ZIP 的 SHA-256，并与 `SHA256SUMS` 中对应行比较。

   PowerShell：

   ```powershell
   (Get-FileHash -Algorithm SHA256 -LiteralPath "openai-compatible-imagegen-codex-plugin-<version>.zip").Hash.ToLowerInvariant()
   ```

   macOS 或 Linux：

   ```bash
   sha256sum openai-compatible-imagegen-codex-plugin-<version>.zip
   ```

3. 解压 ZIP。解压后的 `openai-compatible-imagegen` 目录必须同时包含 `.codex-plugin/plugin.json` 和 `.agents/plugins/marketplace.json`。
4. 使用绝对路径把解压目录添加为本地 marketplace：

   ```text
   codex plugin marketplace add "/absolute/path/to/openai-compatible-imagegen"
   ```

5. 从该 marketplace 安装 Plugin：

   ```text
   codex plugin add openai-compatible-imagegen@openai-compatible-imagegen
   ```

6. 使用 `codex plugin list --json` 确认版本，然后开始一个新任务。
7. 继续完成 [Plugin 配置](./configuration.zh-CN.md#配置-codex-plugin)。

Codex 从 marketplace 目录安装 Plugin，不能直接从 ZIP 安装。只要仍在使用这个本地 marketplace，就需要保留解压目录。日常更新仍推荐使用 Git marketplace。

### 交给 Agent 安装

需要 Agent 在不修改全局运行环境的情况下准备安装时，可以提供以下任务：

```text
从 Git marketplace Syh1906/openai-compatible-imagegen 安装 OpenAI-Compatible Images Codex Plugin。
先验证 Git、Node.js 20+ 和 Python 3.12 或更高版本。不要安装全局依赖或构建仓库。
在输入或移动凭据前停止。
```

## 安装 Standalone Skill

### 使用前提

- Python 3.12 或更高版本
- 支持 Agent Skills 的 Agent 客户端
- OpenAI-compatible 图片服务和你自己的凭据

### 操作步骤

1. 从 GitHub Release 下载 `openai-compatible-imagegen-skill-<version>.zip`。
2. 解压后，`openai-compatible-imagegen` 目录根部必须存在 `SKILL.md`。
3. 把该目录放入客户端支持的 Skill 路径：

| 客户端 | 用户级路径 | 项目级路径 |
| --- | --- | --- |
| Codex | `~/.codex/skills/openai-compatible-imagegen` | `.codex/skills/openai-compatible-imagegen` |
| Claude Code | `~/.claude/skills/openai-compatible-imagegen` | `.claude/skills/openai-compatible-imagegen` |
| OpenCode | `~/.config/opencode/skill/openai-compatible-imagegen` | `.opencode/skill/openai-compatible-imagegen` |

4. 开始新任务或新会话，让客户端重新加载 Skill。
5. 继续完成 [Standalone 配置](./configuration.zh-CN.md#配置-standalone-skill)。

### 使用第三方 Skills CLI 安装

`skills` 是第三方 Agent Skills CLI，不属于 OpenAI 或 Codex。它只能用于已经解压的 Standalone 压缩包。运行前先选择安装作用域：

| 作用域 | 可用范围 | 安装副本 |
| --- | --- | --- |
| 项目级（默认） | 当前项目 | `<project>/.agents/skills/openai-compatible-imagegen` |
| 用户级（`--global`） | 当前用户的多个项目 | `~/.agents/skills/openai-compatible-imagegen` |

项目级安装需要在目标项目中运行：

```text
npx --yes skills@latest add /path/to/openai-compatible-imagegen --agent codex --skill openai-compatible-imagegen --copy --yes
```

用户级安装需要增加 `--global`：

```text
npx --yes skills@latest add /path/to/openai-compatible-imagegen --global --agent codex --skill openai-compatible-imagegen --copy --yes
```

源目录根部必须包含 `SKILL.md`，并同时包含 `scripts/`、`references/`、`examples/` 和 `agents/`。不要传入仓库根目录，否则 Plugin、MCP、Widget、测试和文档文件也会被复制到 Skill 目标目录。

两条命令都使用 `skills@latest`，让新安装获取当前 CLI。`1.0.2` 发布验收已经覆盖项目级和用户级的复制安装与发现。项目级安装会创建项目 `skills-lock.json`；用户级安装不会创建该项目锁文件。

该 CLI 路线只用于首次安装。本地复制安装存在以下维护限制：

- 两种作用域下，`skills update` 都不会更新从本地解压目录复制的 Skill。
- 再次运行 `skills add` 会替换已安装目录，并删除其中的本地 `auth.json`。
- 项目级 `skills remove` 可能报告成功，但仍保留复制目录、项目 lock 记录和列表结果。
- `1.0.2` 验收中，用户级 `skills remove --global` 已移除复制目录和列表记录。
- 安装目录外的输出文件不由这些 CLI 操作管理。

需要更新或回滚时，保留当前安装和 `auth.json`，把目标版本解压到新目录，再按 [Standalone 回滚流程](./rollback.zh-CN.md#回滚-standalone-skill)切换。生成的图片和 manifest 应保存在已安装 Skill 目录之外。

## 安装结果

| 检查项 | Standalone Skill | Codex Plugin |
| --- | --- | --- |
| 包身份 | 安装根目录中的 `SKILL.md` | 安装根目录中的 `.codex-plugin/plugin.json` |
| 运行入口 | `scripts/imagegen.py` | `.mcp.json` 启动 `dist/server.mjs` |
| UI | 仅宿主会话 | Codex App 中的结果卡和聚焦画布 |
| 配置 | 安装目录中的 `auth.json` | 用户和可选项目 `config.json` |

是否进入公开 Plugins Directory 与本项目的 Git 发布渠道无关。

每个 GitHub Release 还提供 `openai-compatible-imagegen-codex-plugin-<version>.zip`，用于固定版本安装、离线检查、归档和回滚。下载后应使用该 Release 的 `SHA256SUMS` 校验。Git marketplace 仍是正常的 Plugin 安装渠道。
