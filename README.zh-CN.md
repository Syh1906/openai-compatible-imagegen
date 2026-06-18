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

- `1024x1024`、`1536x1024`、`1024x1536`、`2048x2048` 等尺寸；后端支持时也可使用 4K 类尺寸
- `low`、`medium`、`high`、`auto` 质量参数
- `png`、`jpeg`、`webp` 输出格式
- 仅当 `capabilities.transparent_background=true` 时发送 `background=transparent`
- 后端支持时可使用 moderation 和 compression 参数

不同后端的参数支持不完全一样。命令参数和 `auth.json` defaults 需要与你使用的供应商保持一致。

---

## 安装

### 从发布包安装

从 [Releases](https://github.com/Syh1906/openai-compatible-imagegen/releases) 下载 `openai-compatible-imagegen-v0.1.0.zip`，然后解压到你的 agent 客户端支持的 skills 目录。

### 从 Git 安装

如果你希望后续用 `git pull` 更新，可以直接 clone 到目标 skills 目录。

| 客户端 | 用户级安装路径 | 命令 |
| --- | --- | --- |
| Codex | `~/.agents/skills/openai-compatible-imagegen` | `git clone https://github.com/Syh1906/openai-compatible-imagegen.git ~/.agents/skills/openai-compatible-imagegen` |
| Claude Code | `~/.claude/skills/openai-compatible-imagegen` | `git clone https://github.com/Syh1906/openai-compatible-imagegen.git ~/.claude/skills/openai-compatible-imagegen` |
| OpenCode | `~/.config/opencode/skills/openai-compatible-imagegen` | `git clone https://github.com/Syh1906/openai-compatible-imagegen.git ~/.config/opencode/skills/openai-compatible-imagegen` |

只希望某个项目使用这个 skill 时，可以放到项目内目录：

| 客户端 | 项目内路径 |
| --- | --- |
| Codex / 通用 Agent Skills 布局 | `.agents/skills/openai-compatible-imagegen` |
| Claude Code | `.claude/skills/openai-compatible-imagegen` |
| OpenCode | `.opencode/skills/openai-compatible-imagegen` |

skill 目录根部必须包含 `SKILL.md`。

---

## 初始化认证

首次使用前创建本地私有配置：

```powershell
$SkillDir = "$env:USERPROFILE/.agents/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" init
```

也可以在初始化时写入非敏感字段：

```powershell
$SkillDir = "$env:USERPROFILE/.agents/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" init `
  --base-url "https://example.com/v1" `
  --model "gpt-image-2" `
  --api-key-env "OPENAI_API_KEY"
```

`auth.json` 是本地私有文件，已被 git 忽略。密钥支持两种写法：

- 直接写入 `auth.json` 的 `api_key` 字段。
- 在 `auth.json` 写 `api_key_env`，再把 key 放入对应环境变量。

如果两者同时存在，脚本优先使用 `api_key`。如果 `api_key` 仍是模板占位值，脚本才读取 `api_key_env`。

检查配置摘要：

```powershell
python "$SkillDir/scripts/imagegen.py" info
```

`info` 会打码密钥，只显示来源。

---

## 使用

文生图：

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Warcraft 3 style frost skill icon, single rune, centered, no text" `
  -f "outputs/frost-rune.png" `
  --size 1024x1024 `
  --quality high
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

后处理可以通过 `normalize` 和 `split-grid` 等命令单独执行。`generate`、`edit` 和 `batch` 也可以在传入 `--delivery-size`、`--grid` 或 `--postprocess-out-dir` 时写出后处理结果。

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
- `defaults.quality`：未传 `--quality` 时使用的质量参数。
- `defaults.output_format`：未传 `--format` 时使用的输出格式。
- `defaults.timeout_seconds`：单次请求超时时间，单位秒。
- `defaults.concurrency`：未传 `--concurrency` 时使用的批量并发数。
- `postprocess.enabled`：启用生成结果后处理。最终输出尺寸不写入 `auth.json`；需要缩放或拆网格的命令使用 `--delivery-size`。

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

发布 zip 包包含一个顶层目录：

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
