# 配置

> 上级：[用户指南](./README.zh-CN.md)

[English](./configuration.md) | 简体中文

只配置已经安装的发行包。Standalone Skill 和 Codex Plugin 不会扫描、合并或回退到对方的配置。

## 配置 Standalone Skill

Standalone Skill 从安装目录读取 `auth.json`。

1. 使用当前平台的命令，从已安装的 Skill 运行设置向导。

Windows PowerShell：

```powershell
python "C:/path/to/openai-compatible-imagegen/scripts/quick-init.py"
```

macOS 或 Linux shell：

```bash
python3 "/absolute/path/to/openai-compatible-imagegen/scripts/quick-init.py"
```

2. 或把 `examples/auth.example.json` 复制到 `<skill-root>/auth.json`，然后设置：

| 字段 | 用途 |
| --- | --- |
| `protocol` | `openai-compatible`（默认）或 `atlas` |
| `base_url` | 所选图片服务的基础 URL |
| `model` | provider 自定义的图片模型 ID；接受任意非空 ID |
| `api_key_env` | 保存凭据的首选环境变量 |
| `api_key` | 明确选择本地明文存储时使用的可选凭据 |

3. 使用相同的平台映射查看脱敏后的有效配置。

Windows PowerShell：

```powershell
python "C:/path/to/openai-compatible-imagegen/scripts/imagegen.py" info
```

macOS 或 Linux shell：

```bash
python3 "/absolute/path/to/openai-compatible-imagegen/scripts/imagegen.py" info
```

命令参数覆盖 `auth.json` 默认值。每行 JSONL 字段覆盖共享批处理参数。

### 配置 provider 代理

不声明 `proxy` 时，运行时保持环境代理行为。如需让该 provider 使用指定 HTTP 代理和端口，在 `auth.json` 中加入：

```json
{
  "proxy": {
    "url": "http://127.0.0.1:7890"
  }
}
```

生成请求、编辑请求和 provider 返回的图片 URL 下载都会使用该代理。`proxy.url` 必须是包含主机的完整 `http://` 或 `https://` URL；显式端口必须有效。配置不接受 SOCKS URL、凭据、路径、query、fragment 或控制字符。

`url_download.proxy_mode` 默认为 `environment`。在该模式下，已配置 `proxy.url` 时下载使用指定代理，否则使用环境代理。如果 provider 返回的图片 URL 通过代理重复发生 TLS EOF，可以使用 `--allow-direct-url-download` 批准一次直连下载。只有在确认该 provider 的 URL 路线后，才把持久模式设为 `direct`。`direct` 只覆盖返回图片的下载路线；生成和编辑请求仍使用 `proxy.url`。

指定代理请求失败后，运行时返回原始网络错误，不会改用环境代理或直连。脱敏配置摘要和公开错误详情不会显示代理 URL。

## 配置 Codex Plugin

Plugin 从以下固定路径读取配置：

| 范围 | 路径 | 是否必需 |
| --- | --- | --- |
| 用户基线 | `~/.codex/openai-compatible-imagegen/config.json` | 是 |
| 项目覆盖 | `<project>/.codex/openai-compatible-imagegen/config.json` | 否 |

先在会话中说明要使用的路线，例如：“为这个项目配置 OpenAI-Compatible Images，使用 ChatGPT 路线。”使用 API Key 时，提供服务地址、模型 ID 和保存凭据的环境变量名称，密钥值不要发到会话中。Codex 会创建缺失的配置，保留已有设置，并返回脱敏摘要。

需要手动配置时，可参考已安装 Plugin 中的 `skills/openai-compatible-imagegen/references/config.example.json`；其中的代理只是示例，保留环境代理时应删除 `proxy` 对象。

API Key 用户基线声明活动 profile、provider、provider 自定义的 model ID、认证、默认值、透明策略、资源限制和存储。仅使用 ChatGPT 的基线可以省略活动 profile、providers 和 models。API 凭据优先使用环境变量。

使用 `auth_mode` 选择默认图片路线：

```json
{
  "config_version": 1,
  "auth_mode": "chatgpt",
  "defaults": { "size": "1536x1024", "quality": "auto", "output_format": "png" },
  "postprocess": { "enabled": true },
  "storage": { "output_directory": "output/imagegen" }
}
```

使用 `"apikey"` 走已配置的图片 API provider，使用 `"chatgpt"` 通过 Codex App 宿主生成图片并提交语义画布编辑。ChatGPT 项目可以省略 provider 和 model 字段。两条路线都支持把画布 mask 标注作为编辑提示。API Key 编辑需要所选模型支持编辑；Atlas 只支持生成。模型声明专用 mask 能力时会传递对应参数，其他情况将标记区域作为语义提示发送。结果对提示的遵循程度由所选生图模型决定。API Key 项目还可以使用批处理和多候选。路线由用户明确选择，某条路线不可用时不会自动切换。

如需让一个 Plugin provider 使用指定代理，在用户基线的 provider 中加入：

```json
{
  "providers": {
    "primary": {
      "proxy": {
        "url": "http://127.0.0.1:7890"
      }
    }
  }
}
```

两个发行包使用相同的代理校验和请求路线。Plugin 项目配置不能声明或覆盖 `proxy`。修改用户级代理后，重新绑定项目，使运行时采用新的配置摘要。配置查询只报告是否已配置代理，不返回代理 URL。

项目文件只能覆盖：

- `defaults.size`
- `defaults.quality`
- `defaults.output_format`
- `storage.output_directory`

项目文件不能替换活动 profile、provider、model、endpoint、proxy、认证来源、凭据环境变量、timeout、concurrency 或路线权限。不允许的覆盖会在网络请求前停止。

### 检查和修改配置

初始化后，API Key 用户需要在启动 Codex 的环境中设置 `api_key_env` 指定的变量；ChatGPT 路线不需要 API 凭据。让 Codex 使用 `inspect_image_config` 检查当前配置，并绑定这个项目。需要修改时直接说明新设置，Codex 使用 `update_image_config` 应用修改后刷新项目绑定。无需另建任务。

配置工具不会返回密钥。用户配置和项目配置目录在写入时会受到内容仅为 `*` 的 `.gitignore` 保护，项目根目录的忽略规则保持不变。只有明确选择时，才在用户配置中保存本地明文凭据。

`storage.output_directory` 必须是项目内的相对目录，默认值为 `output/imagegen/`。项目绑定会在解析后的输出目录中创建或验证内容仅为 `*` 的 `.gitignore`，让图片、提示词、标注和 metadata 保持本地。已有规则不兼容时会停止绑定，不会覆盖该规则。绝对路径、项目根目录、项目外路径、文件、符号链接、junction 和其他 reparse point 都会被拒绝。

## 配置 MuAPI

MuAPI 提供 OpenAI 兼容的图片生成接口。请使用 `openai-compatible` 协议，并将 `base_url` 设置到 `/v1` 这一层；运行时会自动追加 `/images/generations`。下面的示例使用 `flux-schnell` 模型，并将路线声明为仅生成，因为这一路线不提供图片编辑、mask 或多参考图输入。

Standalone `auth.json` 可以配置为：

```json
{
  "protocol": "openai-compatible",
  "base_url": "https://api.muapi.ai/v1",
  "api_key_env": "MUAPI_API_KEY",
  "model": "flux-schnell",
  "capabilities": {
    "generate": true,
    "edit": false,
    "mask": false,
    "multi_reference": false
  },
  "defaults": {
    "size": "1024x1024",
    "quality": "medium",
    "output_format": "png"
  }
}
```

Codex Plugin 在用户基线中配置同一个 endpoint：

```json
{
  "config_version": 1,
  "auth_mode": "apikey",
  "active_profile": "primary/flux-schnell",
  "providers": {
    "primary": {
      "protocol": "openai-compatible",
      "base_url": "https://api.muapi.ai/v1",
      "api_key_env": "MUAPI_API_KEY"
    }
  },
  "models": {
    "primary/flux-schnell": {
      "provider": "primary",
      "model": "flux-schnell",
      "capabilities": {
        "generate": true,
        "edit": false,
        "mask": false,
        "multi_reference": false
      }
    }
  },
  "defaults": { "size": "1024x1024", "quality": "medium", "output_format": "png" },
  "postprocess": { "enabled": true },
  "transparency": { "default_route": "chroma-matting" },
  "storage": { "output_directory": "output/imagegen" }
}
```

生成前在环境变量中设置 `MUAPI_API_KEY`。MuAPI 图片接口会在任务处理完成后返回图片 URL；运行时下载这些 URL 时不会转发 API key。需要透明输出时，请使用本地透明处理路线。当前接口和模型详情请参阅 [MuAPI 图片 API](https://muapi.ai/ai-image-api) 和 [API 参考](https://muapi.ai/docs/api-reference)。

## 配置 Atlas Cloud

Atlas Cloud 是可选的 API Key 文生图 provider。Standalone `auth.json` 可以配置为：

```json
{
  "protocol": "atlas",
  "base_url": "https://api.atlascloud.ai",
  "api_key_env": "ATLASCLOUD_API_KEY",
  "model": "openai/gpt-image-2/text-to-image",
  "capabilities": {
    "generate": true,
    "edit": false,
    "mask": false,
    "multi_reference": false
  },
  "defaults": {
    "size": "1024x1024",
    "quality": "medium",
    "output_format": "png"
  }
}
```

Codex Plugin 在用户基线中配置同一个 provider 和 model：

```json
{
  "config_version": 1,
  "auth_mode": "apikey",
  "active_profile": "primary/gpt-image-2",
  "providers": {
    "primary": {
      "protocol": "atlas",
      "base_url": "https://api.atlascloud.ai",
      "api_key_env": "ATLASCLOUD_API_KEY"
    }
  },
  "models": {
    "primary/gpt-image-2": {
      "provider": "primary",
      "model": "openai/gpt-image-2/text-to-image",
      "capabilities": {
        "generate": true,
        "edit": false,
        "mask": false,
        "multi_reference": false
      }
    }
  },
  "defaults": { "size": "1024x1024", "quality": "medium", "output_format": "png" },
  "postprocess": { "enabled": false },
  "transparency": { "default_route": "chroma-matting" },
  "storage": { "output_directory": "output/imagegen" }
}
```

生成前在环境变量中设置 `ATLASCLOUD_API_KEY`。

## 图片服务要求

默认 `openai-compatible` 协议使用以下接口；需要的操作必须由服务及所选模型支持：

- `POST /v1/images/generations` — 生成
- `POST /v1/images/edits` — 编辑（需要编辑时）

响应可以返回 `data[].b64_json` 或 `data[].url`。运行时下载返回 URL 时不会转发图片 API 凭据。

Atlas 协议支持输出 JPEG 或 PNG 的文生图。它不支持编辑和原生透明；需要透明结果时选择本地透明处理。

## 透明设置

新建的 OpenAI-compatible API Key 模板默认启用原生透明；安装和更新会保留已有配置。希望旧配置也启用时，可让 Codex 合并以下设置。ChatGPT 路线不使用这些供应商参数；Atlas 需使用本地透明路线。

```json
{
  "transparency": {
    "default_route": "native-alpha",
    "native": {
      "enabled": true,
      "retry_without_parameter": true,
      "fallback_route": "chroma-matting"
    }
  }
}
```

透明是用户的交付意图。使用 `native-alpha` 时，只有用户提出透明需求才会发送 `background=transparent` 和 PNG 输出，并附加真实 Alpha 通道提示词。可选的 `transparency.native.model_ids` 只是能力声明，不是代码白名单；明确请求原生路线时会把请求发给配置中的模型，是否支持由 provider 决定。provider 因透明参数返回 HTTP 400/422 时，默认使用相同模型和 endpoint 去掉该参数重试一次；设置 `retry_without_parameter=false` 可关闭重试。最终结果会说明拒绝、重试、最终路线和 QA。迁移时仍会拒绝旧的 `transparent_background` 配置。

重试会保留你对本地后处理的选择。允许处理时，按 `fallback_route` 处理图片，并保留原图和通过检查的处理图。设置 `postprocess.enabled=false`，或在 Standalone 中明确传入 `--no-postprocess` 时，只检查返回图片的透明情况；图片不透明就保留原图并报告未满足透明要求。Standalone 的 `--postprocess` 可为当前请求开启本地处理。这些处理开关不会改变 API 重试设置。

Standalone 仍有一处限制：首次原生请求成功但图片不透明时，会报告未满足透明要求。Plugin 生成在允许本地处理时，可以尝试回退处理。

## 配置结果

- Plugin：让 Codex 在当前任务中查看脱敏摘要并刷新项目绑定，确认路线、API 模型（如适用）、交付设置和输出目录符合预期。
- Standalone：上文的 `info` 命令会报告已安装 Skill 目录中配置的模型和设置。

遇到错误时按[故障排查](./troubleshooting.zh-CN.md)处理。
