<!-- updated: 2026-08-25 -->
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
| `base_url` | OpenAI-compatible 服务的基础 URL |
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

### 配置 Atlas Cloud

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

生成前在环境变量中设置 `ATLASCLOUD_API_KEY`。示例不会把凭据写入文件。

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

从已安装 Plugin 的 `skills/openai-compatible-imagegen/references/config.example.json` 开始配置。其中的 `proxy` 对象用于演示可选 provider 代理；删除该对象即可保持环境代理行为。

API Key 用户基线声明活动 profile、provider、provider 自定义的 model ID、认证、默认值、透明策略、资源限制和存储。仅使用 ChatGPT 的基线可以省略活动 profile、providers 和 models。活动 profile 和 model 由用户配置决定，代码不会锁死标准名称。API 凭据优先使用环境变量。

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

使用 `"apikey"` 走已配置的 OpenAI 兼容 provider，使用 `"chatgpt"` 通过 Codex App 宿主生成图片并提交语义画布编辑。ChatGPT 项目可以省略 provider 和 model 字段。两条路线都支持把画布 mask 标注作为编辑提示。所选模型声明专用 mask 能力时，API Key 编辑会传递对应参数；未声明时，标记区域仍作为语义提示发送。结果对提示的遵循程度由所选生图模型决定。API Key 项目还可以使用批处理和多候选。路线由用户明确选择，某条路线不可用时不会自动切换。

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

### 通过 MCP 配置

Codex Plugin 提供三个配置工具，Agent 无需定位 Plugin 安装目录即可完成设置：

- `initialize_image_config` 仅在文件不存在时创建 `~/.codex/openai-compatible-imagegen/config.json`。把 `authMode` 设为 `"apikey"` 或 `"chatgpt"`；默认值为 `"apikey"`。它会在用户配置目录中创建或验证内容仅为 `*` 的 `.gitignore`。传入 `projectRoot` 时，它会用相同方式保护项目配置目录，不修改项目根 `.gitignore`。
- `inspect_image_config` 以脱敏数据读取用户文件和可选项目覆盖，绝不返回 `api_key`。
- `update_image_config` 按运行时绑定使用的同一 schema 和范围规则更新用户或项目文件。写入前会创建或验证目标配置目录的本地 `*` 忽略规则。凭据优先使用 `api_key_env`；用户明确选择本地明文存储时，工具可以写入用户级 `api_key`，但不会返回该值。项目凭据和不允许的项目字段会被拒绝。

初始化后，API Key 用户设置配置中 provider 的 `api_key_env` 环境变量；仅使用 ChatGPT 的用户可以在没有 provider 和 API key 时直接绑定项目。然后让 Agent 查询配置并绑定项目。每次配置写入都会保护用户和项目配置目录。更新后重新绑定项目，使运行时使用新的配置摘要。查询和更新结果不会输出 API key。API Key 配置结果包含活动 profile、model ID、透明声明、重试开关和本地交付设置；仅使用 ChatGPT 的结果报告选中的宿主路线和本地交付设置。

`storage.output_directory` 必须是项目内的相对目录，默认值为 `output/imagegen/`。项目绑定会在解析后的输出目录中创建或验证内容仅为 `*` 的 `.gitignore`，让图片、提示词、标注和 metadata 保持本地。已有规则不兼容时会停止绑定，不会覆盖该规则。绝对路径、项目根目录、项目外路径、文件、符号链接、junction 和其他 reparse point 都会被拒绝。

## 后端契约

默认 `openai-compatible` 协议要求：

- `POST /v1/images/generations`
- `POST /v1/images/edits`

响应可以返回 `data[].b64_json` 或 `data[].url`。运行时下载返回 URL 时不会转发图片 API 凭据。

`atlas` 协议对每个候选只提交一次 `POST /api/v1/model/generateImage`，再通过 `GET /api/v1/model/result/{request_id}` 有界退避轮询到完成。提交失败不会自动重试；只有结果 GET 的临时失败可以重试。Atlas 输出 URL 会进入现有响应处理流程。当前 Atlas 适配器支持输出 JPEG 或 PNG 的文生图；编辑和原生透明请求会在任何网络请求前停止。

透明是用户的交付意图。使用 `native-alpha` 时，只有用户提出透明需求才会发送 `background=transparent` 和 PNG 输出，并附加真实 Alpha 通道提示词。可选的 `transparency.native.model_ids` 只是能力声明，不是代码白名单；明确请求原生路线时会把请求发给配置中的模型，是否支持由 provider 决定。provider 因透明参数返回 HTTP 400/422 时，默认使用相同模型和 endpoint 去掉该参数重试一次，再按 `fallback_route` 进入本地透明处理；设置 `retry_without_parameter=false` 可关闭重试。最终结果会说明拒绝、重试、最终路线和 QA。迁移时仍会拒绝旧的 `transparent_background` 配置。

## 配置结果

完成配置后开始一个新任务，并要求 Agent 列出已配置的图片模型或查看脱敏运行时摘要。不要在会话中粘贴凭据。
