# 多供应商与模型选择

> 上级：[用户指南](./README.zh-CN.md)

[English](./models.md) | 简体中文

这些配置只用于 API Key 路线。ChatGPT 路线继续通过 Codex 内置图片能力执行，不读取 API 模型、供应商端点或原生参数表。

## 配置模型

`config_version: 2` 将连接配置放在 `providers`，将具体模型与默认图片参数放在 `models`。Plugin 使用用户配置文件；Standalone 可以在自己的 `auth.json` 中使用相同结构。旧的 v1 配置和 Standalone 单供应商配置继续可读，不会被自动改写。

下面是 Plugin 的 API Key 配置示例。Standalone 复用 `providers`、`models` 和默认值结构，但省略 Plugin 专属的 `auth_mode`、`canvas_submission_mode` 和 `host_defaults`；Standalone 只调用 API，不提供 ChatGPT 订阅路线。Plugin 若要默认使用内置生图，可将 `auth_mode` 改为 `chatgpt`，并保留 API 配置供显式选择。

```json
{
  "config_version": 2,
  "auth_mode": "apikey",
  "active_profile": "studio/gpt",
  "providers": {
    "studio": {
      "display_name": "工作室图片服务",
      "protocol": "openai-compatible",
      "base_url": "https://images.example.com/v1",
      "api_key_env": "STUDIO_IMAGE_KEY"
    },
    "google": {
      "display_name": "Google",
      "protocol": "gemini-generate-content",
      "base_url": "https://generativelanguage.googleapis.com/v1beta",
      "api_key_env": "GOOGLE_IMAGE_KEY"
    }
  },
  "models": {
    "studio/gpt": {
      "provider": "studio",
      "model": "gpt-image-2",
      "display_name": "工作室绘图",
      "aliases": ["工作室", "studio"],
      "capabilities": { "generate": true, "edit": true, "mask": true, "multi_reference": true },
      "defaults": { "size": "1024x1024", "quality": "medium", "output_format": "png" }
    },
    "google/image": {
      "provider": "google",
      "model": "gemini-3.1-flash-image",
      "display_name": "Google 图片",
      "aliases": ["谷歌图片"],
      "capabilities": { "generate": true, "edit": true, "mask": false, "multi_reference": true },
      "defaults": { "aspect_ratio": "1:1", "resolution": "1K" }
    }
  },
  "defaults": { "timeout_seconds": 600, "concurrency": 3 }
}
```

示例服务地址需替换为实际服务，模型 ID 需与服务支持的值一致。模型名称、显示名称、别名和稳定 profile ID 各自独立；同一实际模型可在不同供应商下配置多个 profile。凭据只属于 provider。即使两个 provider 当前使用相同地址，也可以分别配置。

| 协议 | 生成与编辑传输 | 基础 URL 后追加的路径 |
| --- | --- | --- |
| `openai-compatible` | JSON 生成、multipart 编辑 | `images/generations`、`images/edits` |
| `atlas` | 异步生成并查询结果；不支持编辑 | `api/v1/model/generateImage`，随后查询 Atlas 结果路径 |
| `xai-images` | JSON 生成与编辑，源图使用 data URI | `images/generations`、`images/edits` |
| `gemini-interactions` | 同步 Interactions，`store=false` | `interactions` |
| `gemini-generate-content` | 独立的 generateContent 请求与响应格式 | `models/{model}:generateContent` |

协议按配置选择，不从模型名称或服务域名推测。新增使用已有协议的供应商或模型只需修改配置；新的传输协议需要增加对应适配器。两种 Gemini 协议不会相互回退。Gemini 使用 `x-goog-api-key`，其余列出的协议使用 Bearer 认证。

provider 可通过 `endpoints.generate` 和 `endpoints.edit` 分别声明完整 URL；`{model}` 会替换成经过 URL 编码的模型 ID。不声明时使用表中的默认路径，不自动补 `/v1`。Atlas 的 generate 覆盖仅改变提交端点，结果查询仍使用配置的基础 URL。

## 默认值与参数字段

v2 的 API 透明策略位于 `models[profileId].transparency`。顶层 `transparency` 用于 Plugin 宿主图片与独立本地交付，不会覆盖 API profile；顶层 `postprocess.enabled` 仍控制本地透明处理权限。`native-alpha` 目前仅由 OpenAI-compatible 协议传输，Atlas、xAI 和 Gemini 不支持该专用参数。详见[透明设置](./configuration.zh-CN.md#透明设置)。

v2 顶层 `defaults` 只含超时与并发。图片参数放在每个模型的 `defaults`，宿主与本地输出偏好放在 `host_defaults`。原生协议只接收其实现的通用字段：xAI 使用比例、分辨率与质量；Gemini Interactions 使用比例、分辨率与格式；generateContent 使用比例与分辨率。需要精确像素尺寸时，对受支持的 PNG 使用独立本地交付选项；本地交付不提供 JPEG、WebP 转码。

通用单次请求通过 Plugin 的 `size`、`aspectRatio`、`resolution`、`quality`、`format` 或 Standalone 的对应 CLI 参数传入。同一优先级不能同时指定 `size` 与比例/分辨率。更高优先级的尺寸表达会替换较低优先级的另一种表达。v2 不为将来的模型维护质量、比例或分辨率值白名单；实际可用值由所选服务决定。v1 与 Atlas 保留既有质量校验，输出文件格式仍限于 PNG、JPEG、WebP。

原生扩展字段放入模型的 `parameters`，单次请求的 `parameters` 覆盖配置中的对应字段。嵌套对象按字段合并；模型、提示词、图像输入、数量、认证与路由字段不能借此替换。通用请求中已确定的字段优先。不要把密钥放在参数中。

`parameter_fields` 可以为参数声明画布控件。例如在 generateContent profile 内加入：

```json
{
  "parameter_fields": {
    "seed": {
      "title": "随机种子",
      "description": "使用服务支持的整数值",
      "type": "integer",
      "path": ["generationConfig", "seed"],
      "minimum": 0,
      "default": 7
    }
  }
}
```

字段类型可为 `string`、`integer`、`number`、`boolean`、`object`、`array`。`path` 指向原生 JSON 字段，不能相互覆盖；`default`、`enum`、`minimum`、`maximum` 描述配置与控件。`enum` 是参数提示，不作为服务端未来取值的封锁名单。声明字段不保证服务已支持它。

`capabilities` 表达该 profile 的用途，`limits.max_input_images` 可限制父图与参考图的总数。协议实现仍限制真实能力：Atlas 无编辑能力，xAI 与 Gemini 当前没有专用 mask 参数。普通区域标注可以继续用于语义编辑，不能据此承诺严格像素边界。

## 本次选择与草稿

在聊天中说明模型或别名。Plugin 的 `list_image_models` 返回全部已配置 profile、供应商、显示名称、别名、有效能力、默认值及参数字段，不会发送图片请求或探测模型在线状态。匹配顺序是精确 profile ID、唯一别名、唯一实际模型 ID。同名模型有多个渠道时需明确选择。

画布选择 API Key 后会读取已配置模型，展开选择器即可查看全部选项、当前选择和默认模型，也可以搜索名称、别名、实际模型 ID、profile ID 或供应商。不支持当前编辑的模型会显示原因。目录读取失败或没有已配置模型时会显示对应提示，可点击“重新读取”；搜索没有匹配项时可修改或清空关键词。

模型和参数只用于本次编辑，不改变 `active_profile`。选择随草稿保存；仅选择模型而没有标注或补充要求时不能提交。切换到 ChatGPT 会隐藏 API 控件，保留返回 API Key 时的本次选择。

来源记录包含准确的 profile 和选择指纹时，画布可恢复其来源模型；旧图和导入图不会凭模型字符串猜测渠道。保存的 profile 被删除或配置已改变时需要重新选择。提交后，服务端会校验模型、参数、路线与提交 ID 的绑定，不能用旧提交悄悄换模型。

Standalone 可运行 `imagegen.py list-models` 查看目录，使用 `--profile` 指定 profile 或唯一别名，使用 `--parameters '{"seed":7}'` 传入单次扩展参数。JSONL 行可设置 `modelProfileId` 和 `parameters`，各行独立选模。

配置升级参见[迁移](./migration.zh-CN.md)。生成与编辑后仍需按[图片任务](./image-jobs.zh-CN.md)查询所有结果、保留原图，并展示用户需要的完整交付集合。
