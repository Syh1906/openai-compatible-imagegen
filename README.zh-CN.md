<div align="center">

# OpenAI 兼容图片生成 Skill

**让 Codex、Claude Code、OpenCode 等 agent 客户端通过 OpenAI 兼容图片 API 生成、编辑和批量创建图片。**

[![Release](https://img.shields.io/github/v/release/Syh1906/openai-compatible-imagegen?style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Syh1906/openai-compatible-imagegen/ci.yml?branch=main&style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/actions)
[![Skill](https://img.shields.io/badge/skill-SKILL.md-lightgrey?style=flat-square)](SKILL.md)

[English](README.md) | 简体中文

</div>

---

## 为什么需要它

这个仓库是一个可移植的 agent skill。它让 Codex、Claude Code、OpenCode 和其他兼容 Agent Skills 标准的客户端使用同一套本地图片生成流程。

| 需求 | 这个 skill 提供什么 |
| --- | --- |
| 根据提示词生成图片 | `generate` 文生图命令 |
| 根据参考图编辑或转换图片 | 支持一个或多个输入图的 `edit` 命令 |
| 批量生成资产 | 基于 JSONL 和限流并发的 `batch` 命令 |
| 创建图标、sprite、透明底素材 | `--asset` 与 `--transparent` 意图开关 |
| 可选后处理 | 显式 `inspect-image`、`normalize`、`split-grid` 命令 |
| 保持密钥本地私有 | 忽略 `auth.json`，支持直写 `api_key` 或 `api_key_env` |

---

## 兼容范围

这个 skill 面向在 `base_url` 下提供以下接口的 OpenAI 兼容图片 API：

| 模式 | 接口 | 请求类型 |
| --- | --- | --- |
| `generate` | `POST /v1/images/generations` | JSON |
| `edit` | `POST /v1/images/edits` | `multipart/form-data` |

`base_url` 通常以 `/v1` 结尾，例如：

```json
{
  "base_url": "https://example.com/v1",
  "model": "gpt-image-2"
}
```

`examples/auth.example.json` 里的默认模型只是模板值。你可以把 `model` 改成后端支持的任意图片模型，例如你的网关或供应商暴露的 OpenAI 兼容图片生成模型。

脚本层支持的参数包括：

- `1024x1024`、`1536x1024`、`1024x1536`、`2048x2048` 等精确尺寸；后端支持时也可使用 4K 类尺寸
- 通过 `--aspect`（`1:1`、`16:9`、`4:3`、`3:4`、`9:16`）和 `--resolution`（`1K`、`2K`、`4K`）按形状和清晰度选择尺寸
- `low`、`medium`、`high`、`auto` 质量参数
- `png`、`jpeg`、`webp` 输出格式
- 仅当 `capabilities.transparent_background=true` 时发送 `background=transparent`
- 后端支持时可使用 moderation 和 compression 参数

不同后端的参数支持不完全一样。命令参数和 `auth.json` defaults 需要与你使用的供应商保持一致。

---

## 安装

### 从发布包安装

从 [Releases](https://github.com/Syh1906/openai-compatible-imagegen/releases) 下载最新的 `openai-compatible-imagegen-<latest>.zip`，然后解压到你的 agent 客户端支持的 skills 目录。

### 从 Git 安装

如果你希望后续用 `git pull` 更新，可以直接 clone 到目标 skills 目录。

| 客户端 | 用户级安装路径 | 命令 |
| --- | --- | --- |
| Codex | `~/.codex/skills/openai-compatible-imagegen` | `git clone https://github.com/Syh1906/openai-compatible-imagegen.git ~/.codex/skills/openai-compatible-imagegen` |
| Claude Code | `~/.claude/skills/openai-compatible-imagegen` | `git clone https://github.com/Syh1906/openai-compatible-imagegen.git ~/.claude/skills/openai-compatible-imagegen` |
| OpenCode | `~/.config/opencode/skill/openai-compatible-imagegen` | `git clone https://github.com/Syh1906/openai-compatible-imagegen.git ~/.config/opencode/skill/openai-compatible-imagegen` |

只希望某个项目使用这个 skill 时，可以放到项目内目录：

| 客户端 | 项目内路径 |
| --- | --- |
| Codex | `.codex/skills/openai-compatible-imagegen` |
| Claude Code | `.claude/skills/openai-compatible-imagegen` |
| OpenCode | `.opencode/skill/openai-compatible-imagegen` |

skill 目录根部必须包含 `SKILL.md`。

---

## 初始化认证

首次使用前创建本地私有配置：

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/quick-init.py"
```

向导会询问：

- API 基础地址，通常以 `/v1` 结尾
- 图片模型
- 认证方式，推荐使用环境变量
- 后端是否支持透明背景

如果要用非交互方式配置环境变量认证：

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/quick-init.py" `
  --non-interactive `
  --base-url "https://example.com/v1" `
  --model "gpt-image-2" `
  --auth-method env `
  --api-key-env "OPENAI_API_KEY" `
  --transparent-background
```

`auth.json` 是本地私有文件，已被 git 忽略。密钥支持两种写法：

- 直接写入 `auth.json` 的 `api_key` 字段。
- 在 `auth.json` 写 `api_key_env`，再把 key 放入对应环境变量。

如果两者同时存在，脚本优先使用 `api_key`。如果 `api_key` 仍是模板占位值，脚本才读取 `api_key_env`。

底层的 `imagegen.py init` 命令仍然保留，适合只需要复制模板或复现旧初始化步骤时使用。

检查配置摘要：

```powershell
python "$SkillDir/scripts/imagegen.py" info
```

`info` 会打码密钥，只显示来源。

---

## 使用

### 向你的 agent 提需求

安装 skill 并配置 `auth.json` 后，直接用自然语言告诉 agent 你要什么图片结果。说明最终素材形态、透明背景、数量和后处理需求。

示例：

- “使用 OpenAI 兼容图片生成 skill，生成一张 `1024x1024` 的 Warcraft 3 风格冰霜技能图标，不要文字，最终 PNG 存到 `outputs/`。”
- “生成一张 `16:9`、`2K` 的直播卖货横幅，风格是商品展示海报，保存为 WebP。”
- “生成一张 `9:16`、`4K` 的手机壁纸，主题是赛博朋克集市。”
- “创建一个透明背景的物品素材，主体是居中的火焰宝珠。如果后端支持真实 alpha，就输出透明 PNG。”
- “生成一张 `3x3` 的游戏物品候选图，然后拆成 9 张独立的 `128x128` PNG。”
- “使用这张参考图，把它转换成暗黑魔法 UI 风格，结果保留为 PNG。”
- “按这些提示词批量生成 4 个独立图标方案，并保存 batch manifest。”

需要后处理时，同时说明源图生成尺寸和最终交付尺寸：

- “生成 `1024x1024` 源图标，然后交付 `128x128` PNG。”
- “检查这张 PNG 是否有 alpha，然后缩放到 `128x128`。”
- “把这张 `3x3` 候选图拆成 9 张归一化的 `128x128` 文件。”

### 手动命令

文生图：

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Warcraft 3 style frost skill icon, single rune, centered, no text" `
  -f "outputs/frost-rune.png" `
  --aspect 1:1 `
  --resolution 1K `
  --quality high
```

按形状和清晰度选择尺寸：

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Livestream shopping banner for discounted transit-station tokens, bold product showcase style" `
  -f "outputs/token-banner.webp" `
  --aspect 16:9 `
  --resolution 2K `
  --format webp `
  --quality medium
```

参考图编辑：

```powershell
python "$SkillDir/scripts/imagegen.py" edit `
  -p "Convert this to a dark magic UI style" `
  -i "input.png" `
  -f "outputs/dark-ui.png"
```

批量生成：

```powershell
python "$SkillDir/scripts/imagegen.py" batch `
  --input "examples/batch.example.jsonl" `
  --out "outputs/imagegen" `
  --concurrency 3
```

透明底素材意图：

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Centered fire orb game item asset, no text" `
  -f "outputs/fire-orb.png" `
  --asset `
  --transparent
```

如果所选模型和分辨率不支持透明背景，脚本会在发送请求前停止。此时选择一种路径：切换到支持透明背景的模型并保留透明，或保留当前模型并改用 `background=auto`。

可选后处理：

```powershell
python "$SkillDir/scripts/imagegen.py" inspect-image "input.png"

python "$SkillDir/scripts/imagegen.py" normalize "input.png" `
  --delivery-size 128x128 `
  --out "output.png"

python "$SkillDir/scripts/imagegen.py" split-grid "grid.png" `
  --grid 3x3 `
  --delivery-size 128x128 `
  --out-dir "candidates"
```

后处理用于把 API 返回的 PNG 转成可交付文件。它覆盖三类常见任务：

| 任务 | 命令 | 结果 |
| --- | --- | --- |
| 检查 PNG | `inspect-image` | 输出宽高、是否有 alpha 通道、alpha 有效边界。 |
| 缩放单图 | `normalize` | 按 `--delivery-size` 写出一张 PNG。 |
| 拆候选图 | `split-grid` | 按网格单元写出多张归一化 PNG。 |

API 请求尺寸和最终交付尺寸是两件事。例如后端可能返回 `1024x1024` PNG，但你需要 `128x128` 图标。此时用 `--delivery-size 128x128` 写出最终图标文件。

`generate`、`edit` 和 `batch` 也可以在传入 `--delivery-size`、`--grid` 或 `--postprocess-out-dir` 时写出后处理结果。这个模式下，命令会把 API 原图路径放在 `original_files`，把后处理文件路径放在 `files`。

---

## 配置字段

`examples/auth.example.json` 是本地配置模板。

关键字段：

- `base_url`：OpenAI 兼容 API 基础地址，通常以 `/v1` 结尾。
- `api_key`：直接写在本地配置里的 API key。不要提交真实值。
- `api_key_env`：当 `api_key` 为空或仍是占位值时读取的环境变量名。
- `model`：`generate`、`edit`、`batch` 默认使用的图片模型。
- `capabilities.transparent_background`：只有接口接受 `background=transparent` 时才设为 `true`。
- `defaults.size`：未传 `--size` 时使用的 API 请求尺寸。
- `defaults.aspect`：未传 `--size` 时，可与 `defaults.resolution` 搭配使用的默认比例。
- `defaults.resolution`：未传 `--size` 时，可与 `defaults.aspect` 搭配使用的默认 `1K`、`2K` 或 `4K` 清晰度。
- `defaults.quality`：未传 `--quality` 时使用的质量参数。
- `defaults.output_format`：未传 `--format` 时使用的输出格式。
- `defaults.timeout_seconds`：单次请求超时时间，单位秒。
- `defaults.concurrency`：未传 `--concurrency` 时使用的批量并发数。
- `postprocess.enabled`：启用生成结果后处理。最终输出尺寸不写入 `auth.json`；需要缩放或拆网格的命令使用 `--delivery-size`。

后处理需求示例：

- 单图图标：“生成 `1024x1024` 源图，然后在 `outputs/final` 交付 `128x128` PNG。”
- 候选图网格：“生成一张 `3x3` 候选图，并拆成 9 张归一化的 `128x128` PNG。”
- 已有文件：“把 `raw.png` 缩放到 `128x128`，保存为 `icon.png`，不要调用图片 API。”

---

## 质量检查

运行本地检查：

```powershell
python -m unittest discover -s tests
python -m py_compile scripts/imagegen.py
```

测试不会调用图片 API。

---

## 发布包

发布 zip 包包含一个顶层目录和当前后处理文档：

```text
openai-compatible-imagegen/
├── SKILL.md
├── agents/openai.yaml
├── scripts/imagegen.py
├── references/parameters.md
├── references/postprocess.md
└── examples/
```

本地 `auth.json` 不会包含在发布包里。

---

## 许可证

[MIT License](LICENSE)
