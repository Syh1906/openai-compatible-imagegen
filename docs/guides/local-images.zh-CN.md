# 导入与导出本地图片

> 上级：[用户指南](./README.zh-CN.md)

[English](./local-images.md) | 简体中文

Codex Plugin 可以把项目内已有图片作为编辑参考，并将生成、编辑或交付后的图片原样导出给本地工具。先完成[配置](./configuration.zh-CN.md)，并在图片所在项目中开始任务。

## 编辑已有图片

例如，把图片放在项目的 `references/character.png`，然后提出：

> 使用 references/character.png 作为角色参考，生成一个向右跑动的姿势，保留角色外形。

Agent 会通过 `import_local_image` 导入图片，获得稳定图片 ID，再通过所选路线编辑。API Key 编辑使用 `edit_image` 的 `parentImageId`；额外参考图也先导入，再传入 `referenceImageIds`。ChatGPT 路线可从导入图片的结果卡打开画布并提交编辑。

导入支持 PNG、JPEG、WebP，单图不超过 64 MiB、1 亿像素。它保存原始字节快照，不修改源文件；每次导入会创建独立产物。导入本身不调用图片服务，不切换认证路线。

## 将结果交给本地工具

选定结果后，指定一个新文件名：

> 将这张图片导出为 decoded/running-right.png，供后续精灵图组装使用。

Agent 会调用 `export_image_artifact`，返回目标相对路径、字节数和 SHA-256。目标目录不存在时会创建；目标文件已存在时会拒绝覆盖，请指定新的文件名。导出不会转码，扩展名必须与图片实际格式一致。如果需要缩放、透明处理或切图，先完成交付，再导出对应的派生图片。

## 路径与入口

Windows、macOS、Linux 上的工具参数都使用项目相对路径和正斜杠。导入与导出路径必须位于当前绑定项目内、artifact 仓库外；绝对路径、`..`、符号链接、junction 和其他 reparse point 均不接受。项目外的图片需要先放入项目再导入。

这些操作使用 Plugin MCP 工具。Standalone Skill 是另一种发行包，使用独立配置；无需在 Plugin 安装目录中寻找脚本或创建 `auth.json`。若当前安装版本没有导入、导出工具，请参阅[更新指南](./updating.zh-CN.md)。
