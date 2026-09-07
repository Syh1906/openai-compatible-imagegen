<div align="center">

# OpenAI 兼容图片

**通过 OpenAI 兼容图片 API、Atlas Cloud 或 Codex App 的 ChatGPT 路线生成、检查、编辑并交付图片。**

[![Release](https://img.shields.io/github/v/release/Syh1906/openai-compatible-imagegen?style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Syh1906/openai-compatible-imagegen/ci.yml?branch=main&style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/actions)

[English](README.md) | 简体中文

</div>

OpenAI 兼容图片（OpenAI-Compatible Images）把同一套图片核心发布为两种安装形态。Standalone Skill 适合 Agent 客户端和命令行工作流；Codex Plugin 在此基础上增加结果卡、聚焦画布、标注、不可变产物和版本历史。API Key 路线支持默认的 OpenAI-compatible 协议和可选的 Atlas Cloud 图片生成。

## 选择安装形态

| 安装形态 | 适合场景 | 包含内容 |
| --- | --- | --- |
| **Standalone Skill** | Codex CLI、Claude Code、OpenCode 和其他 Agent Skills 客户端 | 生成、编辑、JSONL 批处理、透明处理、交付和 QA |
| **Codex Plugin** | 需要结果卡和聚焦画布的 Codex App 用户 | API Key：完整图片工作流；ChatGPT：宿主生成和语义画布编辑，以及产物、交付和版本 |

每个使用环境选择一种安装形态。两者共享代码和版本，但使用各自的本地配置与产物目录。将已有配置迁移到 Codex Plugin 时，请按[迁移指南](docs/guides/migration.zh-CN.md)操作。

## Codex App 工作流

在会话中生成图片，再打开聚焦画布标记区域，并为每处修改添加说明。

API Key 生成和编辑支持持久化异步任务：长批次可持续查询进度，等待超时后可找回已确认结果，交付失败可保留原图继续处理。参见[长时间生成与批量任务](docs/guides/image-jobs.zh-CN.md)。

**会话图片结果**

![Codex App 中的 OpenAI 兼容图片结果卡](docs/images/codex-result-card.png)

**聚焦编辑画布**

![跟随宿主主题并带有区域和箭头标注的图片画布](docs/images/codex-editing-canvas.png)

## 安装 Codex Plugin

需要：支持 Plugin 的 Codex、Git、Node.js 20+、Python 3.12 或更高版本。Plugin ZIP 与平台无关，支持 Windows、macOS 和 Linux。你可以选择配置自己的图片 API 服务使用 API Key 路线，也可以在 Codex App 提供图片生成能力时选择 ChatGPT 路线。

```text
codex plugin marketplace add Syh1906/openai-compatible-imagegen
codex plugin add openai-compatible-imagegen@openai-compatible-imagegen
```

如果 `openai-compatible-imagegen` marketplace 已注册，跳过第一条命令。安装后完全退出并重新启动 Codex 一次，让 Plugin 的 Skill、MCP 工具和包内依赖完整加载。

Plugin 已包含所需程序，无需构建仓库。继续完成[配置](docs/guides/configuration.zh-CN.md#配置-codex-plugin)；其他安装方式和平台要求见[安装指南](docs/guides/installation.zh-CN.md#安装-codex-plugin)。

## 安装 Standalone Skill

从 [GitHub Releases](https://github.com/Syh1906/openai-compatible-imagegen/releases) 下载 `openai-compatible-imagegen-skill-<version>.zip`。解压到客户端的 skills 目录，确保包根存在 `SKILL.md`，再启动新会话。

需要 Python 3.12 或更高版本和图片服务凭据。[安装指南](docs/guides/installation.zh-CN.md#安装-standalone-skill)提供客户端路径和第三方 Skills CLI 步骤；安装后完成[Standalone 配置](docs/guides/configuration.zh-CN.md#配置-standalone-skill)。更新已有安装时，按[更新指南](docs/guides/updating.zh-CN.md)保留配置并切换版本。

## 能做什么

- 生成图片，并使用一张或多张参考图编辑。
- 一次生成多张图片，或批量处理不同需求。
- 本地交付失败时，保留已保存的 API 原图。
- 缩放、适配、安全边距、网格拆分和预览板。
- 按配置使用原生透明、色键、发光、mask 或已验证的 prompt-alpha 路线生成透明图片。
- 对尺寸、alpha、边缘接触、边距和组件执行确定性检查。
- 凭据留在本地，只返回安全错误摘要。
- 在 Codex App 会话中查看结果，并进入聚焦标注画布继续编辑。

具体能力取决于所选路线和模型。Atlas Cloud 目前只支持文生图，详见[配置指南](docs/guides/configuration.zh-CN.md#配置-atlas-cloud)。

## 怎么使用

用自然语言说明主体、构图、尺寸、数量、透明要求、检查项和输出：

> 生成一张 16:9、2K 的新品发布横幅，再交付 1200x675 PNG。

> 保护笔记本，把马克杯改色，然后在聚焦画布中检查结果。

> 生成四张编辑插图，并保留记录各项结果的批次清单。

Codex Plugin 在 App 中显示结果与画布操作。Standalone Skill 调用包内 CLI，并报告输出文件和 manifest 路径。

## 文档

通过[文档导航](docs/README.zh-CN.md)查找安装、配置、迁移、更新、回滚、故障排查和架构说明。

## 安全

凭据保存在用户控制的文件或环境变量中。项目不运营托管图片服务，也不收集提示词和输出。安全报告方式与信任边界见 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)
