# Post-Processing Reference

Post-processing converts returned PNG files into delivery files. It covers deterministic inspection, resizing, fit behavior, safe margins, grid splitting, QA, and preview boards. In generation, edit, and batch workflows, API originals remain recorded in `original_files` while derived outputs are recorded in `files`.

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
| `qa` | Optional `qa.v1` checks requested with `--qa` |

The default derived-output directory is next to the source file and ends with `-postprocess`. Use `--postprocess-out-dir` to select another directory.

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

`--qa` can also run without a delivery transform. It attaches deterministic checks to the saved API files. For transparent requests with a transform, source and delivery transparency are checked separately. QA does not change generation success or retry a request.

## Current Limits

- Deep inspection and local transforms support non-interlaced 8-bit RGB/RGBA PNG input up to 25 million pixels and 256 MiB, with PNG output. RGB PNG files with a `tRNS` transparency chunk are rejected.
- JPEG and WebP generation remain supported, but deep local QA reports those formats as unsupported.
- `split-grid` requires an explicit grid.
- Preview boards do not include text labels; use `preview-manifest.json` for cell metadata.
- Background removal, semantic segmentation, OCR, brand validation, and aesthetic scoring are not included.
