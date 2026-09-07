# 导入与导出本地图片

> 上级：[用户指南](./README.zh-CN.md)

[English](./local-images.md) | 简体中文

用 Codex Plugin 编辑项目中的图片，并把结果保存为其他工具可以使用的文件。

先在图片所在项目中完成[Plugin 配置](./configuration.zh-CN.md)。所装 Plugin 需要提供 `import_local_image` 和 `export_image_artifact` 工具；可让 Codex 检查是否可用。不同版本提供的工具可能不同，更新前请核对目标版本的[更新记录](../../CHANGELOG.md)，再按[更新指南](./updating.zh-CN.md)操作。

## 编辑已有图片

1. 把图片放入项目，例如 `references/character.png`。
2. 在会话中说明图片路径和修改要求：

> 编辑 references/character.png，让角色向右跑动，保留角色的外形和服装。

使用 API Key 时，所选模型必须支持图片编辑；使用多张参考图还需要模型支持多图参考。Atlas 协议只支持文生图，不能用于这一步。

使用 ChatGPT 路线时，Codex 会先显示导入图片的结果卡。打开画布，填写修改要求并提交。该路线需要 Codex App 提供图片生成能力，详见[配置指南](./configuration.zh-CN.md)。

编辑完成后，新图片会出现在会话中，并保留与原图的版本关系。项目中的源文件不会被修改。

支持导入 PNG、JPEG、WebP，单图上限为 64 MiB、1 亿像素。导入会保存一份副本；再次导入同一文件会得到另一份独立图片。导入和导出都在本地完成，编辑图片才会调用所选图片服务。

## 将结果交给本地工具

选定结果后，指定一个新文件名：

> 将这张图片导出为 exports/running-right.png。

完成后，文件会出现在项目的 `exports/` 目录中，可以交给其他工具使用。缺少的目录会自动创建；如果文件已经存在，请换一个文件名。

导出保留图片的原始格式和内容，不会转换格式，文件扩展名必须与图片格式一致。如果需要缩放、透明处理或切图，请先让 Codex 完成处理，再导出处理后的图片。Plugin 的这些本地处理目前只接受 PNG。

## 文件位置与常见问题

Windows、macOS 和 Linux 都使用相对于项目根目录的路径，例如 `references/character.png`。请使用正斜杠 `/`。项目外的图片需要先复制进项目；绝对路径、包含 `..` 的路径，以及符号链接或 Windows 目录联接均不支持。

导入和导出目录应与 Plugin 管理的图片目录分开。后者默认位于 `output/imagegen/`，也可在[配置](./configuration.zh-CN.md)中更改。已经在结果卡中的图片可以直接继续编辑，无需从该目录重新导入。

遇到画布白屏、配置错误或其他问题，请参阅[故障排查](./troubleshooting.zh-CN.md)。
