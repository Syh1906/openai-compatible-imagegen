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

Before publication, the returned image dimensions are checked against the resolved API `size`. If the backend returns a different size, the request fails without creating a mismatched source file. `--delivery-size` remains an independent local transform applied after a correctly sized source image exists.

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

`--transparent` marks a transparent delivery intent and forces PNG. It is never sent to the API as a background value. `--background` accepts only `auto` or `opaque`; the former transparent value was removed.

An explicit `--file` extension must match the resolved output format. For example, a transparent or `--asset` request cannot target a `.jpeg` path because those intents resolve to PNG.

Transparency route selection is deterministic:

| Condition | Route | API request | Result when transparency fails |
| --- | --- | --- | --- |
| `postprocess.enabled=true` or per-run `--postprocess` | `chroma-key` | Normal PNG request with a flat key-color prompt contract | Return the API image unchanged and warn |
| Post-processing disabled and exact `prompt_only_allow` match | `prompt-alpha` | PNG request with a real-alpha prompt contract | Return the API image unchanged and warn |
| No route declared | None | No image request is sent | Report the missing route |

The prompt-only allow list matches `model`, `mode`, and exact pixel `size` together. A rule for `1024x1024` does not authorize another 1K aspect preset. A prompt can improve the probability of alpha output, but it cannot guarantee alpha.

Only add a prompt-only rule after verifying that exact backend combination. In particular, do not turn a 2K or 4K request into a 1K request just to use an alpha prompt. If the route is not declared, report the unsupported combination before sending an image request.

Example configuration:

```json
{
  "postprocess": {
    "enabled": false
  },
  "transparency": {
    "prompt_only_allow": [
      {
        "model": "gpt-image-2",
        "mode": "generate",
        "size": "1024x1024"
      }
    ]
  }
}
```

The old `capabilities.transparent_background` setting and `background=transparent` request value are not supported. Remove them instead of translating them into an API parameter.

Real alpha pixels depend on the returned image. Use `inspect-image --expect-transparent` or request `--qa` to report technical results.

## Delivery Transform Parameters

| Parameter | Meaning |
| --- | --- |
| `--delivery-size` | Exact local output size |
| `--resample` | `bilinear` (default) or `nearest` |
| `--fit` | `stretch` or `contain` for normalization |
| `--safe-margin` | Fractional edge margin used with `contain` |
| `--grid` | Explicit rows and columns such as `3x3` |
| `--expected-count` | Per-source grid count, or QA output count when no grid is used |
| `--postprocess` / `--no-postprocess` | Per-run transparency route override |
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
| `quality`, `n`, `format`, `background` | API request options; background is `auto` or `opaque` |
| `transparent`, `asset` | Explicit output intentions |
| `images`, `mask` | Edit inputs |
| `model`, `timeout` | Per-task request overrides |
| `qa`, `components` | Optional deterministic QA |
| `delivery_size`, `grid`, `expected_count` | Optional derived outputs |
| `resample`, `fit`, `safe_margin` | Optional transform behavior |
| `postprocess` | Per-row permission for the local transparency route |

## Batch Path Contract

Relative paths have separate, deterministic bases:

| Field | Relative to |
| --- | --- |
| `images`, `mask` in a JSONL task | JSONL file directory |
| `file`, `out`, `postprocess_out_dir` in a task or shared command value | batch `--out` directory |

Absolute paths are preserved. Preflight, API task execution, post-processing, and manifest use the same normalized values. The batch manifest records `output_root` and `path_contract`; a failed file-existence check is reported instead of silently claiming a complete delivery.

## API Errors and References

An HTTP 4xx response is an API rejection (`error_kind=api_rejected`) and is not a transparency QA result. It means no image was delivered. Reference-image edits may include technical file metadata and `reference_semantics_not_evaluated`; unusual dimensions or screenshot-like content are reported, not automatically blocked.

## Output

Batch mode writes `manifest.json`. When a derived file is published, the API output stays in `original_files` and the deliverable appears in `files`. If transparency is unmet, that row keeps the API path in `files`, records `transparency.status=unmet`, and remains `ok=true`; warnings explain why no derived transform was published. Optional QA adds a `qa` object without changing `ok` or retrying the request.

Image responses may contain `data[].b64_json` or HTTP(S) `data[].url`. JSON responses are limited to 96 MiB, and each decoded base64 image or streamed URL image is limited to 64 MiB. URL downloads use the configured `user_agent` and never forward the API key. PNG is fully parsed; JPEG and WebP receive bounded container and codec-framing checks before delivery.
