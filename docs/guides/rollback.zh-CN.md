# 回滚

> 上级：[用户指南](./README.zh-CN.md)

[English](./rollback.md) | 简体中文

回滚会更改已安装发行包的版本，不会自动降级或重写图片服务配置。正常向前更新请使用[更新 Plugin 或 Skill](./updating.zh-CN.md)。

下面的 `codex plugin` 回滚命令在 Windows PowerShell、macOS 终端和 Linux shell 中相同。

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

6. 使用 `codex plugin list --json` 确认版本，然后完全退出并重新启动 Codex，再使用图片工具。

不要把未发布的 commit 作为回滚目标。Plugin 版本只能读取与该版本兼容的配置；复用较新配置前，先查看目标版本的 release notes。

## 回滚 Standalone Skill

1. 从同一个 GitHub Release 下载目标版本的 Skill ZIP 和 `SHA256SUMS`，按[校验步骤](./updating.zh-CN.md#更新-standalone-skill)确认完整性。
2. 解压到新的版本专用目录。
3. 按目标版本的配置指南，在恢复目录中准备兼容的 `auth.json`。使用[更新指南中的平台命令](./updating.zh-CN.md#更新-standalone-skill)运行 `imagegen.py info`；检查通过前保留当前安装和配置。
4. 把客户端切换到恢复后的 Skill 目录。
5. 开始一个新任务或新会话。

不要把 `skills update`、重复 `skills add` 或 `skills remove` 当作本地复制安装的无损版本切换方式。除非目标版本的文档明确支持，否则不要把较新的配置字段复制到旧发行包。

## 回滚结果

Plugin 的 `codex plugin list --json` 会报告选定版本。Standalone 的 `info` 应指向从已校验版本压缩包解出的目录。已有图片产物继续保存在本地，不会因发行包回滚而删除。
