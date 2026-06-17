# 参数参考

## 参数优先级

```text
用户明确指定 > 批量任务单行参数 > LLM 根据 prompt 判断后显式传参 > auth.json defaults
```

脚本不负责复杂审美判断。LLM 应该在调用前根据用户目标选择尺寸、质量、格式、是否透明底和并发数。

## 模式

| 模式 | 命令 | 接口 |
|---|---|---|
| 文生图 | `generate` | `POST /v1/images/generations` |
| 图生图/参考图编辑 | `edit` | `POST /v1/images/edits` |
| 批量 | `batch` | 每行任务自动选择 `generate` 或 `edit` |
| 配置摘要 | `info` | 不调用 API |

## 尺寸建议

| 场景 | 建议尺寸 |
|---|---|
| 图标、头像、道具、方形素材 | `1024x1024` |
| 横版 UI 图、游戏概念图、封面草图 | `1536x1024` |
| 竖版海报、手机壁纸、角色立绘 | `1024x1536` |
| 高质量方形成品 | `2048x2048` |
| 2K 横屏成品 | `2048x1152` |
| 2K 竖屏成品 | `1152x2048` |
| 4K 横屏成品 | `3840x2160` |
| 4K 竖屏成品 | `2160x3840` |

如果用户没有指定，LLM 应根据 prompt 选择，而不是机械使用默认值。

## 质量建议

| 质量 | 用途 |
|---|---|
| `low` | 低成本草稿、方向探索、大量变体 |
| `medium` | 普通素材、概念探索、成本和质量均衡的批量生成 |
| `high` | 最终资产、文字密集图、UI、海报、论文图、需要细节稳定的图片 |
| `auto` | 交给后端决定；适合作为 `auth.json` 默认兜底 |

LLM 应优先根据提示词需求显式传质量参数。无法判断时才使用 `auth.json` 默认值。

## 透明底素材

使用 `--asset` 表示素材场景。它会倾向 PNG 输出，适合图标、道具、贴图和 sprite。

使用 `--transparent` 表示透明底素材意图。该参数会强制 PNG，并向 prompt 注入透明底/孤立主体约束。

只有当 `auth.json` 中：

```json
{
  "capabilities": {
    "transparent_background": true
  }
}
```

脚本才额外发送 `background=transparent`。否则不会发送该 API 参数，但仍会保留 prompt 层的透明底意图。

这意味着透明底有两层：

```text
prompt 层：始终可用，让模型生成孤立主体、alpha-friendly 边缘、无背景感
API 参数层：仅当接口声明支持时发送 background=transparent
```

不要因为 prompt 写了透明底就承诺一定得到真实 alpha 通道；真实透明像素取决于后端能力和输出。

## 批量并发

批量是限流并发。默认并发数：

```text
命令行 --concurrency > auth.json defaults.concurrency > 3
```

不要默认开启无限并发。并发过高可能触发限流、失败或费用失控。

## JSONL 字段

| 字段 | 说明 |
|---|---|
| `id` | 任务 ID，用于文件名和 manifest |
| `mode` | `generate` 或 `edit`；省略时有 `images` 则编辑，否则文生图 |
| `prompt` | 提示词 |
| `file` | 输出文件路径 |
| `size` | 图片尺寸 |
| `quality` | `low`、`medium`、`high`、`auto` |
| `n` | 单条任务返回张数 |
| `format` | `png`、`jpeg`、`webp` |
| `background` | `auto`、`opaque`、`transparent` |
| `transparent` | 布尔值，透明底快捷方式 |
| `asset` | 布尔值，素材快捷方式 |
| `images` | 参考图路径数组 |
| `mask` | 遮罩图路径 |
| `model` | 覆盖默认模型 |
| `timeout` | 单请求超时秒数 |

## 输出

脚本输出图片路径，并在批量模式写 `manifest.json`。

单条命令只打印生成文件路径和摘要；批量命令会额外打印 manifest 路径。
