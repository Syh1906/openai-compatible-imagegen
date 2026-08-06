---
name: openai-compatible-imagegen-v2
description: 在 Codex App 会话中生成、编辑和标注 OpenAI-compatible 图片，并从具体图片结果打开聚焦画布。用于图片生成、参考图编辑、mask 编辑、版本查看和继续处理历史图片；首期使用当前项目已支持的 gpt-image-2。不得切换到内置 image_gen 或其他图片路线。
---

# OpenAI-Compatible Image Generation V2

会话是图片生成和连续修改的主入口。聚焦画布只从具体图片结果打开，用于查看图片和表达修改意图。不要在提示中暴露密钥、Authorization 请求头或本机绝对路径。

## 项目绑定

在首次调用任何项目相关工具前，先调用 `bind_imagegen_project`，把当前 Codex 任务的项目根作为 `projectRoot` 传入。项目根必须来自当前任务工作区，不得从插件安装目录、MCP `cwd`、roots、Git 搜索或其他本机状态推断。

同一 MCP 进程重复绑定同一项目会幂等返回；进程已经绑定到另一个项目或项目根校验失败时立即停止，不切换根目录。绑定不依赖宿主会话字段、transport session、roots 或 MCP `cwd`。MCP server 重启后绑定会消失，收到 `project_binding_required` 时先用同一当前项目根重新绑定，再继续原操作；不要改走其他目录或传输路线。

## 路由

1. 生成图片时调用 `generate_image`；成功后只从返回的 `artifacts` 读取稳定图片 ID 和元数据，再按原顺序只调用一次 `render_image_results` 在当前会话显示候选图。生成工具不承担图片字节呈现，不要为了展示再次调用 `get_image_artifact`。
2. 用户要查看或标注某张图片时，直接使用图片结果卡上的“打开画布”入口；不要在已经展示具体图片结果后再次主动调用 `open_image_editor`。该工具仅供结果 widget 内部打开聚焦画布。
3. 编辑已有图片时调用 `edit_image`，并保留父图片 ID；成功后只从返回结果读取稳定 ID 和版本元数据，再只调用一次 `render_image_results` 展示新版本。不要为了展示再次调用 `get_image_artifact`。
4. 读取产物时调用 `get_image_artifact`。该工具只返回数据，不创建结果卡；只有用户需要查看历史图片且没有现成结果入口时，才读取后调用一次 `render_image_results`。
5. 需要查看模型能力时调用 `list_image_models`。
6. 画布明确提交多条标注时，由 widget 一次调用 `save_image_annotations`；未提交标注不得调用该工具。

## 画布提交

收到画布提交消息时，优先读取最新模型上下文中的 `submissionId`、`imageId`、`annotationId`、`prompt`、`annotationCount`、`intents` 和 `requestText`。同一任务存在多条画布上下文时，以当前用户消息对应的最新 `submissionId` 为准，不合并旧提交。把 `imageId` 作为 `edit_image.parentImageId`；`annotationId` 为 `null` 时省略该参数，存在时原样传给 `edit_image`，不得再次调用 `save_image_annotations`。

结合标注预览、各处文字说明和补充要求，整理一条描述完整目标图片的编辑提示，再调用一次 `edit_image`。包含 mask 标注时，提示必须描述完整目标图片，而不只是被替换的局部区域。缺少图片 ID 或无法确定修改意图时停止，不猜测 ID，也不切换到 `generate_image` 或其他图片路线。

`edit_image` 成功后在当前会话展示新图片、稳定图片 ID 和父子版本关系；新结果继续保留“打开画布”入口。

## 画布生命周期

`open_image_editor` 返回 `editorSessionId` 后，把该 ID 视为当前任务中的活动画布会话。

- 用户明确要求销毁画布时，调用 `destroy_image_editor`。
- 当前任务已经明确转移到其他目标，且后续不再需要查看、标注或修改当前图片时，调用 `destroy_image_editor` 释放活动画布。
- 用户只隐藏或关闭右栏、暂时讨论其他内容、等待下一轮生成，或仍可能继续处理当前图片时，不要销毁画布。
- 不知道活动 `editorSessionId` 时不要猜测，也不要调用销毁工具。

画布内的“销毁画布”按钮与 `destroy_image_editor` 使用同一生命周期。销毁会结束该图片的全部活动画布会话，并终止当前 MCP server 生命周期内的重新打开入口；图片产物和版本关系仍然保留。销毁后不要再次为同一图片调用 `open_image_editor` 或 `render_image_results` 试图恢复画布入口。

首期模型为 `gpt-image-2`。模型能力由目录声明，执行失败后不切换模型、端点、供应商或编辑路线。

## V2 配置

配置只从以下路径解析，前者优先：

1. 用户配置 `~/.codex/openai-compatible-imagegen-v2/config.json`
2. 项目配置 `<项目根>/.codex/openai-compatible-imagegen-v2/config.json`

两者都缺失时停止图片操作，并提示用户基于 `references/config.example.json` 创建一份 V2 配置。不得读取、复制或迁移 V1 `auth.json`，也不得在对话中回显 API key。

图片 URL 下载默认使用环境代理。只有用户明确批准后，才允许把 provider 的 `url_download.proxy_mode` 设为 `direct`；该设置只影响 provider 返回的图片 URL 下载，不改变生成或编辑请求的 endpoint、模型、协议和代理路线。不得在 TLS 或网络失败后自动切换该设置。

## 结果

`render_image_results` 是结果 widget 的唯一入口。它接收一个或多个稳定图片 ID，在同一工具结果中按输入顺序返回图片内容和安全元数据，并为未销毁画布的图片提供独立“打开画布”入口。已销毁的图片继续显示结果，但入口显示为不可操作的“画布已销毁”。数据工具 `generate_image`、`edit_image` 和 `get_image_artifact` 不绑定结果 widget；结果 widget 不为初始候选再次调用 `get_image_artifact`。

向用户返回结果中的图片、稳定图片 ID、对应画布入口、版本关系和安全错误摘要。编辑创建新版本，不覆盖父图片。图片和标注保存在当前项目的 `output/imagegen/` 下。
