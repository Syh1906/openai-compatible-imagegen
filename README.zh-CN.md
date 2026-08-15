<div align="center">

# OpenAI 兼容图片

**通过 OpenAI 兼容图片 API 生成、编辑、批处理、检查并交付图片。**

[![Release](https://img.shields.io/github/v/release/Syh1906/openai-compatible-imagegen?style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Syh1906/openai-compatible-imagegen/ci.yml?branch=main&style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/actions)

[English](README.md) | 简体中文

</div>

---

## 选择发行包

这个仓库把同一套生图核心发布为两种替代安装形态。请按使用环境选择其中一种。

| 发行包 | 适用场景 | 增加的入口 |
| --- | --- | --- |
| **OpenAI-Compatible Images Skill** | 需要可移植 Agent Skill、命令行工作流，或使用 Codex App 以外的兼容客户端 | Standalone CLI、本地 `auth.json`、JSONL 批处理、交付工具和 QA |
| **OpenAI-Compatible Images** | 在 Codex App 中使用完整图片工作流 | MCP 工具、会话结果、聚焦画布、标注、不可变产物和版本历史 |

Codex Plugin 完整包含 Standalone 的生成、编辑、批量、透明处理、交付和 QA 能力，不依赖 Standalone Skill 已安装。首个整合版本把两者视为替代选择，不承诺同时参与路由、自动同步配置，也不承诺两个安装共享产物目录。

## 共享能力

| 需求 | 能力 |
| --- | --- |
| 创建或修改图片 | 文生图、参考图编辑、mask 和多参考图 |
| 生成受控变体 | 单请求多图和受并发限制的 JSONL 批处理 |
| 保留源结果 | 可选交付变换前先发布每张完整 API 原图 |
| 交付精确文件 | PNG 缩放、contain/stretch、安全边距、网格拆分和预览板 |
| 准备透明结果 | 明确的色键、发光 alpha、mask alpha 或已验证 prompt-alpha 路线 |
| 检查技术要求 | `qa.v1` 确定性检查，包括尺寸、alpha、边缘接触和连通组件 |
| 保持凭据私有 | 支持本地密钥或环境变量认证，结果不会返回密钥 |

配置的后端必须提供 `POST /v1/images/generations` 和 `POST /v1/images/edits`。响应可以包含 `data[].b64_json` 或 `data[].url`。返回图片 URL 不会收到 API key。

## 安装

发行文件名会标明安装形态：

```text
openai-compatible-imagegen-skill-<version>.zip
openai-compatible-imagegen-codex-plugin-<version>.zip
```

### Standalone Skill

把 Skill 压缩包解压到 Agent 客户端支持的 skills 目录。解压后的 `openai-compatible-imagegen` 目录根部必须包含 `SKILL.md`。

| 客户端 | 用户级路径 | 项目级路径 |
| --- | --- | --- |
| Codex | `~/.codex/skills/openai-compatible-imagegen` | `.codex/skills/openai-compatible-imagegen` |
| Claude Code | `~/.claude/skills/openai-compatible-imagegen` | `.claude/skills/openai-compatible-imagegen` |
| OpenCode | `~/.config/opencode/skill/openai-compatible-imagegen` | `.opencode/skill/openai-compatible-imagegen` |

### Codex Plugin

使用当前 Codex App 版本支持的插件安装流程加载 Codex Plugin 压缩包。包根包含 `.codex-plugin/plugin.json`、`.mcp.json`、预构建 MCP server/widget 和 Plugin Skill，不需要本地 Web 服务。

每个 release 会说明已验收分发渠道的具体安装和更新步骤。可下载压缩包不代表已经进入公共目录，也不代表支持自动更新。

## 配置

两个发行包会把各自的本地配置转换为同一个运行时模型。它们不会发现、合并或回退到另一种安装的配置文件。

### Standalone 配置

Standalone Skill 只读取安装目录中的 `auth.json`。请在安装目录运行配置向导：

```powershell
$SkillDir = "/path/to/openai-compatible-imagegen"
python "$SkillDir/scripts/quick-init.py"
```

手动配置时，把 [`examples/auth.example.json`](examples/auth.example.json) 复制为 `auth.json`，再设置 `base_url`、`model`，以及 `api_key_env` 或 `api_key`。Git 会忽略 `auth.json`。`url_download.proxy_mode` 默认使用环境代理。如果返回图片 URL 通过代理反复出现 TLS EOF，可用 `--allow-direct-url-download` 单次批准直连；只有已确认该 provider 的 URL 路线需要直连时，才持久设置为 `direct`。

运行时优先级：

```text
逐行 batch 字段 > 共享命令参数 > auth.json defaults > 内建默认值
```

运行 `info` 可查看脱敏摘要：

```powershell
python "$SkillDir/scripts/imagegen.py" info
```

### Plugin 配置

Codex Plugin 只读取以下固定路径：

1. 必需的用户配置：`~/.codex/openai-compatible-imagegen/config.json`
2. 可选的项目配置：`<项目根>/.codex/openai-compatible-imagegen/config.json`

请从 [`skills/openai-compatible-imagegen/references/config.example.json`](skills/openai-compatible-imagegen/references/config.example.json) 开始配置。用户文件是可信基线，声明 `config_version: 1`、活动档案、provider、model、defaults、后处理、透明策略和 storage。

项目文件只能覆盖：

- `defaults.size`
- `defaults.quality`
- `defaults.output_format`
- `storage.output_directory`

项目文件不能修改活动档案、模型、provider、endpoint、认证来源、密钥环境变量、超时、并发或路线权限。项目文件无效或越权时，会在读取凭据和发起网络请求前停止绑定。

Plugin 生效优先级：

```text
工具显式值 > 项目白名单覆盖 > 用户 defaults > 内建默认值
```

`storage.output_directory` 必须是项目内安全相对目录，默认值为 `output/imagegen/`。项目根本身、项目外路径、文件、符号链接、junction 和其他重解析点都会被拒绝。项目绑定时会冻结配置；修改配置后需要重启 MCP 并重新绑定。

## 迁移到 Plugin

迁移必须由用户明确执行。Plugin 不会扫描、读取、复制、合并、删除或覆盖旧 `auth.json` 和开发期 Plugin 配置。

在已安装 Plugin 根目录，用准确的旧配置路径和来源类型先运行脱敏 dry-run：

```powershell
python "<plugin-root>/dist/scripts/migrate_image_config.py" `
  --source "<legacy-config>" `
  --source-kind standalone
```

开发期 Plugin 配置使用 `--source-kind development-plugin`。只有这个来源可以迁移安全的项目覆盖，而且 dry-run 和 write 必须同时添加 `--include-project-overrides --project-root "<项目根>"`。

检查 `sourceKind`、`sourceSha256`、目标路径、`readyToWrite` 和脱敏预览。确认后保持所有输入不变，并使用已检查的摘要写入：

```powershell
python "<plugin-root>/dist/scripts/migrate_image_config.py" `
  --source "<legacy-config>" `
  --source-kind standalone `
  --write `
  --expected-source-sha256 "<sourceSha256>"
```

默认迁移环境变量认证。可用的明文 key 需要单独批准，并在 write 命令添加 `--allow-plaintext-api-key`。源摘要变化、目标已存在、模型不支持、仍含已移除的 `transparent_background`、schema 无效或写入失败时，迁移会停止。源文件保持不变。项目不提供 Plugin 到 Standalone 的自动逆迁移。

## 使用

用自然语言说明主体、构图、视觉方向、尺寸、数量、透明要求、检查项和输出位置。

- “生成一张 `16:9`、`2K` 的新品发布横幅，再交付 `1200x675` PNG。”
- “把这张商品照片编辑成透明 `512x512` 抠图，保留 3% 安全边距，并在白色、黑色和棋盘格背景上预览。”
- “按这些提示词生成 4 张编辑插图，并保留 batch manifest。”
- “保护笔记本，把马克杯改成另一种颜色，然后在聚焦画布中检查结果。”

在 Codex App 中，Plugin 通过 MCP 路由生成和编辑，在会话中渲染稳定结果，并在需要标注时打开聚焦画布。Standalone 则由 Agent 调用包内 CLI，并报告文件和 manifest 路径。

### Standalone 命令

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Editorial still life, soft window light, room for a headline, no text" `
  -f "outputs/still-life.png" `
  --aspect 4:3 `
  --resolution 2K `
  --quality high

python "$SkillDir/scripts/imagegen.py" edit `
  -p "Preserve the subject and camera angle; replace the background with a neutral studio wall" `
  -i "input.png" `
  -f "outputs/studio-edit.png"

python "$SkillDir/scripts/imagegen.py" batch `
  --input "examples/batch.example.jsonl" `
  --out "outputs/imagegen" `
  --concurrency 3
```

支持的命令包括 `info`、`generate`、`edit`、`batch`、`inspect-image`、`normalize`、`split-grid`、`preview-board` 和 `apply-transparency`。

## 原图与交付

生成成功和交付就绪是两个独立状态：

- `ok=true` 表示至少发布了一张完整 API 原图。
- Standalone 返回 `delivery_ready`；Plugin 把同一事实映射为 `deliveryReady`。
- 透明、变换或 QA 失败时保留原图，并报告未满足条件。
- API 返回数量、尺寸或格式偏差会记录为警告，不会隐藏有效原图。

生成尺寸和交付尺寸相互独立。较大的源图可以生成精确尺寸的本地派生图，不会覆盖源图。Plugin 会把原图、派生图、QA、交付收据、batch manifest 和编辑版本保存为相互关联的不可变产物。

## 透明处理

`--transparent` 和 Plugin 的透明选项代表交付意图。它们会强制 PNG，但不会向图片 API 发送 `background=transparent`。

只有输入满足路线契约时才使用对应路线：

| 路线 | 适用输入 |
| --- | --- |
| `chroma-matting` | 已知、受控纯色底板上的独立主体 |
| `emissive-alpha` | 纯黑背景上的火焰、粒子、闪电、发光或烟雾 |
| `mask-alpha` | 可信 alpha、亮度或 RGB 通道蒙版 |
| `prompt-alpha` | 已验证的精确后端 model/mode/size 组合 |

发丝、玻璃、半透明布料和复杂烟雾背景需要受控底板或可信蒙版。输入条件不足时会返回原图并标记未满足。画布中的保护/改图区域与透明交付使用的 alpha mask 是两个不同概念。

## QA 与限制

`qa.v1` 返回 `pass`、`fail`、`partial` 或 `not_evaluated`。它检查尺寸、alpha 覆盖、边缘接触、边距和可选连通组件等确定性技术事实，不判断审美、身份、布局或语义一致性，也不会修改请求来强制通过。

单次 API 请求支持 `n=1..16`。运行时会在发布前限制响应大小、单图解码大小、累计处理量、batch 并发和图片总数。PNG、JPEG 和 WebP 原图会经过有界结构校验。深度本地变换与 QA 只支持文档声明的 PNG 子集；不支持深度检查时只影响交付就绪状态，不会隐藏已经通过原图校验的文件。

任何路线都不会自动切换模型、provider、endpoint、协议、认证来源或下载代理。只有明确允许的工作流才能再次请求图片 API；Codex Plugin 不会在透明交付失败后重试图片 API。

## 文档

- [提示词指南](references/prompting.md)
- [参数参考](references/parameters.md)
- [后处理参考](references/postprocess.md)
- [交付 QA 参考](references/qa.md)
- [版本历史](CHANGELOG.md)

## 许可证

[MIT License](LICENSE)
