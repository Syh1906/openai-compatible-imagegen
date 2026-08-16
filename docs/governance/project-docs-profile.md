# 项目 docs 画像

## 元信息

| 项目 | 值 |
| --- | --- |
| 项目名称 | OpenAI-Compatible Images |
| 默认文档语言 | 英文 README 优先，中文治理与中文镜像 |
| 当前状态 | 已启用 |
| 首次建立 | 2026-08-16 |
| 最后更新 | 2026-08-16 |

## 项目定位

- 项目一句话定位：用同一图片核心发布 Standalone Skill 和 Codex App Plugin。
- 正式 docs 主要服务首次安装者、已有用户、贡献者和维护 Agent。
- 当前 docs 治理的目标：分离安装、配置、迁移、维护和运行时 Agent 文档职责。

## docs 目录规划

| 目录 | 作用 | 是否启用 |
| --- | --- | --- |
| `docs/README.md` | 总导航 | 是 |
| `docs/standards/` | 项目内规范 | 是 |
| `docs/templates/` | 项目内模板 | 是 |
| `docs/governance/` | 治理画像与治理入口 | 是 |
| `docs/llm/` | 轻量知识与约束 | 否；使用根 `AGENTS.md` 和发行包 `SKILL.md` |
| `docs/plans/` | 公开计划与归档 | 否；当前不发布实施计划 |
| `docs/guides/` | 用户安装、配置、迁移和排错 | 是 |
| `docs/architecture/` | 分模块架构 | 否；当前使用 `docs/arch.md` |
| `docs/server/` | 后端长期说明 | 否 |
| `docs/client/` | 客户端长期说明 | 否 |
| `docs/web/` | 前端长期说明 | 否 |
| `docs/ops/` | 运维长期说明 | 否 |

## 真相源优先级

| 层级 | 来源 | 负责内容 |
| --- | --- | --- |
| 1 | 代码、`.codex-plugin/plugin.json`、`.mcp.json`、`package.json` | 实现、插件身份、运行入口和命令 |
| 2 | `tests/`、`dist/`、发布制品 | 可验证行为、预构建运行内容和发行边界 |
| 3 | `skills/openai-compatible-imagegen/SKILL.md`、`references/` | 运行时 Agent 决策和能力参考 |
| 4 | README、`docs/`、CHANGELOG | 面向不同读者组织的长期说明 |

## README 规则

- `docs/` 体系 README 默认采用导航型，固定使用 `README.md`，不用 `*索引.md` 替代。
- 根 README 是产品入口和最短安装入口，不复制全部指南。
- 当前已登记的稳定样式只有本治理层定义的导航型 README。

## 文档类型与同步点

| 文档类型 | 是否启用 | 主要同步点 |
| --- | --- | --- |
| README 导航 | 是 | 新增、移动、删除公开文档 |
| 长期说明 | 是 | 模块职责、依赖方向、发行形态或稳定数据流变化 |
| API 文档 | 否 | 当前由工具 schema、Skill 和测试共同约束 |
| 用户指南 | 是 | 安装入口、配置契约、迁移、更新、回滚或错误边界变化 |
| 计划文档 | 否 | 内部计划不进入公开仓库 |
| LLM 知识条目 | 否 | 维护 Agent 用 `AGENTS.md`，运行时 Agent 用 `SKILL.md` |

## 计划治理

| 项目 | 规则 |
| --- | --- |
| 是否启用计划归档 | 否 |
| 当前计划命名 | `NN-主题推进计划.md`，启用公开计划后生效 |
| 编号分配 | 从 `01` 开始递增，包含归档历史，不复用 |
| 归档命名 | `YYYYMMDD-NN-主题推进计划.md` |
| 归档路径 | `docs/plans/archive/YYYYMMDD-NN-主题推进计划.md` |
| 环境分目录归档 | 不启用 |
| 当前状态枚举 | 待定 / 进行中 / 阻塞 / 已完成 / 已取消 |
| 归档前置条件 | 先验收并回填长期事实，再移动归档 |
| 索引同步 | 启用时同步 `docs/plans/README.md` 与 `docs/plans/archive/README.md` |

## 风格约束

- 稳定表头：`主题 / 直接入口 / 读取说明`、`入口 / 适合什么时候看`、`来源 / 负责内容`。
- 禁词：避免“简单”“显然”“无缝”“全面”等评价性或空泛词。
- 术语统一要求：使用 `Standalone Skill`、`Codex Plugin`、`OpenAI-Compatible Images` 和技术 ID `openai-compatible-imagegen`。
- 图示最低要求：项目总览和架构文档至少包含一个稳定结构图或职责矩阵。

## docs impact review

- 代码、配置、脚本、插件清单、MCP schema、widget、发行结构、测试口径或计划状态变化后触发。
- 至少检查根 README、`docs/README.md`、相关指南、`docs/arch.md`、CHANGELOG、运行时 `SKILL.md` 和公开 `AGENTS.md`。

## 与 skill 内建规范的对齐策略

- 必须强对齐：治理入口命名、规范章节、模板骨架、导航结构和 docs impact review。
- 可以项目化改写：项目名、`docs/guides/` 路径、真相源、术语和启用状态。
- 当前未覆盖、允许回退到 `doc-writing` 的类型：调研快照、外部代码研究和发布说明正文。
