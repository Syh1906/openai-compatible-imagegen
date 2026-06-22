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

Use `--size` for an exact pixel request. Use `--aspect` plus `--resolution` when the user describes the image shape or clarity but not exact pixels.

Shape choices:

| User intent | Aspect |
| --- | --- |
| Icons, avatars, centered assets, square product images | `1:1` |
| Wide banners, stream backdrops, covers, desktop scenes | `16:9` |
| Landscape illustrations, UI panels, card art | `4:3` |
| Portrait posters, character cards, vertical art | `3:4` |
| Phone wallpapers, short-video covers, tall posters | `9:16` |

Concrete mapping:

| Aspect | `1K` | `2K` | `4K` |
| --- | --- | --- | --- |
| `1:1` | `1024x1024` | `2048x2048` | `4096x4096` |
| `16:9` | `1536x864` | `2048x1152` | `3840x2160` |
| `4:3` | `1536x1152` | `2048x1536` | `4096x3072` |
| `3:4` | `1152x1536` | `1536x2048` | `3072x4096` |
| `9:16` | `864x1536` | `1152x2048` | `2160x3840` |

If `--size` is present, it wins over `--aspect` and `--resolution`. If `--size` and `--aspect` are both omitted, the script uses `defaults.size` from `auth.json`, then the built-in default.

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

## Transparent Background Conflicts

Some backends reject transparent background for selected model and resolution combinations. The script stops before request submission for the known conflicting case:

```text
model=gpt-image-2 + background=transparent + resolution=2K or 4K
```

For explicit `--size`, the script infers this check from the longest side: values at or above 2000 pixels are treated as `2K`, and values at or above 3800 pixels are treated as `4K`.

When this happens, ask the user to choose one path:

1. Switch to `gpt-image-1.5` and keep transparent background.
2. Keep `gpt-image-2` and use `background=auto`.

Do not switch model, drop transparency, retry with altered parameters, or remove the background locally unless the user explicitly chooses that path.

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
| `aspect` | `1:1`, `16:9`, `4:3`, `3:4`, or `9:16` |
| `resolution` | `1K`, `2K`, or `4K` |
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
