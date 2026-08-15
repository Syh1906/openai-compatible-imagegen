# Post-Processing Reference

Post-processing converts returned PNG files into additional delivery files. It covers deterministic transparency processing, inspection, resizing, fit behavior, safe margins, grid splitting, QA, and preview boards. In generation, edit, and batch workflows, every published API original remains recorded in `original_files` and `files`, whether a derivative succeeds or fails.

The Standalone CLI and Codex Plugin use the same post-processing implementation. Standalone reports `delivery_ready`; the Plugin reports `deliveryReady` and stores successful derivatives with their source relationship. A transparency alpha mask is an input to transparent delivery, while Codex canvas edit/protect regions express model editing intent; they are not interchangeable.

Read [qa.md](qa.md) when the request includes quality checks. Read [prompting.md](prompting.md) when the request needs structured prompt construction or controlled batch variation.

## Natural-Language Requests

- "Generate a 1536x1152 editorial source image, then deliver a 1200x900 PNG."
- "Resize this product cutout to 512x512, contain it with a 3% margin, and keep the source file."
- "Inspect this transparent logo, report edge contact and connected components, then preview it on white and black backgrounds."
- "Generate a 3x3 concept sheet and split it into nine 256x256 PNG files."
- "Create a square game ability icon, then preview it at 64x64 and 128x128."

## Output Model

Generated-output post-processing adds these fields:

| JSON field | Meaning |
| --- | --- |
| `original_files` | Canonical paths of files returned by the image API |
| `files` | API originals followed by successfully published derived delivery files |
| `derived_files` | Only successfully published derived delivery files; omitted when none exists |
| `postprocess` | Transform details and inspections |
| `transparency` | Selected route, aggregate status, per-image artifacts, checks, and warnings |
| `api_delivery` | Requested-versus-actual count, format, size, item positions, and original paths |
| `delivery_ready` | Whether requested transparency, transforms, and optional QA conditions passed |
| `warnings` | Non-blocking conditions such as API specification deviations, unmet alpha, or failed transforms |
| `qa` | Optional `qa.v1` checks requested with `--qa` |

The default derived-output directory is next to the source file and ends with `-postprocess`. Use `--postprocess-out-dir` to select another directory.

## Transparency Processing

Use `--transparent` for a transparent delivery request. The flag forces PNG and never becomes an API `background` parameter.

An explicit route wins when it is compatible with the processing switch. Otherwise, local processing uses `transparency.default_route`; when local processing is disabled, an exact prompt-only allow rule may select `prompt-alpha`. Every other size, including 2K and 4K, still reaches the API with the user's prompt unchanged and receives source-alpha inspection without local pixel changes.

| Route | Use when | Processing contract |
| --- | --- | --- |
| `chroma-matting` | General isolated objects, marks, UI elements, and solid assets | Generate one uniform key-color background, extract a bounded color range, refine the 8-bit matte, remove source matte contamination, defringe edges, then validate alpha |
| `emissive-alpha` | Fire, particles, lightning, smoke, glow, and other additive effects | Generate on pure black, map luminance to alpha, preserve soft falloff, then validate alpha |
| `mask-alpha` | A trusted mask or channel already exists | Read mask alpha, luminance, or an explicit RGB channel; refine the matte; optionally remove a declared black/white source matte from partial-alpha edges while protecting fully opaque foreground; then validate alpha |

The local routes use the same 8-bit Alpha workflow as common layer-mask editing: profile the background or mask, extract a continuous matte, adjust edge position and feathering, remove small hard-edge components when requested, remove a known source matte, and defringe contaminated edge colors. `chroma-matting` defaults to edge-connected color range so a matching subject color is protected. Set `background_scope=global` only for key-color holes enclosed by the subject. Emissive processing skips hard component cleanup because separate sparks, smoke, and soft glow are valid foreground.

These routes cover different Photoshop-style techniques rather than forming a chroma-only pipeline:

| Traditional technique | Deterministic route | Required evidence |
| --- | --- | --- |
| Color Range plus spill suppression | `chroma-matting` | A known uniform key plate |
| Channels or Calculations-style grayscale matte | `mask-alpha` with `source=luminance|red|green|blue` | A supplied mask whose selected channel separates foreground |
| Layer mask refinement | `mask-alpha` | A trusted mask, optional threshold, expand, feather, gamma, and component controls |
| Remove Black/White Matte and Defringe | `mask-alpha` or `chroma-matting` cleanup | The source matte color is known |
| Screen/additive extraction from black | `emissive-alpha` | Emissive content on a dark, uniform border |

Hair, fur, glass, translucent fabric, reflected color, and smoke mixed with a detailed background cannot be reliably inferred by these deterministic routes without a controlled plate or trusted mask. Return the original with `status=unmet`; do not convert a plausible-looking hard cutout into a reported success.

If the API image already has usable alpha, that original file remains the transparent delivery and no duplicate derived file is published. When local pixels change, the derived file is named `<source-stem>-transparent.png`; with `delivery_size` or `grid`, only the final transformed files are published, so an intermediate transparency file is not leaked.

The quality gate checks edge key-color coverage, transparent-pixel ratio, visible-pixel ratio, visible border ratio, and direct or directional key-color contamination around partial-alpha or transparency-adjacent subject edges. Directional checks catch pale green, cyan, yellow, or magenta spill even when its absolute RGB distance exceeds the extraction range. Contamination limits are independent from `inner_tolerance` and `outer_tolerance`, so narrowing the processing range cannot weaken acceptance. A non-uniform edge or unrecoverable contamination is an `unmet` result; the processor does not publish a guessed cutout.

When local processing is disabled, the request can use the `prompt-alpha` route only if `auth.json.transparency.prompt_only_allow` exactly matches the model, mode, and pixel size. The prompt requests a real alpha channel, but the model may still return an opaque image. A 2K/4K request without such a rule still runs with the original prompt; the returned image is preserved and checked for native alpha only.

Transparency processing is observational after the API response exists:

- `pass`: keep a native-alpha API file as-is, or publish the validated derived file, set `delivery_ready=true`, then apply any requested delivery transform. The returned `files` contains the API original and the final derived result when one exists.
- `unmet`: keep only the API file in `files`, set `transparency.status=unmet` and `delivery_ready=false`, and add a warning.
- If a transparent delivery transform cannot run because transparency is unmet, skip that transform for that image. Do not create transparent padding around an opaque source.

The API request remains successful when transparency is unmet. For a batch, each returned image is evaluated independently.

The same preservation rule applies to non-transparent transforms. A resize, grid split, or QA failure sets `delivery_ready=false` and returns the already-published API originals with a factual warning. One image's transform or final publication failure keeps successful peer derivatives. Multi-image QA retains passing derivatives and omits failed, unsupported, or not-evaluated per-image derivatives when the result can be assigned to one image. A global derivative count or global QA failure omits the complete derivative set. API originals publish independently, so one response item's target collision does not hide successful peers. None of these outcomes changes `ok=true` after at least one original is published.

An HTTP 4xx response is different: it is an API rejection before an image exists (`error_kind=api_rejected`), so there is no original image to return and no transparency result to attach.

Batch relative output paths are based at `--out`; JSONL `images`, `mask`, and `transparency_mask` inputs are based at the JSONL file directory. The manifest records the resolved `output_root` and file-existence `path_contract`.

## Apply Transparency to an Existing PNG

Use `apply-transparency` to reprocess an original API image without another API request:

```powershell
python "$SkillDir/scripts/imagegen.py" apply-transparency "effect.png" `
  --out "effect-transparent.png" `
  --route emissive-alpha `
  --transparency-param "black_point=8" `
  --transparency-param "gamma=1.2"
```

For `chroma-matting`, also pass `--key "#00FF00"`. For `mask-alpha`, pass `--transparency-mask "mask.png"`. The command always emits a JSON result after processing. A validated output returns `status=pass` and `delivery_ready=true`. An unmet route returns the source image path, does not create an `--out` duplicate, reports `status=unmet` and `delivery_ready=false`, and exits successfully so the source file remains available with its warning.

## LLM-Assisted Adjustment

When `transparency.llm_assisted.enabled=true`, the agent can inspect the original image and route checks, then run bounded additional `apply-transparency` attempts. `max_attempts` includes the first local run. Parameter tuning and route changes obey their individual switches and the route input contracts. Each attempt must pass the unchanged deterministic checks and be reviewed on contrasting preview backgrounds; tuning a processing tolerance never relaxes the quality gate. Another image API call requires `allow_api_retry=true`.

If every permitted attempt remains unmet, the original API image and warnings remain the result.

Example:

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Isolated ceramic vase, front three-quarter view, no floor, no lettering" `
  -f "outputs/vase.png" `
  --transparent `
  --postprocess `
  --qa
```

## Inspect

```powershell
python "$SkillDir/scripts/imagegen.py" inspect-image "input.png"
```

Optional expectations:

```powershell
python "$SkillDir/scripts/imagegen.py" inspect-image "input.png" `
  --components `
  --expected-size 512x512 `
  --expect-transparent
```

Without expectations, the command prints inspection metrics. With expectations, it prints a `qa.v1` result.

## Normalize

Stretch to an exact delivery size:

```powershell
python "$SkillDir/scripts/imagegen.py" normalize "input.png" `
  --delivery-size 1200x900 `
  --resample bilinear `
  --out "output.png"
```

Preserve aspect ratio with a fractional edge margin:

```powershell
python "$SkillDir/scripts/imagegen.py" normalize "input.png" `
  --delivery-size 512x512 `
  --fit contain `
  --safe-margin 0.03 `
  --out "output.png"
```

`stretch` is the compatibility fit mode. `contain` preserves aspect ratio on a transparent canvas. `bilinear` is the dependency-free default; `nearest` is available for intentional pixel replication.

## Split a Known Grid

```powershell
python "$SkillDir/scripts/imagegen.py" split-grid "sheet.png" `
  --grid 3x3 `
  --delivery-size 256x256 `
  --expected-count 9 `
  --resample bilinear `
  --out-dir "candidates"
```

The command divides the complete canvas using the explicit grid, trims transparent bounds inside each cell, and contains each result in the delivery canvas. It does not detect grids automatically.

## Preview Board

```powershell
python "$SkillDir/scripts/imagegen.py" preview-board "input.png" `
  --size 64x64 `
  --size 256x256 `
  --preview-background transparent `
  --preview-background white `
  --preview-background checker `
  --out-dir "previews"
```

The output directory contains each size/background variant, a combined board, and `preview-manifest.json`. The manifest maps every board cell to its file, size, and background. The command checks each preview, the cumulative preview workload, and the combined board against pixel limits before allocating their buffers.

## Generated-Output QA

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Wide editorial illustration about urban shade" `
  -f "raw.png" `
  --delivery-size 1200x900 `
  --qa `
  --postprocess-out-dir "final"
```

`--qa` can also run without a delivery transform. It attaches deterministic checks to the files actually returned. Transparency processing records its own source checks and route warnings; QA checks the published delivery file rather than treating an opaque key-color API source as the final transparent result. QA does not change generation success or retry a request.

## Current Limits

- Deep inspection and local transforms support non-interlaced 8-bit or 16-bit RGB/RGBA PNG input up to 25 million pixels, 256 MiB, and 4096 `IDAT` chunks, with PNG output. The local codec reduces 16-bit channel samples to 8-bit RGBA. Other complete standard PNG encodings are still published as API originals when they meet the bounded response checks; unavailable local processing is reported without hiding the source.
- JPEG and WebP generation remain supported, but deep local QA reports those formats as unsupported.
- `split-grid` requires an explicit grid.
- Preview boards do not include text labels; use `preview-manifest.json` for cell metadata.
- Automatic semantic segmentation, OCR, brand validation, and aesthetic scoring are not included. Local transparency supports native alpha, edge-connected key-color matting, emissive luminance alpha, and explicit masks.
- Hair, fur, glass, translucent fabric, and complex mixed-background smoke require a controlled plate or trusted mask; otherwise deterministic processing returns the original as unmet.
