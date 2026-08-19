<!-- updated: 2026-08-19 -->
# 故障排查

> 上级：[用户指南](./README.zh-CN.md)

[English](./troubleshooting.md) | 简体中文

修改配置前先判断故障所在层。项目不会自动切换 provider、model、endpoint、认证、协议或安装路线。

## 安装问题

| 现象 | 检查 | 处理 |
| --- | --- | --- |
| 无法添加 marketplace | Git 已安装且能访问 GitHub | 运行 `codex plugin marketplace list --json`，解决 Git 错误后再重试 |
| Marketplace 快照过期 | 配置的 Git 来源和 ref 正确 | 运行 `codex plugin marketplace upgrade openai-compatible-imagegen --json`，再检查返回的错误 |
| Plugin 未列出 | Marketplace 名称和快照存在 | 运行 `codex plugin list --available --json`，然后重启 Codex App 或开始新的 CLI 会话 |
| Plugin 删除不完整 | 已安装 Plugin 和 marketplace 名称正确 | 先运行 `codex plugin remove openai-compatible-imagegen@openai-compatible-imagegen --json`，再运行 `codex plugin marketplace remove openai-compatible-imagegen --json` |
| MCP server 无法启动 | `node --version` 为 20 或更高 | 在 Plugin 外部安装或选择受支持的 Node 运行环境 |
| Python helper 无法启动 | 平台映射命令报告 Python 3.12 或更高版本 | Windows 检查 `python --version`，macOS/Linux 检查 `python3 --version`。需要指定可执行文件时设置 `OPENAI_COMPATIBLE_IMAGEGEN_PYTHON`。预检失败会停止，Plugin 不会切换命令。 |
| 未发现 Standalone Skill | 已安装包根目录存在 `SKILL.md` | 修正解压层级并开始新会话 |
| Skills CLI 更新未发现项目 Skill | `skills-lock.json` 中的安装来源是本地解压目录 | 保留当前安装并使用新的版本化 ZIP 目录；`skills update` 不会更新本地复制安装 |
| Skills CLI 卸载后仍出现在列表中 | `skills remove` 对复制型本地 Skill 报告成功 | 把 CLI 路线只用于首次安装；保留 `auth.json`，并使用版本化 ZIP 回滚流程 |

## 配置问题

| 现象 | 检查 | 处理 |
| --- | --- | --- |
| 缺少用户配置 | Plugin 用户配置路径存在 | 要求 Agent 调用 `initialize_image_config`，或根据包内示例创建 |
| 缺少凭据 | Codex 进程中存在配置指定的环境变量 | 设置环境变量，不要在会话中粘贴其值 |
| 项目覆盖被拒绝 | 项目文件只修改四个允许字段 | 删除 provider、model、endpoint、auth、timeout、concurrency 和 route 字段 |
| 输出目录被拒绝 | 值是安全的项目相对子目录 | 使用 `output/imagegen/` 这类相对子目录 |
| 本地忽略保护被拒绝 | 目标配置或输出目录的 `.gitignore` 内容仅为 `*` | 检查现有规则；Plugin 不会覆盖不兼容的本地忽略文件 |
| Model 未列出 | 活动 profile 目录中声明了该 model | 添加受支持的 model 声明，不要强制使用未声明能力 |

## 运行时问题

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| Provider 拒绝请求 | 配置的服务返回 API 错误 | 查看安全错误码和 provider 日志，不要自动切换路线 |
| 结果卡报告无效数据 | 产物 metadata 或字节未通过验证 | 保留原始错误，并检查已安装 Plugin 版本和构建身份 |
| 画布无法打开 | 产物、绑定或编辑器会话不可用 | 返回会话，从同一结果重新打开画布；只有任务早于当前 Plugin 安装或更新时才开始新任务 |
| 切换任务后侧栏显示结果卡 | Codex 恢复了行内结果，而不是已打开画布 | 在同一卡片上选择 **继续编辑**；Plugin 会恢复保留的未发送草稿 |
| 未满足透明要求 | 原图成功，但所选交付路线未满足契约 | 保留原图，并选择有效的受控底板或可信 mask |
| 交付未就绪 | 转换或 QA 要求失败 | 查看交付收据；只有确实需要新 API 请求时才重新生成 |

生成成功和交付就绪是两个不同状态。Standalone 使用 `delivery_ready`，Plugin 使用 `deliveryReady`。交付状态为 false 时，完整 API 原图仍会保留，并指出未满足的转换、透明或 QA 条件。

## 报告问题时提供的信息

- Plugin 或 Standalone 版本
- 操作系统、Node 版本和 Python 版本
- 安全错误码和简短错误消息
- 问题发生在安装、配置、生成、交付、结果显示还是画布编辑阶段
- 不包含凭据、签名 URL、本地私有路径或用户图片的复现步骤

安全问题使用仓库的私密漏洞报告渠道。非敏感缺陷使用普通 Issue。
