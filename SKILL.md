---
name: openai-compatible-imagegen
description: Generate, edit, and batch-generate images through a local OpenAI-compatible image API script. Use when Codex needs to create images, icons, transparent-background assets, sprites, UI mockups, posters, covers, reference-image edits, inpainting, multi-reference image composition, concurrent batch image generation, or initialize a local auth.json for an OpenAI-compatible image API.
---

# OpenAI 兼容图片生成

使用本 skill 调用本地脚本生成图片。不要临时重写 API 调用逻辑。

## 工作流

1. 先运行 `info` 检查配置；如果提示缺少 `auth.json`，先运行 `init` 创建本地配置。
2. 判断模式：`generate` 文生图、`edit` 图生图/局部编辑、`batch` 批量、`info` 查看配置摘要。
3. 根据用户意图决定参数：用户明确指定优先；其次使用批量文件参数；再由 LLM 根据 prompt 决定；最后才使用 `auth.json` 的 `defaults`。
   - 质量不要机械使用默认值。草稿/探索可用 `low` 或 `medium`；正式素材、UI、文字密集图、海报、封面和用户要求“高质量/精细/成品”时显式传 `--quality high`。
   - `auth.json` 默认质量建议用 `auto`，作为无法判断时的后端兜底。
4. 执行前确认输出路径、张数、尺寸、质量、是否透明底、是否参考图。
5. 调用 `scripts/imagegen.py`，不要读取或展示 `auth.json` 的密钥值。
6. 汇报生成文件路径、成功数量、失败数量和 manifest 路径。

## 配置

配置文件固定为 skill 根目录的 `auth.json`。它是本地私有文件，不提交到仓库。

首次使用时运行：

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" init
```

可在初始化时写入非敏感字段：

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" init `
  --base-url "https://example.com/v1" `
  --model "gpt-image-2" `
  --api-key-env "OPENAI_API_KEY"
```

密钥支持两种方式：

- 直接写入 `auth.json` 的 `api_key` 字段，适合偏好配置文件的人。
- 在 `auth.json` 写 `api_key_env`，再把 key 放到对应环境变量，适合不想把 key 落盘的人。

如果 `api_key` 和 `api_key_env` 同时存在，脚本优先使用 `api_key`。`api_key` 仍是模板占位值时，脚本才读取 `api_key_env`。

示例见 `examples/auth.example.json`。真实配置字段：

- `base_url`：OpenAI 兼容 API 基础地址，通常以 `/v1` 结尾。
- `api_key`：API key，可直接写入本地 `auth.json`。
- `api_key_env`：可选环境变量名，用于从环境变量读取 API key。
- `model`：默认图片模型，例如 `gpt-image-2`。
- `capabilities.transparent_background`：接口是否原生支持 `background=transparent`。这只控制是否发送 API 参数，不控制 prompt 层的透明底意图。
- `defaults`：弱默认值，只在调用参数缺失时使用。

禁止把 `api_key` 打印到对话、日志、文档、提交信息或错误说明中。

## 命令

所有命令都从任意工作目录调用：

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" info
```

文生图：

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Warcraft 3 风格技能图标，冰霜符文，无文字" `
  -f "E:/Code/project/assets/frost-rune.png" `
  --size 2048x2048 `
  --quality high
```

编辑/参考图：

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" edit `
  -p "改成暗色魔法 UI 风格" `
  -i "input.png" `
  -f "output.png"
```

批量限流并发：

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" batch `
  --input "prompts.jsonl" `
  --out "outputs/imagegen" `
  --concurrency 3
```

透明底素材快捷方式：

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" generate `
  -p "居中的火焰宝珠游戏道具素材，无文字" `
  -f "assets/generated/fire-orb.png" `
  --asset `
  --transparent
```

## 参数规则

核心参数：

- `-p, --prompt`：提示词，`generate` 和 `edit` 必填。
- `-f, --file`：输出文件；省略时自动写入当前目录。
- `-i, --image`：参考图，可重复；出现时走编辑接口。
- `-m, --mask`：遮罩图；仅编辑模式使用。
- `--size`：例如 `1024x1024`、`1536x1024`、`1024x1536`、`2048x2048`、`3840x2160`。
- `--quality`：`low`、`medium`、`high`、`auto`。
- `--n`：单条请求返回张数。
- `--format`：`png`、`jpeg`、`webp`。
- `--background`：`auto`、`opaque`、`transparent`。只有接口声明支持时才会发送 `transparent` 参数。
- `--transparent`：透明底素材意图快捷方式；脚本会强制 PNG，并向 prompt 注入透明底/孤立主体约束。若接口支持，额外发送 `background=transparent`。
- `--asset`：素材快捷模式，默认 PNG；适合图标、道具、贴图、sprite。
- `--concurrency`：批量限流并发数。

详细行为见 `references/parameters.md`。

## 批量格式

`batch` 输入为 JSONL，每行一个任务。示例见 `examples/batch.example.jsonl`。

常用字段：

- `id`
- `prompt`
- `file`
- `size`
- `quality`
- `n`
- `format`
- `background`
- `transparent`
- `asset`
- `images`
- `mask`

批量默认是限流并发，不是无限并发。并发数优先级：

```text
命令行 --concurrency > auth.json defaults.concurrency > 3
```

不要默认加入失败后换模型、换接口、额外后处理或其他 fallback。需要这类策略时先问用户。

## 透明底素材

用户说“素材、图标、物品、贴图、sprite、透明底、PNG 透明背景”时，优先加 `--asset`；用户明确要求透明底时加 `--transparent`。

透明底首先是 prompt 层意图，由 LLM 写进提示词；脚本的 `--transparent` 会补充透明底/孤立主体约束。`auth.json` 中 `capabilities.transparent_background=true` 只表示后端原生支持 `background=transparent`，此时脚本会额外发送该 API 参数。

如果接口不支持原生透明底，仍可使用 `--transparent` 让模型按透明底素材方向生成；不要承诺一定得到真实 alpha 通道。不要擅自接入去背景后处理；用户明确要求本地去背景时再另行实现。

## 输出

脚本会保存图片，并写入 `manifest.json`。汇报时只说：

- 输出图片路径
- manifest 路径
- 成功和失败数量
- 失败摘要

不要展示密钥、完整请求头或包含密钥的配置内容。
