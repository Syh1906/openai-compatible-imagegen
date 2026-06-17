# OpenAI 兼容图片生成 Skill

[English](README.en.md)

这个仓库提供一个 Codex skill，用本地脚本调用 OpenAI 兼容图片 API，支持文生图、参考图编辑、批量生成和透明底素材意图。

## 安装

把仓库克隆到 Codex skills 目录：

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
git clone https://github.com/Syh1906/openai-compatible-imagegen.git $SkillDir
```

如果你的 Codex skills 目录不同，请把目标路径换成自己的目录。

## 初始化认证

首次使用前创建本地私有配置：

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" init
```

你也可以初始化非敏感字段：

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" init `
  --base-url "https://example.com/v1" `
  --model "gpt-image-2" `
  --api-key-env "OPENAI_API_KEY"
```

`auth.json` 不会提交到仓库。密钥有两种写法：

- 直接写入 `auth.json` 的 `api_key` 字段。
- 在 `auth.json` 写 `api_key_env`，再把 key 放入对应环境变量。

如果两者同时存在，脚本优先使用 `api_key`。如果 `api_key` 仍是模板占位值，脚本才读取 `api_key_env`。

检查配置摘要：

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" info
```

`info` 会打码密钥，只显示来源。

## 使用

文生图：

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Warcraft 3 风格技能图标，冰霜符文，无文字" `
  -f "outputs/frost-rune.png" `
  --size 1024x1024 `
  --quality high
```

参考图编辑：

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" edit `
  -p "改成暗色魔法 UI 风格" `
  -i "input.png" `
  -f "outputs/dark-ui.png"
```

批量生成：

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" batch `
  --input "examples/batch.example.jsonl" `
  --out "outputs/imagegen" `
  --concurrency 3
```

透明底素材意图：

```powershell
$SkillDir = "$env:USERPROFILE/.codex/skills/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" generate `
  -p "居中的火焰宝珠游戏道具素材，无文字" `
  -f "outputs/fire-orb.png" `
  --asset `
  --transparent
```

## 配置字段

`examples/auth.example.json` 是模板：

- `base_url`：OpenAI 兼容 API 基础地址，通常以 `/v1` 结尾。
- `api_key`：可直接写入本地配置的 API key。
- `api_key_env`：可选环境变量名。
- `model`：默认图片模型。
- `capabilities.transparent_background`：接口是否支持 `background=transparent`。
- `defaults`：默认尺寸、质量、格式、超时和批量并发。

## 验证

运行本地测试：

```powershell
python -m unittest discover -s tests
```

测试不会调用图片 API。
