# Post-Processing Reference

Post-processing converts returned PNG files into delivery files. It covers deterministic transparency processing, inspection, resizing, fit behavior, safe margins, grid splitting, QA, and preview boards. In generation, edit, and batch workflows, an API original remains recorded in `original_files` whenever a derived output is published.

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
| `original_files` | Files returned by the image API |
| `files` | Derived delivery files |
| `postprocess` | Transform details and inspections |
| `transparency` | Selected route, aggregate status, per-image artifacts, checks, and warnings |
| `delivery_ready` | Whether the requested transparency and optional QA conditions passed |
| `warnings` | Non-blocking conditions such as unmet alpha or skipped dependent transforms |
| `qa` | Optional `qa.v1` checks requested with `--qa` |

The default derived-output directory is next to the source file and ends with `-postprocess`. Use `--postprocess-out-dir` to select another directory.

## Transparency Processing

Use `--transparent` for a transparent delivery request. The flag forces PNG and never becomes an API `background` parameter.

When local post-processing is allowed, the explicit route wins; otherwise the script uses `transparency.default_route`.

| Route | Use when | Processing contract |
| --- | --- | --- |
| `chroma-matting` | General isolated objects, marks, UI elements, and solid assets | Generate one uniform key-color background, remove only edge-connected key pixels, despill edges, then validate alpha |
| `emissive-alpha` | Fire, particles, lightning, smoke, glow, and other additive effects | Generate on pure black, map luminance to alpha, preserve soft falloff, then validate alpha |
| `mask-alpha` | A trusted mask already exists | Read mask alpha or luminance, apply bounded threshold/feather/expand controls, then validate alpha |

If the API image already has usable alpha, that original file remains the delivery file. When local pixels change, the derived file is named `<source-stem>-transparent.png`.

The quality gate checks edge key-color coverage, transparent-pixel ratio, visible-pixel ratio, visible border ratio, and key-color contamination around partial-alpha or transparency-adjacent subject edges. Its contamination tolerance is independent from `inner_tolerance` and `outer_tolerance`, so narrowing the processing range cannot weaken acceptance. A non-uniform edge or unrecoverable contamination is an `unmet` result; the processor does not publish a guessed cutout.

When local post-processing is disabled, the request can use the `prompt-alpha` route only if `auth.json.transparency.prompt_only_allow` exactly matches the model, mode, and pixel size. The prompt requests a real alpha channel, but the model may still return an opaque image.

Transparency processing is observational after the API response exists:

- `pass`: keep a native-alpha API file as-is, or publish the validated derived file, set `delivery_ready=true`, then apply any requested delivery transform.
- `unmet`: keep the API file in `files`, set `transparency.status=unmet` and `delivery_ready=false`, and add a warning.
- If a transparent delivery transform cannot run because transparency is unmet, skip that transform for that image. Do not create transparent padding around an opaque source.

The API request remains successful when transparency is unmet. For a batch, each returned image is evaluated independently.

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

For `chroma-matting`, also pass `--key "#00FF00"`. For `mask-alpha`, pass `--transparency-mask "mask.png"`. The command always emits a JSON result after processing. A validated output returns `status=pass` and `delivery_ready=true`. An unmet route copies the original image to `--out`, returns `status=unmet` and `delivery_ready=false`, and still exits successfully so the caller can return the preserved file with its warning.

## LLM-Assisted Adjustment

When `transparency.llm_assisted.enabled=true`, the agent can inspect the original image and route checks, then run bounded additional `apply-transparency` attempts. `max_attempts` includes the first local run. Parameter tuning and route changes obey their individual switches and the route input contracts. Each attempt must pass the unchanged deterministic checks and be reviewed on contrasting preview backgrounds; tuning a processing tolerance never relaxes the quality gate. Another image API call requires `allow_api_retry=true`.

This mode uses the current agent's visual reasoning only to select a route and documented parameter values. It does not add a model to the Python process, execute generated algorithms, install inference packages, or download weights. If every permitted attempt remains unmet, the original API image and warnings remain the result.

Every bundled Python command runs in the foreground. The scripts do not spawn child processes or retain background workers; batch threads are joined before process exit. The caller must wait for completion and close the launched process after an interrupt or launcher timeout.

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

- Deep inspection and local transforms support non-interlaced 8-bit RGB/RGBA PNG input up to 25 million pixels and 256 MiB, with PNG output. RGB PNG files with a `tRNS` transparency chunk are rejected.
- JPEG and WebP generation remain supported, but deep local QA reports those formats as unsupported.
- `split-grid` requires an explicit grid.
- Preview boards do not include text labels; use `preview-manifest.json` for cell metadata.
- Automatic semantic segmentation, OCR, brand validation, and aesthetic scoring are not included. Local transparency supports native alpha, edge-connected key-color matting, emissive luminance alpha, and explicit masks.
