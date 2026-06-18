# Parameter Reference

## Parameter Priority

```text
command flags > per-row batch fields > auth.json defaults > built-in defaults
```

Command flags override config defaults. Batch rows can override shared batch settings for each item.

## Modes

| Mode | Command | Endpoint |
| --- | --- | --- |
| Text-to-image | `generate` | `POST /v1/images/generations` |
| Image edit / reference image | `edit` | `POST /v1/images/edits` |
| Batch | `batch` | Selects `generate` or `edit` per row |
| Config summary | `info` | No API call |

## Size Guidance

| Use case | Suggested size |
| --- | --- |
| Icons, avatars, game items, square assets | `1024x1024` |
| Landscape UI images, game concepts, cover drafts | `1536x1024` |
| Portrait posters, phone wallpapers, character art | `1024x1536` |
| High-detail square final assets | `2048x2048` |
| 2K landscape final assets | `2048x1152` |
| 2K portrait final assets | `1152x2048` |
| 4K landscape final assets | `3840x2160` |
| 4K portrait final assets | `2160x3840` |

If `--size` is omitted, the script uses `defaults.size` from `auth.json`, then the built-in default.

## Quality Guidance

| Quality | Use case |
| --- | --- |
| `low` | Low-cost drafts, direction exploration, many variants |
| `medium` | Normal assets, concept exploration, balanced batch generation |
| `high` | Final assets, text-heavy images, UI, posters, diagrams, detail-sensitive outputs |
| `auto` | Backend decision; useful as an `auth.json` default |

If `--quality` is omitted, the script uses `defaults.quality` from `auth.json`, then the built-in default.

## Transparent Assets

Use `--asset` for asset scenarios. It prefers PNG and fits icons, game items, textures, and sprites.

Use `--transparent` for transparent-background intent. It forces PNG and injects isolated-subject constraints into the prompt.

The script sends `background=transparent` only when `auth.json` contains:

```json
{
  "capabilities": {
    "transparent_background": true
  }
}
```

Transparency has two layers:

```text
prompt layer: always available; requests an isolated subject and alpha-friendly edges
API parameter layer: sent only when the backend supports background=transparent
```

Real alpha pixels depend on the backend response. Use `inspect-image` to verify transparency.

## Batch Concurrency

Batch mode uses limited concurrency:

```text
command --concurrency > auth.json defaults.concurrency > 3
```

High concurrency can trigger rate limits, failures, or unexpected cost.

## JSONL Fields

| Field | Description |
| --- | --- |
| `id` | Task ID used for filenames and manifest entries |
| `mode` | `generate` or `edit`; omitted means edit when `images` exists, otherwise generate |
| `prompt` | Prompt text |
| `file` | Output file path |
| `size` | Image size |
| `quality` | `low`, `medium`, `high`, or `auto` |
| `n` | Number of images returned by one request |
| `format` | `png`, `jpeg`, or `webp` |
| `background` | `auto`, `opaque`, or `transparent` |
| `transparent` | Boolean transparent-background shortcut |
| `asset` | Boolean asset shortcut |
| `images` | Reference image path array |
| `mask` | Mask image path |
| `model` | Override default model |
| `timeout` | Request timeout in seconds |

## Output

The script prints output image paths. In batch mode, it also writes `manifest.json`.
