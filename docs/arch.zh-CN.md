# 架构
> 上级：[文档](./README.zh-CN.md)

[English](./arch.md) | 简体中文

本文面向贡献者和维护者，说明模块、依赖、配置、状态与发行边界。安装和配置步骤见[用户指南](./guides/README.zh-CN.md)。

## 实现入口

| 来源 | 职责 |
| --- | --- |
| `scripts/` | 共享图片协议、验证、转换、交付和 QA |
| `mcp/` | Plugin 工具、项目绑定、异步任务、产物、编辑器状态和运行时调用 |
| `web/` | Codex 结果卡和聚焦图片画布 |
| `web/widget-i18n.mjs` | Widget 英文和中文消息目录及 locale 解析 |
| `scripts/plugin-file-set.mjs` | 发行文件归属和共享核心证据 |
| `.codex-plugin/plugin.json`、`.mcp.json` | Plugin 身份和启动契约 |
| `tests/` | 可执行的公开行为和发行边界 |

Plugin 在包级别保持平台无关。`scripts/repository_fs.py` 是 Python 产物仓库的文件系统入口：Windows 选择 `windows_repository_fs.py`，macOS/Linux 选择 `posix_repository_fs.py`。两个适配器提供相同的仓库、提交锁、原子发布和安全路径契约；适配器只属于 Plugin，不进入 Standalone 压缩包。

## 核心流程

```mermaid
flowchart LR
    Agent[Agent 或用户] --> Standalone[Standalone 适配器]
    Agent --> Plugin[Codex Plugin Skill]
    Plugin --> MCP[MCP server]
    MCP --> Jobs[API Key 任务执行器]
    Jobs --> Runtime[Plugin 适配器]
    Standalone --> Core[共享图片核心]
    Runtime --> Core
    Core --> Provider[OpenAI-compatible 图片 API]
    Core --> Atlas[Atlas 生成 API]
    Plugin --> Host[ChatGPT 宿主生图]
    Host --> Handoff[已准备的图片交接]
    Handoff --> Repository
    MCP --> Repository[不可变产物仓库]
    MCP --> Widget[结果卡和聚焦画布]
```

## 发行职责

| 范围 | 共享 | 仅 Standalone | 仅 Plugin |
| --- | --- | --- | --- |
| 图片传输和响应验证 | 是 |  |  |
| PNG 转换、透明处理、交付和 QA | 是 |  |  |
| `auth.json`、CLI、JSONL 入口 |  | 是 |  |
| 项目绑定和配置白名单 |  |  | 是 |
| 稳定产物 ID 和编辑版本 |  |  | 是 |
| MCP 工具、结果卡和画布 |  |  | 是 |

共享代码从 `scripts/` 进入两个版本化发行包。两种发行适配器保持分离，Codex 专属行为不会进入便携式运行时。

| 平台 | Python 命令 | 文件系统适配器 | UI 限制 |
| --- | --- | --- | --- |
| Windows | `python` | `windows_repository_fs.py` | 支持在资源管理器中显示 |
| macOS/Linux | `python3` | `posix_repository_fs.py` | 不提供“在文件夹中显示” |

可使用 `OPENAI_COMPATIBLE_IMAGEGEN_PYTHON` 显式覆盖命令。运行时首次使用前会验证 Python 3.12 或更高版本；覆盖值无效或预检失败时停止，不会轮询多个命令。

## 依赖方向

```text
Codex widget -> MCP server -> Plugin adapter -> shared image core -> provider
Standalone Skill -> Standalone adapter -> shared image core -> provider
```

- 共享图片核心不依赖 Codex、MCP 或 Widget 代码。
- Widget 不读取凭据，也不调用 provider。
- MCP 工具不组装 provider 请求。
- 故障不会改变 provider、model、endpoint、认证来源或协议。透明参数重试和本地回退按所选路线的配置策略执行。

## 配置边界

- Standalone Skill 只读取已安装 Skill 同目录的 `auth.json`。
- Codex Plugin 读取固定的用户配置和可选项目配置。
- 两种发行包不会扫描、合并或回退到对方的配置。
- 项目配置只能覆盖白名单内的默认值，不能替换 provider、model、endpoint、认证来源、凭据或路线权限。

## 产物与状态模型

- API 原图先发布，再执行可选的本地交付转换。
- 已生成、编辑和交付的图片都是带稳定 ID 的不可变产物。
- 编辑标注会归一化到源图片坐标并保存为编辑意图。
- 有意义的聚焦画布草稿按稳定图片 ID 保存，并在会话结束前写入；再次打开同一图片时恢复。
- Widget locale 来自宿主上下文。所有中文 locale 变体使用同一中文目录；缺失或非中文 locale 使用英文。Plugin 和 MCP metadata 默认使用英文。
- `projectBindingId` 跨 MCP 进程把模型和 Widget 调用绑定到同一项目。
- 配置写入和项目绑定使用内容仅为 `*` 的本地 `.gitignore` 保护目标目录；现有规则不兼容时停止操作，不覆盖原规则。
- 跨进程注册表使用原子文件替换和归属锁，旧写入者不能覆盖新的归属者。

API Key 任务的职责分为[工具注册](../mcp/image-job-tools.mjs)、[契约](../mcp/image-job-contract.mjs)、[持久化存储](../mcp/image-job-store.mjs)、[调度](../mcp/image-job-manager.mjs)和[执行](../mcp/image-job-execution.mjs)。提交键标识一次不可变的请求意图。任务在本地交付前保存原图检查点，按输入顺序分页返回结果，并保留部分成功。恢复只继续未发出的请求或已有原图的本地处理；供应商结果未经确认时不会自动重发。

每个 MCP 执行器的多个任务共享 8 个执行槽，并遵守批次设置的更低并发上限。不同进程分别计数，持久化执行权防止同一任务被同时执行。状态在重启后保留，但执行依赖运行中的 MCP 进程。如果进程在发布图片后、保存检查点前退出，图片可能已保存但没有可确认的任务结果。

ChatGPT 操作使用已准备的宿主图片交接，不经过 API 任务执行器。提交成功的宿主图片进入同一不可变产物仓库；编辑结果保留父图和画布提交关系。

## 发布模型

- 一个版本和标签同时生成 Standalone Skill 压缩包与一个平台无关的 Codex Plugin 压缩包。Windows、Linux 和 macOS 分别构建候选；只有文件集和 SHA-256 字节完全一致时才能进入发布环境。
- `dist/` 纳入 Git，使 Git-backed Plugin 安装不需要源码构建或本地 Web server。
- 发布构建器验证两个发行包中的共享 Python 文件逐字节一致。
- 一个 `SHA256SUMS` 文件覆盖两个压缩包和共享核心证据文件。
- 版本化 release notes 和对应的 `CHANGELOG.md` 章节属于标签源码。
- Marketplace metadata、Plugin manifest、package metadata、标签和发布资产使用同一版本。

## 变更矩阵

| 变更 | 负责边界 | 证据 |
| --- | --- | --- |
| 共享图片行为 | 共享核心和两个适配器 | 共享测试与适配器测试 |
| Standalone 配置或 CLI | Standalone 适配器与指南 | Standalone 测试与包检查 |
| MCP 或产物行为 | MCP 工具与产物运行时 | MCP 测试与 Plugin 检查 |
| 结果卡或画布 | `web/` 与 MCP Apps bridge | Widget 与编辑器测试 |
| 发行 metadata | Manifest 与发布构建器 | 版本、文件集与压缩包检查 |
