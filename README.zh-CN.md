<div align="center">

# OpenAI 兼容图片生成 Skill

**通过 OpenAI 兼容图片 API 生成、编辑、批量创建、检查并交付图片。**

[![Release](https://img.shields.io/github/v/release/Syh1906/openai-compatible-imagegen?style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Syh1906/openai-compatible-imagegen/ci.yml?branch=main&style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/actions)
[![Skill](https://img.shields.io/badge/skill-SKILL.md-lightgrey?style=flat-square)](SKILL.md)

[English](README.md) | 简体中文

</div>

---

## 能做什么

这个可移植的 Agent Skill 为兼容客户端提供统一的图片工作流，可用于营销视觉、商品抠图、编辑插图、品牌素材、界面图形、游戏美术及其他图片交付物。

| 需求 | 能力 |
| --- | --- |
| 创建或修改图片 | 文生图和参考图编辑 |
| 生成受控变体 | 支持逐任务参数和限流并发的 JSONL 批处理 |
| 交付精确文件 | PNG 缩放、contain/stretch 适配、安全边距和网格拆分 |
| 检查技术要求 | `qa.v1` 确定性检查，包括尺寸、alpha、边缘接触和可选连通组件 |
| 检查展示效果 | 在多种尺寸和背景上生成预览板 |
| 保持凭据私有 | git 忽略的 `auth.json`，支持直接密钥或环境变量认证 |

图片生成由 OpenAI 兼容后端完成。本地后处理是确定性操作，不会调用图片 API。

## 兼容范围

配置的 `base_url` 必须提供以下接口：

| 模式 | 接口 | 请求类型 |
| --- | --- | --- |
| `generate` | `POST /v1/images/generations` | JSON |
| `edit` | `POST /v1/images/edits` | `multipart/form-data` |

图片响应可以包含 `data[].b64_json` 或 `data[].url`。JSON 响应上限为 96 MiB，解码或下载后的单张图片上限为 64 MiB。返回的 PNG 会在写入前完整解析，并且必须是不超过 2500 万像素的非交错 8 位 RGB/RGBA；RGB `tRNS` 和其他 PNG 编码会被拒绝。JPEG 和 WebP 响应会检查容器与关键编码帧结构。图片 URL 不会收到 API 凭据。

请求参数支持精确像素尺寸、比例与分辨率预设、质量、输出格式、透明背景意图、moderation 和 compression。不同后端支持范围不同，请让 `auth.json` 与供应商能力保持一致。

## 安装

从 [Releases](https://github.com/Syh1906/openai-compatible-imagegen/releases) 下载 `openai-compatible-imagegen-<version>.zip`，解压到 agent 客户端支持的 skills 目录。也可以把仓库直接 clone 到该目录。

| 客户端 | 用户级路径 | 项目级路径 |
| --- | --- | --- |
| Codex | `~/.codex/skills/openai-compatible-imagegen` | `.codex/skills/openai-compatible-imagegen` |
| Claude Code | `~/.claude/skills/openai-compatible-imagegen` | `.claude/skills/openai-compatible-imagegen` |
| OpenCode | `~/.config/opencode/skill/openai-compatible-imagegen` | `.opencode/skill/openai-compatible-imagegen` |

安装目录根部必须包含 `SKILL.md`。

## 配置后端

在安装后的 skill 目录运行配置向导：

```powershell
$SkillDir = "/path/to/openai-compatible-imagegen"
python "$SkillDir/scripts/quick-init.py"
```

需要手动配置时，把 `examples/auth.example.json` 复制到 skill 目录并命名为 `auth.json`，再填写后端地址、模型和认证来源。git 会忽略 `auth.json`。

```json
{
  "base_url": "https://example.com/v1",
  "api_key": "",
  "api_key_env": "OPENAI_API_KEY",
  "model": "gpt-image-2",
  "capabilities": {
    "transparent_background": false
  }
}
```

`api_key` 用于把密钥保存在本地配置中；`api_key_env` 用于填写环境变量名。运行 `info` 可查看打码后的配置摘要：

```powershell
$SkillDir = "/path/to/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" info
```

只有后端接受 `background=transparent` 时，才设置 `capabilities.transparent_background=true`。

## 向 Agent 提需求

用自然语言说明主体、视觉方向、最终尺寸、透明度、数量、检查要求和输出目录。

- “生成一张 `16:9`、`2K` 的新品发布横幅，再交付 `1200x675` PNG 到 `outputs/campaign`。”
- “把这张商品照片处理成透明底 `512x512` PNG，四周保留 3% 安全边距。确认真实 alpha，并生成白色、黑色和棋盘格背景预览。”
- “按这些提示词批量生成 4 张公共交通主题编辑插图，并保存 batch manifest。”
- “创建一个方形品牌标志，报告连通组件和边缘接触，再生成 `64x64` 与 `256x256` 预览。”
- “生成一张 `3x3` 的 UI 概念图，并拆成 9 张 `256x256` PNG。”
- “创建一个幻想策略游戏的冰霜技能图标，不要文字，并交付 `64x64` 和 `128x128` 预览。”

生成尺寸和交付尺寸相互独立。你可以先生成较大的源图，再输出精确尺寸的本地交付文件。

## 手动命令

手动命令适合验证和脚本化工作流。请先把 `$SkillDir` 设为 skill 的安装目录。

### 生成与编辑

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Editorial illustration about urban shade, clear focal subject, no text" `
  -f "outputs/urban-shade.png" `
  --aspect 4:3 `
  --resolution 2K `
  --quality high

python "$SkillDir/scripts/imagegen.py" edit `
  -p "Convert this product photo into a clean catalog cutout" `
  -i "input.png" `
  -f "outputs/product-cutout.png" `
  --asset `
  --transparent
```

### 批量生成

```powershell
python "$SkillDir/scripts/imagegen.py" batch `
  --input "examples/batch.example.jsonl" `
  --out "outputs/imagegen" `
  --concurrency 3
```

批处理行可以设置 `qa`、`components`、`delivery_size`、`grid`、`expected_count`、`resample`、`fit` 和 `safe_margin`。命令会写出 `manifest.json`；交付文件位于 `files`，API 原图保留在 `original_files`。

### 检查与验证

```powershell
python "$SkillDir/scripts/imagegen.py" inspect-image "input.png" `
  --components `
  --expected-size 512x512 `
  --expect-transparent
```

`--expected-size` 检查精确尺寸。`--expect-transparent` 要求图片包含可见内容和真实 alpha。`--components` 为商品抠图、标志、界面元素和游戏素材等独立主体增加连通组件诊断。

QA 只检查确定性的技术指标，不判断审美、身份、布局或语义一致性。API 返回 PNG 验证、深度检查和本地变换使用同一解析器：支持不超过 2500 万像素、PNG 文件不超过 256 MiB 的非交错 8 位 RGB/RGBA。带 `tRNS` 透明色块的 RGB PNG 会被明确拒绝，不会按不透明图片处理。

### 准备交付文件

```powershell
python "$SkillDir/scripts/imagegen.py" normalize "input.png" `
  --delivery-size 512x512 `
  --fit contain `
  --safe-margin 0.03 `
  --resample bilinear `
  --out "outputs/final.png"

python "$SkillDir/scripts/imagegen.py" split-grid "sheet.png" `
  --grid 3x3 `
  --delivery-size 256x256 `
  --expected-count 9 `
  --resample bilinear `
  --out-dir "outputs/candidates"
```

`stretch` 会填满精确交付尺寸。`contain` 在透明画布上保持宽高比。使用 `contain` 时，`--safe-margin` 会在每条边保留指定比例的边距。默认重采样方式是 `bilinear`；需要有意复制像素时使用 `nearest`。

`generate`、`edit` 和 `batch` 也支持这些交付参数。添加 `--qa` 会附加 `qa.v1` 结果，不会改变生成成功状态或重试请求。透明请求包含交付变换时，QA 会分别检查 API 源图和交付图，透明留白不能让不透明源图误判通过。

### 生成预览板

```powershell
python "$SkillDir/scripts/imagegen.py" preview-board "input.png" `
  --size 64x64 `
  --size 256x256 `
  --preview-background transparent `
  --preview-background white `
  --preview-background checker `
  --out-dir "outputs/previews"
```

输出目录包含每种尺寸和背景组合、汇总预览板以及 `preview-manifest.json`。

## 配置字段

`auth.json` 的关键字段：

| 字段 | 用途 |
| --- | --- |
| `base_url` | OpenAI 兼容 API 基础地址，通常以 `/v1` 结尾 |
| `api_key` / `api_key_env` | 本地密钥或环境变量名 |
| `model` | 默认图片模型 |
| `user_agent` | 图片 API 和图片 URL 请求使用的 HTTP 客户端标识 |
| `url_download.proxy_mode` | 默认使用 `environment`，也可明确设置为 `direct` 直连下载 |
| `capabilities.transparent_background` | 声明后端是否支持透明背景请求 |
| `defaults.*` | 默认尺寸、比例、分辨率、质量、格式、超时和并发数 |
| `postprocess.enabled` | 允许执行已请求的生成结果后处理 |

如果图片 URL 通过代理反复出现 TLS EOF，可为单次命令明确使用 `--allow-direct-url-download`，或为已确认的供应商设置 `url_download.proxy_mode="direct"`。图片 API 请求仍使用正常网络路径。

## 支持的命令

| 命令 | 用途 |
| --- | --- |
| `info` | 显示打码后的配置摘要 |
| `generate` | 根据提示词生成图片 |
| `edit` | 编辑一张或多张参考图 |
| `batch` | 执行 JSONL 生成和编辑任务 |
| `inspect-image` | 检查 PNG 属性和可选预期 |
| `normalize` | 写出精确尺寸的 PNG 交付文件 |
| `split-grid` | 把显式网格拆成独立 PNG 文件 |
| `preview-board` | 渲染目标尺寸和背景预览 |

详细行为见 [提示词参考](references/prompting.md)、[参数参考](references/parameters.md)、[后处理参考](references/postprocess.md)和 [QA 参考](references/qa.md)。

## 质量检查

```powershell
python -m unittest discover -s tests
python -m compileall -q scripts
```

这些检查不会调用图片 API。

版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT License](LICENSE)
