# Parameter Reference

## Parameter Priority

```text
per-row batch fields > shared command flags > auth.json defaults > built-in defaults
```

Command flags override configuration defaults. Batch rows override shared command values for each task. Command-only authorization such as `--allow-direct-url-download` cannot be enabled by a batch row.

This is the runtime order after the agent has interpreted the request and constructed the command. If agent judgment is written as a shared flag, that value follows the same runtime order and overrides `auth.json`. Leave the flag unset when the configured default should remain authoritative.

## Modes

| Mode | Command | Behavior |
| --- | --- | --- |
| Text-to-image | `generate` | `POST /v1/images/generations` |
| Image edit | `edit` | `POST /v1/images/edits` |
| Batch | `batch` | Selects `generate` or `edit` per row |
| Config summary | `info` | No API call |
| Inspect | `inspect-image` | Local PNG inspection and optional expectations |
| Normalize | `normalize` | Local PNG delivery transform |
| Grid split | `split-grid` | Local explicit-grid extraction |
| Preview | `preview-board` | Local target-size and background previews |

## Size Guidance

Use `--size` for exact API output pixels. Use `--aspect` plus `--resolution` when the request describes shape and clarity without exact pixels.

| User intent | Aspect |
| --- | --- |
| Square product image, profile image, centered mark, game icon | `1:1` |
| Wide banner, cover, presentation background, desktop scene | `16:9` |
| Landscape illustration, interface panel, editorial image | `4:3` |
| Portrait poster, product card, editorial portrait | `3:4` |
| Phone wallpaper, story graphic, vertical poster | `9:16` |

| Aspect | `1K` | `2K` | `4K` |
| --- | --- | --- | --- |
| `1:1` | `1024x1024` | `2048x2048` | `4096x4096` |
| `16:9` | `1536x864` | `2048x1152` | `3840x2160` |
| `4:3` | `1536x1152` | `2048x1536` | `4096x3072` |
| `3:4` | `1152x1536` | `1536x2048` | `3072x4096` |
| `9:16` | `864x1536` | `1152x2048` | `2160x3840` |

`--size` wins over `--aspect` and `--resolution`. When all are omitted, the script uses `defaults.size`, then its built-in size.

## Quality Guidance

| Quality | Use case |
| --- | --- |
| `low` | Low-cost drafts and direction exploration |
| `medium` | General creation and balanced batches |
| `high` | Final visuals, text-sensitive layouts, posters, interfaces, and detailed images |
| `auto` | Backend-selected quality |

## Visual Deliverables and Transparency

`--asset` marks an explicit single visual deliverable and prefers PNG. It can represent a logo element, product cutout, sticker, interface element, game asset, diagram element, or other isolated deliverable. It does not select an industry or force a centered composition.

`--transparent` and `--background transparent` express the same transparent-background intent. Either form forces PNG and adds isolated-subject constraints; the API receives `background=transparent` only when `auth.json` declares support.

An explicit `--file` extension must match the resolved output format. For example, a transparent or `--asset` request cannot target a `.jpeg` path because those intents resolve to PNG.

Real alpha pixels depend on the backend response. Use `inspect-image --expect-transparent` to validate the returned file.

Known conflict validation stops this request before submission:

```text
model=gpt-image-2 + background=transparent + resolution=2K or 4K
```

When a conflict occurs, choose explicitly whether to change the model or keep the model with `background=auto`. The script does not make that choice automatically.

## Delivery Transform Parameters

| Parameter | Meaning |
| --- | --- |
| `--delivery-size` | Exact local output size |
| `--resample` | `bilinear` (default) or `nearest` |
| `--fit` | `stretch` or `contain` for normalization |
| `--safe-margin` | Fractional edge margin used with `contain` |
| `--grid` | Explicit rows and columns such as `3x3` |
| `--expected-count` | Per-source grid count, or QA output count when no grid is used |
| `--qa` | Attach `qa.v1` delivery checks |
| `--components` | Add connected-component diagnostics |
| `--postprocess-out-dir` | Derived-output directory |

`bilinear` is dependency-free and alpha-aware. Use `nearest` when exact pixel replication is intentional.

Returned-PNG validation, local deep inspection, and transforms accept non-interlaced 8-bit RGB/RGBA PNG files up to 25 million pixels and a 256 MiB PNG file limit. RGB PNG files with a `tRNS` transparency chunk and other PNG encodings are rejected because this local codec does not implement them. API generation can still return supported JPEG or WebP files, but local deep QA reports those formats as unsupported.

## Batch Concurrency

```text
command --concurrency > auth.json defaults.concurrency > 3
```

High concurrency can trigger rate limits, failures, or unexpected cost.

## JSONL Fields

| Field | Description |
| --- | --- |
| `id` | Stable task identifier |
| `mode` | `generate` or `edit` |
| `prompt` | Prompt text |
| `file` | Output file path |
| `size`, `aspect`, `resolution` | API output dimensions |
| `quality`, `n`, `format`, `background` | API request options |
| `transparent`, `asset` | Explicit output intentions |
| `images`, `mask` | Edit inputs |
| `model`, `timeout` | Per-task request overrides |
| `qa`, `components` | Optional deterministic QA |
| `delivery_size`, `grid`, `expected_count` | Optional derived outputs |
| `resample`, `fit`, `safe_margin` | Optional transform behavior |

## Output

Batch mode writes `manifest.json`. Optional post-processing preserves API output paths in `original_files` and writes derived paths in `files`. Optional QA adds a `qa` object without changing `ok` or the command exit code.

Image responses may contain `data[].b64_json` or HTTP(S) `data[].url`. JSON responses are limited to 96 MiB, and each decoded base64 image or streamed URL image is limited to 64 MiB. URL downloads use the configured `user_agent` and never forward the API key. PNG is fully parsed; JPEG and WebP receive bounded container and codec-framing checks before delivery.
