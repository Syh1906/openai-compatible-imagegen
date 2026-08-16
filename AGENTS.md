# 智能体规则

## 项目范围

- `OpenAI-Compatible Images` 从同一代码库维护 Standalone Skill 与 Codex App Plugin。
- 共享图片核心位于 `scripts/`；两种发行形态使用各自 Adapter，不复制共享实现。
- Codex Plugin 由 `skills/`、`mcp/`、`web/`、`.mcp.json`、`.codex-plugin/plugin.json` 和预构建 `dist/` 组成。
- `dist/` 必须跟踪，只通过 `npm run build` 更新，不手工编辑。

## 包管理

- Node 使用 npm 与 `package-lock.json`。
- Python 运行时要求 Python 3.12，生产代码只使用标准库。
- 不执行全局安装，不修改用户级 `PATH`、注册表或 Codex 配置。

## 检查命令

| 任务 | 命令 |
| --- | --- |
| 全部测试 | `npm test` |
| Node 单文件测试 | `node --test tests/<file>.mjs` |
| Python 单模块测试 | `python -m unittest tests.<module>` |
| 构建 Plugin | `npm run build` |
| 检查 Plugin | `npm run check` |
| Python 编译检查 | `python -m compileall -q scripts` |
| 差异检查 | `git diff --check` |

## 模块边界

- `scripts/`：鉴权、图片请求、响应校验、后处理、交付和 QA；不依赖 Codex、MCP 或 widget。
- `mcp/`：工具 schema、项目绑定、产物仓库和运行时调用；不拼装供应商图片请求。
- `web/`：结果卡与聚焦画布；不读取密钥，不直接连接图片服务。
- `skills/openai-compatible-imagegen/`：Plugin 运行时工具选择和参数决策。
- 根 `SKILL.md` 与 `references/`：Standalone 运行时契约。
- `.agents/plugins/marketplace.json`：Git marketplace 入口；Plugin 来源必须跟随 marketplace checkout。
- `.codex-plugin/plugin.json`、`package.json`、`package-lock.json`：版本与包身份保持一致。

## 行为约束

- 不覆盖或伪造 Codex 内置 `image_gen`。
- 不读取或修改 Codex 任务记录、App 数据库或未公开宿主协议。
- 不自动切换模型、provider、endpoint、认证来源、请求协议或编辑路线。
- 图片、编辑版本和交付产物保持不可变；失败不能留下索引指向的残缺文件。
- 项目配置只能覆盖公开契约允许的字段。
- 凭据不得写入日志、工具结果、测试夹具、文档、发布包或提交。

## 测试与文档

- 新增行为或修复缺陷时，先添加能复现目标行为的测试。
- 共享核心变化同时验证 Standalone 与 Plugin Adapter。
- MCP、widget、Plugin 清单或 marketplace 变化需要对应 Node 测试和 Codex App 验收。
- 用户可见行为变化同步更新 `CHANGELOG.md` 和受影响的公开指南。
- `README.md` 面向首次访问者；`docs/guides/` 面向用户；`AGENTS.md` 面向贡献者；发行包 `SKILL.md` 面向运行时 Agent。
- 公开内容不包含凭据、私有地址、本机绝对路径、测试输出或未发布实施计划。

## 发布

- 一个版本和 tag 同时产生 Standalone Skill ZIP 与 Codex Plugin ZIP。
- Git marketplace Plugin 必须包含 `dist/server.mjs`、`dist/widget/` 和 `dist/scripts/`。
- 发布前检查 marketplace、Plugin 清单、包元数据、tag 和制品版本一致。
- 发布包排除 `auth.json`、`.local/`、`verification-scratch/`、`node_modules/`、缓存和测试输出。
- 未经维护者明确批准，不创建或移动 tag，不创建 Release，不修改远程或发布公共 MCP。

## 提交署名

- 提交信息格式：`<type>: <英文摘要>`。
- `type` 使用 `feat`、`fix`、`docs`、`chore`、`refactor`、`build`、`style`、`perf`、`test` 或 `ci`。
- AI 提交必须包含实际模型身份：

      Co-Authored-By: (the agent model's name and attribution byline)
