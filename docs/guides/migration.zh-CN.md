<!-- updated: 2026-08-19 -->
# 迁移

> 上级：[用户指南](./README.zh-CN.md)

[English](./migration.md) | 简体中文

迁移到 Codex Plugin 必须显式执行。Plugin 不会扫描、复制、合并、删除或覆盖旧的 Standalone 或 Plugin 配置。

## 支持的来源

| 来源 | `--source-kind` | 项目覆盖 |
| --- | --- | --- |
| Standalone `auth.json` | `standalone` | 否 |
| 较早的 Codex Plugin 配置 | `development-plugin`（兼容值） | 可选；只允许白名单字段 |

## 预览迁移

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

来源文件保持不变。写入每个目标前，迁移程序会在目标配置目录中创建或验证内容仅为 `*` 的 `.gitignore`。如果来源摘要改变、目标已经存在、schema 或 model 不受支持、仍有废弃字段、忽略规则不兼容或写入失败，迁移会停止且不覆盖现有内容。项目不提供从 Plugin 自动迁回 Standalone 的功能。
