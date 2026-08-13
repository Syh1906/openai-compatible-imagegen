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

图片响应可以包含 `data[].b64_json` 或 `data[].url`。单次请求支持 `n=1..16`。JSON 响应上限为 96 MiB，解码或下载后的单张图片上限为 64 MiB，整批解码后累计上限为 256 MiB，最多处理 64 个响应项。每项会依次解码、校验并发布，因此后续项触发上限或目标冲突时，已发布原图仍会保留。PNG 最多接受 4096 个 `IDAT` 分块；完整扫描线校验使用 96 MiB 工作预算，低内存精确长度校验覆盖到 512 MiB 解压扫描线，超过后会返回明确的资源上限错误。WebP 发布会检查 RIFF 容器和声明的分块边界；VP8 额外检查关键帧、尺寸和第一分区边界，VP8L 则执行完整且有界的熵码流校验。后端返回的数量、像素尺寸或格式与请求不一致时，仍会发布实际原图并记录偏差。图片 URL 不会收到 API 凭据。

请求参数支持精确像素尺寸、比例与分辨率预设、质量、输出格式、透明交付意图、moderation 和 compression。透明交付在 API 返回后通过明确的本地路线处理；经过验证的精确组合也可以使用提示词引导真实 alpha，但不会作为透明背景参数发送给 API。

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
  "postprocess": {
    "enabled": false
  },
  "transparency": {
    "default_route": "chroma-matting",
    "prompt_only_allow": [],
    "llm_assisted": {
      "enabled": false,
      "max_attempts": 2,
      "allow_parameter_tuning": true,
      "allow_route_change": true,
      "allow_api_retry": false
    }
  }
}
```

`api_key` 用于把密钥保存在本地配置中；`api_key_env` 用于填写环境变量名。运行 `info` 可查看打码后的配置摘要：

```powershell
$SkillDir = "/path/to/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" info
```

旧的 `capabilities.transparent_background` 配置和 `background=transparent` 请求值都已移除，不要把它们转换成 API 参数。`postprocess.enabled` 控制默认是否允许本地透明路线修改像素。关闭本地处理时，透明请求仍会正常调用 API：精确命中白名单时可以追加 alpha 提示词，否则保留用户原提示词，只检查返回原图是否自带有效 alpha。只有在确认后端确实支持提示词 alpha 后，才在 `transparency.prompt_only_allow` 中填写精确的 `model`、`mode` 和 `size` 组合。

请求透明结果且允许本地处理时，会在 API 图片写入后执行选定路线，并不只依赖色键。受控纯色底使用颜色范围抠图，黑底发光特效使用亮度转 Alpha，已有蒙版时可读取 Alpha、亮度或指定 RGB 通道，覆盖传统通道选区与图层蒙版工作流。共享的 8 位 Alpha 流水线按路线组合扩缩边、羽化、小组件清理、已知黑白底 Remove Matte、Defringe 和多背景检查。可信蒙版会保护完全不透明前景，清理只作用于半透明边缘。毛发、玻璃、半透明布料以及前景与烟雾混合的复杂背景，需要受控底板或可信蒙版；条件不足时返回原图并标记未满足，不会猜测成功。`--no-postprocess` 不会阻止 API 请求或隐藏原图，2K/4K 也不会为了提示词降级。

透明检查未通过时，API 原图会原样返回，并记录 `ok=true`、`transparency.status=unmet` 和 `delivery_ready=false`。skill 只告知实际状态，不拒绝或隐藏图片。

可选的 `transparency.llm_assisted` 允许 Agent 查看未达标结果，并在限定次数内调整路线或参数。所有尝试仍需通过原有质量检查；只有设置 `allow_api_retry=true` 时才会再次请求图片 API。

## 向 Agent 提需求

用自然语言说明主体、视觉方向、最终尺寸、透明度、数量、检查要求和输出目录。

- “生成一张 `16:9`、`2K` 的新品发布横幅，再交付 `1200x675` PNG 到 `outputs/campaign`。”
- “把这张商品照片处理成透明底 `512x512` PNG，四周保留 3% 安全边距。确认真实 alpha，并生成白色、黑色和棋盘格背景预览。”
- “按这些提示词批量生成 4 张公共交通主题编辑插图，并保存 batch manifest。”
- “创建一个方形品牌标志，报告连通组件和边缘接触，再生成 `64x64` 与 `256x256` 预览。”
- “生成一张 `3x3` 的 UI 概念图，并拆成 9 张 `256x256` PNG。”
- “创建一个幻想策略游戏的冰霜技能图标，不要文字，并交付 `64x64` 和 `128x128` 预览。”

生成尺寸和交付尺寸相互独立。你可以先生成较大的源图，再输出精确尺寸的本地交付文件。如果后端返回了其他源图尺寸，仍会发布实际原图并记录尺寸偏差；显式 `delivery_size` 可以继续生成单独的派生文件。

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
  --transparent `
  --postprocess
```

### 批量生成

```powershell
python "$SkillDir/scripts/imagegen.py" batch `
  --input "examples/batch.example.jsonl" `
  --out "outputs/imagegen" `
  --concurrency 3
```

批处理行可以设置 `postprocess`、`transparency_route`、`transparency_mask`、`transparency_options`、`qa`、`components`、`delivery_size`、`grid`、`expected_count`、`resample`、`fit` 和 `safe_margin`。命令会写出 `manifest.json`。`original_files` 列出全部已发布 API 源图；`files` 按顺序包含源图及其成功派生图，`derived_files` 只列派生图。转换或透明检查失败时仍保留源图，并记录 `delivery_ready=false`。`api_delivery` 会保留请求值与实际数量、格式、尺寸、路径及警告。

批处理路径使用两个明确基准：JSONL 中的 `images`、`mask` 和 `transparency_mask` 相对于 JSONL 文件目录；任务级或共享的 `file`、`out` 和 `postprocess_out_dir` 相对于 batch `--out`。绝对路径保持不变。manifest 会记录解析后的 `output_root`，并检查每个已声明的文件路径。输出冲突会在生成前报错。API 原图逐项独立发布；某张转换失败时返回该原图，其他成功派生图继续保留；全局文件数量和 QA 要求仍作用于完整派生结果集。

### 对已有图片应用透明处理

```powershell
python "$SkillDir/scripts/imagegen.py" apply-transparency "effect.png" `
  --out "outputs/effect-transparent.png" `
  --route emissive-alpha `
  --transparency-param "black_point=8" `
  --transparency-param "gamma=1.2"
```

处理未达标时，命令会返回源图路径和 `delivery_ready=false`，不创建 `--out` 副本，并保持成功退出，让源图可以连同 warning 一起返回。

### 检查与验证

```powershell
python "$SkillDir/scripts/imagegen.py" inspect-image "input.png" `
  --components `
  --expected-size 512x512 `
  --expect-transparent
```

`--expected-size` 检查精确尺寸。`--expect-transparent` 要求图片包含可见内容和真实 alpha。`--components` 为商品抠图、标志、界面元素和游戏素材等独立主体增加连通组件诊断。

QA 只检查确定性的技术指标，不判断审美、身份、布局或语义一致性。深度检查和本地变换支持不超过 2500 万像素、PNG 文件不超过 256 MiB、`IDAT` 分块不超过 4096 个的非交错 8 位或 16 位 RGB/RGBA。处理 16 位输入时，本地解码器会按通道确定性转换为 8 位 RGBA。带 `tRNS` 透明色块的 RGB PNG 会被明确拒绝，不会按不透明图片处理。

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

`generate`、`edit` 和 `batch` 也支持这些交付参数。添加 `--qa` 会附加 `qa.v1` 结果，不会改变生成成功状态或重试请求。透明检查未通过时，会跳过依赖透明结果的交付变换，并原样返回 API 图片；透明成功时，会同时返回 API 原图和最终派生交付图。

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
| `defaults.*` | 默认尺寸、比例、分辨率、质量、格式、超时和并发数 |
| `postprocess.enabled` | 默认允许本地透明处理；不会拦截大尺寸透明请求 |
| `transparency.default_route` | 默认本地透明路线 |
| `transparency.prompt_only_allow` | 允许提示词生成 alpha 的精确模型、模式和尺寸规则 |
| `transparency.llm_assisted.*` | Agent 在限定范围内调整路线和参数的策略 |

如果图片 URL 通过代理反复出现 TLS EOF，可为单次命令明确使用 `--allow-direct-url-download`，或为已确认的供应商设置 `url_download.proxy_mode="direct"`。图片 API 请求仍使用正常网络路径。

透明未达标时，只要 API 图片已经写入，命令仍会保持成功。请先查看 warning 和 manifest 中的 `transparency` 记录，再判断文件是否适合最终使用。

HTTP 4xx 属于 API 拒绝，会记录为 `error_kind=api_rejected` 和 `status_code`；由于此时还没有图片，它不是透明失败。编辑结果或编辑错误可以附带参考图技术元数据，语义状态为 `not_evaluated`。异常长宽比会如实提示，但不会自动拦截请求。

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
| `apply-transparency` | 对已有 PNG 应用指定的本地透明路线 |

详细行为见 [提示词参考](references/prompting.md)、[参数参考](references/parameters.md)、[后处理参考](references/postprocess.md)和 [QA 参考](references/qa.md)。

版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT License](LICENSE)
