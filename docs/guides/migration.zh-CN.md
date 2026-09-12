# 迁移

> 上级：[用户指南](./README.zh-CN.md)

[English](./migration.md) | 简体中文

迁移到 Codex Plugin 必须显式执行。Plugin 不会扫描、复制、合并、删除或覆盖旧的 Standalone 或 Plugin 配置。

## 支持的来源

| 来源 | `--source-kind` | 项目覆盖 |
| --- | --- | --- |
| Standalone `auth.json` | `standalone` | 否 |
| 当前 Plugin v1 配置升级为 v2 | `plugin-v1` | 否；生成新的用户配置 |
| 较早的 Codex Plugin 配置 | `development-plugin`（兼容值） | 可选；只允许白名单字段 |

## 预览迁移

从当前 Plugin v1 升级时，使用下文的[升级 v1 配置](#升级-v1-配置)步骤。其他来源使用下面的迁移命令。

使用当前平台的命令执行脱敏 dry run。

Windows PowerShell：

```powershell
python "C:/path/to/openai-compatible-imagegen/dist/scripts/migrate_image_config.py" `
  --source "C:/path/to/legacy/auth.json" `
  --source-kind standalone
```

macOS 或 Linux shell：

```bash
python3 "/absolute/path/to/openai-compatible-imagegen/dist/scripts/migrate_image_config.py" \
  --source "/absolute/path/to/legacy/auth.json" \
  --source-kind standalone
```

迁移较早的 Codex Plugin 配置时，传入 `--source-kind development-plugin`。这个值只为命令兼容而保留。只有需要同时迁移允许的项目默认值时，才同时添加 `--include-project-overrides` 和 `--project-root "<project-root>"`。

检查以下字段：

| 字段 | 含义 |
| --- | --- |
| `sourceKind` | 识别出的来源格式 |
| `sourceSha256` | 绑定已检查来源的摘要 |
| `readyToWrite` | 目标能否在不覆盖的情况下写入 |
| 目标路径 | 用户配置和可选项目配置位置 |
| 脱敏预览 | 将写入的值，不包含凭据 |

## 写入迁移结果

使用相同输入和已经检查的摘要。

Windows PowerShell：

```powershell
python "C:/path/to/openai-compatible-imagegen/dist/scripts/migrate_image_config.py" `
  --source "C:/path/to/legacy/auth.json" `
  --source-kind standalone `
  --write `
  --expected-source-sha256 "<sourceSha256>"
```

macOS 或 Linux shell：

```bash
python3 "/absolute/path/to/openai-compatible-imagegen/dist/scripts/migrate_image_config.py" \
  --source "/absolute/path/to/legacy/auth.json" \
  --source-kind standalone \
  --write \
  --expected-source-sha256 "<sourceSha256>"
```

默认迁移环境变量认证。迁移可用的明文 key 需要明确批准，并在写入命令中加入 `--allow-plaintext-api-key`。

## 迁移结果

来源文件保持不变。迁移会保留非空的供应商模型 ID，包括自定义别名；不要求使用 OpenAI 标准模型名称，也不会验证供应商是否已开放该模型。写入每个目标前，迁移程序会在目标配置目录中创建或验证内容仅为 `*` 的 `.gitignore`。如果来源摘要改变、目标已经存在、schema 或旧版 profile 结构不受支持、模型 ID 无效、仍有废弃字段、忽略规则不兼容或写入失败，迁移会停止且不覆盖现有内容。项目不提供从 Plugin 自动迁回 Standalone 的功能。

## 升级 v1 配置

已有 v1 配置继续可用。需要每模型默认值等 v2 能力时，先把新配置写到独立目录，保留原文件。下面的 `--user-home` 是空的暂存根目录，迁移目标为其下的 `.codex/openai-compatible-imagegen/config.json`。

先预览：

Windows PowerShell:

```powershell
python "C:/path/to/openai-compatible-imagegen/dist/scripts/migrate_image_config.py" `
  --source "C:/path/to/current/config.json" --source-kind plugin-v1 `
  --user-home "C:/path/to/empty-migration-root"
```

macOS 或 Linux shell：

```bash
python3 "/absolute/path/to/openai-compatible-imagegen/dist/scripts/migrate_image_config.py" \
  --source "/absolute/path/to/current/config.json" --source-kind plugin-v1 \
  --user-home "/absolute/path/to/empty-migration-root"
```

确认 `readyToWrite`、脱敏预览和 `sourceSha256` 后，使用相同来源与暂存根目录写入：

Windows PowerShell:

```powershell
python "C:/path/to/openai-compatible-imagegen/dist/scripts/migrate_image_config.py" `
  --source "C:/path/to/current/config.json" --source-kind plugin-v1 `
  --user-home "C:/path/to/empty-migration-root" `
  --write --expected-source-sha256 "<sourceSha256>"
```

macOS 或 Linux shell：

```bash
python3 "/absolute/path/to/openai-compatible-imagegen/dist/scripts/migrate_image_config.py" \
  --source "/absolute/path/to/current/config.json" --source-kind plugin-v1 \
  --user-home "/absolute/path/to/empty-migration-root" \
  --write --expected-source-sha256 "<sourceSha256>"
```

图片默认值复制到 `host_defaults` 与原活动模型，API 透明策略保留给原活动模型；其他模型不继承这些设置。顶层 `defaults` 保留超时与并发，顶层透明与本地处理设置保持不变。纯 ChatGPT 配置不会被补入 API 供应商。

凭据引用会保留；迁移明文密钥仍需明确允许并添加 `--allow-plaintext-api-key`。检查新文件后，保留旧配置备份，再将新文件替换到实际用户配置位置，并重新绑定项目。目标已存在或来源发生变化时会停止，先检查具体错误，不要覆盖来源。
