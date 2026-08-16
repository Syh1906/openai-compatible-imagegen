<div align="center">

# OpenAI 兼容图片

**通过你自己的 OpenAI 兼容图片 API 生成、编辑、批处理、检查并交付图片。**

[![Release](https://img.shields.io/github/v/release/Syh1906/openai-compatible-imagegen?style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Syh1906/openai-compatible-imagegen/ci.yml?branch=main&style=flat-square)](https://github.com/Syh1906/openai-compatible-imagegen/actions)

[English](README.md) | 简体中文

</div>

OpenAI 兼容图片把同一套图片核心发布为两种安装形态。Standalone Skill 适合 Agent 客户端和命令行工作流；Codex Plugin 在此基础上增加结果卡、聚焦画布、标注、不可变产物和版本历史。

## 选择安装形态

| 安装形态 | 适合场景 | 包含内容 |
| --- | --- | --- |
| **Standalone Skill** | Codex CLI、Claude Code、OpenCode 和其他 Agent Skills 客户端 | 生成、编辑、JSONL 批处理、透明处理、交付和 QA |
| **Codex Plugin** | 需要完整图片工作流的 Codex App 用户 | 共享能力，以及 MCP 工具、结果卡、画布编辑、产物和版本 |

你可以安装其中一种，也可以都安装。两者共享代码和版本，但使用各自的本地配置与产物目录。

## 安装 Codex Plugin

需要：支持 Plugin 的 Codex、Git、Node.js 20+、Python 3.12，以及你自己的 OpenAI 兼容图片服务。

```text
codex plugin marketplace add Syh1906/openai-compatible-imagegen
```

然后在 Codex App 打开 **Plugins**，选择 `openai-compatible-imagegen` marketplace，安装 **OpenAI-Compatible Images**。Codex CLI 用户启动 `codex` 后输入 `/plugins`，再从同一 marketplace 安装。

Git-backed 安装已经包含 MCP server 和 widget，不需要构建仓库或启动本地 Web 服务。

[Plugin 安装与配置](docs/guides/installation.md#install-the-codex-plugin)

## 安装 Standalone Skill

从 [GitHub Releases](https://github.com/Syh1906/openai-compatible-imagegen/releases) 下载 `openai-compatible-imagegen-skill-<version>.zip`。解压到客户端的 skills 目录，确保包根存在 `SKILL.md`，再启动新会话。

[Standalone 安装路径与设置](docs/guides/installation.md#install-the-standalone-skill)

## 能做什么

- 生成图片，并使用一张或多张参考图编辑。
- 执行有边界的多图任务和异构批处理。
- 在交付变换前保留每张完整 API 原图。
- 缩放、适配、安全边距、网格拆分和预览板。
- 使用明确的色键、发光、mask 或已验证 prompt-alpha 路线准备透明结果。
- 对尺寸、alpha、边缘接触、边距和组件执行确定性检查。
- 凭据留在本地，只返回安全错误摘要。
- 在 Codex App 会话中查看结果，并进入聚焦标注画布继续编辑。

后端必须提供 `POST /v1/images/generations` 和 `POST /v1/images/edits`，响应包含 `data[].b64_json` 或 `data[].url`。

## 怎么使用

用自然语言说明主体、构图、尺寸、数量、透明要求、检查项和输出：

> 生成一张 16:9、2K 的新品发布横幅，再交付 1200x675 PNG。

> 保护笔记本，把马克杯改色，然后在聚焦画布中检查结果。

> 生成四张编辑插图，并保留可审计的 batch manifest。

Codex Plugin 在 App 中显示结果与画布操作。Standalone Skill 调用包内 CLI，并报告输出文件和 manifest 路径。

## 文档

| 任务 | 指南 |
| --- | --- |
| 选择并安装 | [安装指南](docs/guides/installation.md) |
| 连接 provider 和 model | [配置指南](docs/guides/configuration.md) |
| 从 `v0.3.0` 或开发期 Plugin 迁移 | [迁移指南](docs/guides/migration.md) |
| 恢复已发布版本 | [回滚指南](docs/guides/rollback.md) |
| 排查安装和运行错误 | [故障排查](docs/guides/troubleshooting.md) |
| 理解仓库边界 | [架构说明](docs/arch.md) |
| 浏览全部公开文档 | [文档导航](docs/README.md) |

## 给 Agent 的入口

- 替用户安装：读取 [安装指南](docs/guides/installation.md)，处理凭据前停止并交还用户。
- 配置已安装包：读取 [配置指南](docs/guides/configuration.md)。
- 维护仓库：修改代码或文档前读取 [AGENTS.md](AGENTS.md)。
- 执行图片任务：使用已安装包中的 `SKILL.md`，它是运行时工具路由契约。

可直接交给 Agent 的原始安装指南：

```text
https://raw.githubusercontent.com/Syh1906/openai-compatible-imagegen/main/docs/guides/installation.md
```

## 安全

凭据保存在用户控制的文件或环境变量中。项目不运营托管图片服务，也不收集提示词和输出。安全报告方式与信任边界见 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)
