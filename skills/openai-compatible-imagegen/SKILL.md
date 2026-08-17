---
name: openai-compatible-imagegen
description: 在 Codex App 会话中生成、编辑、标注和交付 OpenAI-compatible 图片，并从具体图片结果打开聚焦画布。用于图片生成、参考图编辑、mask 编辑、透明交付、批处理、版本查看、精确尺寸、网格拆分、预览板、确定性 QA 和继续处理历史图片；首期使用当前项目已支持的 gpt-image-2。不得切换到内置 image_gen 或其他图片路线。
---

# OpenAI-Compatible Images

会话是图片生成和连续修改的主入口。聚焦画布只从具体图片结果打开，用于查看图片和表达修改意图。不要在提示中暴露密钥、Authorization 请求头或本机绝对路径。

## 项目绑定

在首次调用任何项目相关工具前，先调用 `bind_imagegen_project`，把当前 Codex 任务的项目根作为 `projectRoot` 传入。保存返回的 `projectBindingId`，并在本任务后续每个项目工具调用中原样传入。项目根必须来自当前任务工作区，不得从插件安装目录、MCP `cwd`、roots、Git 搜索或其他本机状态推断。

首次不带 ID 的绑定会签发新的随机绑定，因此不得在同一任务中重复首次绑定。配置变化时，携带已有 `projectBindingId` 和同一 `projectRoot` 再次绑定；同项目重绑保持幂等并更新配置摘要，换根直接冲突。MCP 只持久化绑定 ID 的带域摘要，不保存原始 ID。不得用 transport `sessionId`、roots、MCP `cwd`、最近项目或其他本机状态替代、恢复或猜测绑定 ID。

同一 `projectBindingId` 可跨 MCP 进程和 server 重启恢复。收到 `project_binding_required` 或 `project_binding_invalid` 时停止当前操作；不要扫描旧状态或猜测其他 ID。确需重新开始时，只能用当前任务项目根创建新的隔离绑定，并继续使用新返回的 ID；旧画布和提交状态不会自动迁移。App-only 工具由 widget 从标准 `tool-input.arguments.projectBindingId` 取得同一 ID，不依赖宿主私有字段。

## 路由

1. 生成图片时只调用一次 `generate_image`；需要多张候选时在同一次工具调用中传入 `count`。运行时会按顺序执行等量的独立单图请求，全部成功后才返回有序候选组；任一请求失败时整组失败且不保存部分候选，不要自行重试或改成多次 `generate_image` 调用。请求透明交付时传顶层 `transparency`，不要据此设置 `background=transparent`；运行时会在 API 请求前解析路线、增强一次提示词并强制保留 PNG 原图。普通生成成功后按原顺序只调用一次 `render_image_results`；透明生成先对每张原图调用一次 `deliver_image`，再一次性展示通过的派生图。生成工具不承担图片字节呈现，不要为了展示再次调用 `get_image_artifact`。
2. 用户要查看或标注某张图片时，直接使用图片结果卡上的“打开画布”入口；不要在已经展示具体图片结果后再次主动调用 `open_image_editor`。该工具仅供结果 widget 内部打开聚焦画布。
3. 编辑已有图片时调用 `edit_image`，并保留父图片 ID；请求透明交付时同样传顶层 `transparency`，成功后先调用一次 `deliver_image`。普通编辑只从返回结果读取稳定 ID 和版本元数据，再只调用一次 `render_image_results` 展示新版本。不要为了展示再次调用 `get_image_artifact`。
4. 用户一次要求执行多个相互独立、参数不同的生成或普通编辑任务时，只调用一次 `batch_images`。需要透明或其他本地交付时，在对应 item 中同时传 `transparency` 和 `delivery`；从 item 的 `artifacts` 读取 API 原图，从可选 `delivery.results` 读取逐图交付状态和派生图。优先一次性展示 `deliveryReady=true` 的派生图；没有派生图时展示成功原图并报告交付状态。逐项报告失败，不重试失败项。`manifestReady=true` 时保留返回的 `batchId` 供后续回查；`manifestReady=false` 只报告批处理记录未就绪，不得把已经成功发布的原图改判失败。mask 或画布提交继续单独一次 `edit_image`，不得放入批量任务。
5. 已有稳定图片 ID 后，用户要求透明、精确尺寸、`contain`/安全边距、网格拆分、预览板或确定性 QA 时，只调用一次 `deliver_image`。已有原图保存透明计划时直接消费该计划；需要为历史图指定或调整透明路线时传 `delivery.transparency`。派生图发布成功后，从返回的 `artifacts` 读取稳定 ID，并按原顺序只调用一次 `render_image_results`；只有 QA、没有派生图时直接报告 QA，不重复展示原图。
6. 读取产物时调用 `get_image_artifact`。该工具只返回数据，不创建结果卡；只有用户需要查看历史图片且没有现成结果入口时，才读取后调用一次 `render_image_results`。
7. 用户要求回查批处理时，用 `batchId` 调用 `get_image_batch_manifest`；它只读取不可变记录，不自动展示图片。需要展示其中某张历史图片时，再按稳定图片 ID 读取并调用一次 `render_image_results`。
8. 用户要求回查一次本地交付或 QA 时，用 `deliveryReceiptId` 调用 `get_image_delivery_receipt`；它只读取不可变交付收据，不自动展示图片。需要展示派生图时，再按收据中的稳定图片 ID 调用一次 `render_image_results`。
9. 需要查看模型能力时调用 `list_image_models`。
10. 画布明确提交时，由 widget 一次调用 `prepare_image_edit_submission` 保存标注并取得服务端签发的 `submissionId`；未提交标注不得调用该工具。`save_image_annotations` 不参与这条原子提交路径。

## 批量任务

`batch_images` 接受 1 到 64 个具有唯一 `requestId` 的独立任务；每项 `count` 为 1 到 16，所有任务的 `count` 总和不超过 64，并发度为 1 到 8。未显式指定并发度时使用当前配置的默认值。每项只能是普通 `generate` 或 `edit`；高级 batch 的单项 `count=N` 由一次携带 `n=N` 的供应商请求执行。会话中的同提示候选仍使用一次 `generate_image(count=N)`，并保持 N 次独立单图请求和整组原子提交，不得用高级 batch 替换。

批量结果保持输入顺序并允许逐任务、逐响应图片部分成功。`ok=true` 只表示至少一张经过深度验证的 API 原图已发布；`apiDelivery` 记录供应商返回数、已发布数和安全问题码。交付是否通过以 `delivery.deliveryReady` 为准。交付失败时保留并返回原图，不把该项改判为生成失败，也不触发换模型、换端点、换协议或 API 重试。`manifestReady=true` 时可用 `batchId` 回查不可变 manifest；记录失败不反转图片发布结果。

## 本地交付

把 `deliverySize` 用于精确尺寸；`fit=contain` 与 `safeMargin` 用于保留比例和边距；已知图集布局时同时传 `grid`、`expectedCount` 和每格 `deliverySize`；需要多尺寸、多背景检查时传 `preview.sizes` 与 `preview.backgrounds`；需要技术检查时传 `qa=true`，需要连通区域指标时再传 `components=true`。

`deliver_image` 只读取一个稳定源图。原图保持不变；成功的尺寸图、网格单元和预览板以 `operation=derive`、独立稳定 ID 和 `derivedFrom` 关系保存，不进入编辑版本父子树。`deliveryReady=true` 才把返回的派生 ID 交给 `render_image_results`。`deliveryReady=false` 时报告 `qa` 和 `warnings`，不伪造派生图，也不自动转码、切换格式、改变模型或重试。当前本地变换只处理 PNG 源；其他完整格式保留原图并明确报告未就绪。

请求透明交付时使用 `transparency.route`：普通孤立主体选 `chroma-matting`，黑底发光、火焰或粒子选 `emissive-alpha`，已有明确蒙版图片时选 `mask-alpha` 并传稳定 `maskImageId`。只在配置的 `prompt_only_allow` 精确匹配模型、操作和尺寸时选 `prompt-alpha`；不匹配时保持原提示词并检查 API 原图 alpha，不冒充透明成功。不要猜测或生成 `maskImageId`，也不要把画布编辑 mask 当作透明交付 mask。

透明处理必须先于尺寸、grid 和 preview；透明未通过时停止后续派生并报告原图仍可用。`parameters.transparency.llm_assisted.enabled=true` 时，最多按 `max_attempts` 进行本地重新交付；只在对应开关允许时调整 `options` 或显式改变本地路线。即使策略中出现 `allow_api_retry`，也不要重新请求图片 API；当前 Plugin 不执行透明失败后的 API 重试。

## 画布提交

收到画布提交消息时，优先读取最新模型上下文中的 `projectBindingId`、`submissionId`、`imageId`、`annotationId`、`prompt`、`annotationCount`、`intents` 和 `requestText`。同一任务存在多条画布上下文时，以当前用户消息对应的最新 `submissionId` 为准，不合并旧提交。把 `projectBindingId` 原样作为本次 `edit_image` 的项目绑定，把 `submissionId` 原样作为 `edit_image.submissionId`，把 `imageId` 作为 `edit_image.parentImageId`；`annotationId` 为 `null` 时省略该参数，存在时原样传给 `edit_image`。不得再次调用 `prepare_image_edit_submission` 或 `save_image_annotations`。

结合标注预览、各处文字说明和补充要求，整理一条描述完整目标图片的编辑提示，再调用一次 `edit_image`。包含 mask 标注时，提示必须描述完整目标图片，而不只是被替换的局部区域；“保护内容”要写清需保留对象及允许随场景自然适配的光影。只转述用户目标，不得自行编写、追加或覆盖 `MASK_GUARD_V2_BY_STRATEGY`。运行时会根据已签发提交绑定的 `maskPolicy` 策略构造最终保护提示。缺少图片 ID、`submissionId` 或无法确定修改意图时停止，不猜测 ID，也不切换到 `generate_image` 或其他图片路线。

`edit_image` 成功后在当前会话展示新图片、稳定图片 ID 和父子版本关系；新结果继续保留“打开画布”入口。

## 画布生命周期

`open_image_editor` 返回 `editorSessionId` 后，把该 ID 视为当前任务中的活动画布会话。

- 用户明确要求销毁画布时，调用 `destroy_image_editor`。
- 当前任务已经明确转移到其他目标，且后续不再需要查看、标注或修改当前图片时，调用 `destroy_image_editor` 释放活动画布。
- 用户只隐藏或关闭右栏、暂时讨论其他内容、等待下一轮生成，或仍可能继续处理当前图片时，不要销毁画布。
- 不知道活动 `editorSessionId` 时不要猜测，也不要调用销毁工具。

画布内的“销毁画布”按钮与 `destroy_image_editor` 使用同一生命周期。销毁会结束该图片在当前项目绑定中的全部活动画布会话，并终止该图片在此绑定中的重新打开入口；状态可跨 MCP 进程恢复，其他项目绑定不受影响，图片产物和版本关系仍然保留。销毁后不要再次为同一图片调用 `open_image_editor` 或 `render_image_results` 试图恢复画布入口。

首期模型为 `gpt-image-2`。模型能力由目录声明，执行失败后不切换模型、端点、供应商或编辑路线。

## 配置

Plugin 只从以下两个固定路径解析配置：

1. 用户配置 `~/.codex/openai-compatible-imagegen/config.json`
2. 可选项目覆盖 `<项目根>/.codex/openai-compatible-imagegen/config.json`

用户配置必须存在，并以 `config_version: 1`、`active_profile: "primary/gpt-image-2"`、provider、完整 model、defaults、后处理、透明策略和 storage 作为可信基线。项目配置先独立校验，之后才读取用户配置；它只能覆盖 `defaults.size`、`defaults.quality`、`defaults.output_format` 和 `storage.output_directory`。项目配置不得声明或间接改变档案、模型、provider、endpoint、认证、密钥环境变量、超时、并发或路线权限。越权或无效项目配置直接失败，不忽略、不回退，也不读取用户密钥或发起网络请求。

生效优先级为工具显式参数 > 项目白名单覆盖 > 用户级 defaults > 内建默认。缺少用户配置时停止图片操作，并提示用户基于 `references/config.example.json` 创建正式配置。旧 `auth.json` 和旧版 Plugin 配置不会被自动读取、复制、合并、删除或覆盖；迁移只能通过用户明确执行的迁移命令完成，且不会回显 API key。

Plugin 配置可通过 MCP 工具闭环处理：缺少配置时调用 `initialize_image_config` 创建固定用户模板；如果传入项目根目录，该工具还会幂等更新项目 `.gitignore`，忽略项目配置文件；需要查看时调用 `inspect_image_config`；需要调整时调用 `update_image_config`。这些工具只返回脱敏配置，不接收或输出 `api_key`，项目作用域仍只能修改 size、quality、output_format 和 `storage.output_directory`。修改后应重新绑定图片项目。

### 显式迁移

只在用户明确要求迁移并提供源文件路径与来源类型后执行。把当前 `SKILL.md` 所在目录向上两级作为 `<plugin-root>`；不得从 MCP `cwd`、项目 Git 根或其他安装缓存猜测插件根。

旧 Standalone 配置先执行脱敏 dry-run：

```text
python "<plugin-root>/dist/scripts/migrate_image_config.py" --source "<legacy-config>" --source-kind standalone
```

旧版 Plugin 配置使用保留的兼容值 `--source-kind development-plugin`。只有用户明确要求把白名单 defaults 与输出目录写入当前项目时，才在 dry-run 和 write 两次命令中同时追加 `--include-project-overrides --project-root "<project-root>"`。

向用户报告 dry-run 的 `sourceKind`、`sourceSha256`、`userTarget`、`projectTarget`、`readyToWrite` 和脱敏预览。用户确认后，保持源路径、来源类型、用户目录和项目覆盖参数不变，再执行：

```text
python "<plugin-root>/dist/scripts/migrate_image_config.py" --source "<legacy-config>" --source-kind standalone --write --expected-source-sha256 "<sourceSha256>"
```

`readyToWrite=false` 且提示明文 key 授权时停止；只有用户另行明确批准迁移明文 key，才在 write 命令追加 `--allow-plaintext-api-key`。摘要 SHA 不匹配、目标已存在、schema 不兼容或写入失败时报告原始迁移错误并停止，不改换源文件、目标、配置路线或认证方式。迁移成功后保留源文件；不要自动删除或改名。

可选的 `storage.output_directory` 必须是项目内安全相对目录；缺失时使用 `<项目根>/output/imagegen/`。项目根本身、项目外路径、文件、符号链接、junction 或其他重解析点会被拒绝。配置在项目绑定时冻结；修改后需对同一项目根再次显式绑定才生效。

产物根只决定一个活动仓库。配置覆盖生效后，图片、版本、标注、mask、提交恢复和“在文件夹中显示”都只读取该目录；不会扫描、合并、迁移或复制默认目录中的旧产物。移除覆盖并重启绑定后，默认目录中的旧产物仍可继续访问。

图片 URL 下载默认使用环境代理。只有用户明确批准后，才允许把 provider 的 `url_download.proxy_mode` 设为 `direct`；该设置只影响 provider 返回的图片 URL 下载，不改变生成或编辑请求的 endpoint、模型、协议和代理路线。不得在 TLS 或网络失败后自动切换该设置。

## 结果

`render_image_results` 是结果 widget 的唯一入口。它接收一个或多个稳定图片 ID，按输入顺序返回模型可见的图片内容与安全元数据，并为未销毁画布的图片提供独立“打开画布”入口。已销毁的图片继续显示结果，但入口显示为不可操作的“画布已销毁”。

结果 widget 只把标准 `ui/notifications/tool-input.arguments.imageIds` 作为本次结果的图片身份；`ui/notifications/tool-result` 只表示完成或服务端错误。不要从结果的 `content`、`structuredContent` 或 `_meta` 推断、恢复或替换图片 ID。每张图片只通过 App-only `read_image_artifact_data` 读取一次；请求 ID、公开产物 ID、私有 widget 数据 ID 或 MIME 不一致时停止该卡片，不调用 `get_image_artifact`，也不改走其他读取路线。数据工具 `generate_image`、`edit_image` 和 `get_image_artifact` 不绑定结果 widget。

向用户返回结果中的图片、稳定图片 ID、对应画布入口、版本关系和安全错误摘要。编辑创建新版本，不覆盖父图片。图片和标注保存在绑定配置解析出的项目内产物根；该本机路径不会进入工具结果、widget 或模型上下文。
