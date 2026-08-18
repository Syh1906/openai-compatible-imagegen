<!-- updated: 2026-08-19 -->
# 回滚

> 上级：[用户指南](./README.zh-CN.md)

[English](./rollback.md) | 简体中文

回滚会更改已安装发行包的版本，不会自动降级或重写图片服务配置。

## 回滚 Codex Plugin

1. 使用 `codex plugin list --json` 记录当前 Plugin 版本，并选择要恢复的已发布标签。
2. 删除已安装的 Plugin：

```text
codex plugin remove openai-compatible-imagegen@openai-compatible-imagegen --json
```

3. 删除当前 marketplace 来源：

```text
codex plugin marketplace remove openai-compatible-imagegen --json
```

4. 添加固定到目标发布标签的仓库 marketplace：

```text
codex plugin marketplace add Syh1906/openai-compatible-imagegen --ref vX.Y.Z --json
```

5. 从该 marketplace 快照安装 **OpenAI-Compatible Images**：

```text
codex plugin add openai-compatible-imagegen@openai-compatible-imagegen --json
```

6. 使用 `codex plugin list --json` 确认版本，然后在使用图片工具前开始一个新任务。

不要把未发布的 commit 作为回滚目标。Plugin 版本只能读取与该版本兼容的配置；复用较新配置前，先查看目标版本的 release notes。

## 回滚 Standalone Skill

1. 从 GitHub Releases 下载目标版本的 Skill ZIP。
2. 解压到新的版本专用目录。
3. 在旧版本通过 `info` 检查前，保留当前安装和 `auth.json`。
4. 把客户端切换到恢复后的 Skill 目录。
5. 开始一个新任务或新会话。

不要把 `skills update`、重复 `skills add` 或 `skills remove` 当作本地复制安装的无损版本切换方式。除非目标版本的文档明确支持，否则不要把较新的配置字段复制到旧发行包。

## 回滚结果

活动发行包会报告选定的已发布版本。已有图片产物继续保存在本地，不会因发行包回滚而删除。
