# Post-Processing Reference

Post-processing converts returned PNG files into delivery-ready files. It covers inspection, resizing, and grid splitting. You can run it on existing files or directly after `generate`, `edit`, and `batch`.

Use post-processing when the API request size differs from the file size you want to deliver. For example, generate a `1024x1024` source image, then write a `128x128` icon.

## Config

`postprocess.enabled` enables generated-output post-processing in `auth.json`.

`auth.json` does not store a final output size. Use `--delivery-size` on commands that resize or split images.

Example config:

```json
{
  "postprocess": {
    "enabled": false
  }
}
```

With this config, generated-output post-processing can run when a command includes post-processing flags. Standalone commands such as `normalize` and `split-grid` always use the flags passed to that command.

## Output Model

Post-processing writes new files and leaves the source PNG in place.

For `generate`, `edit`, and `batch` with post-processing flags:

| JSON field | Meaning |
| --- | --- |
| `original_files` | Files returned by the image API. |
| `files` | Files written by post-processing. |
| `postprocess` | Inspection, resize, or grid-split details. |

The default generated-output folder is next to the source file and ends with `-postprocess`. Use `--postprocess-out-dir` to choose another folder.

## Commands

Inspect a PNG without modifying it:

```powershell
python "$SkillDir/scripts/imagegen.py" inspect-image "input.png"
```

Example effect: a returned `1024x1024` PNG with transparent pixels prints its dimensions, `has_alpha=true`, and the alpha bounding box. Use this before deciding whether a file needs resizing or grid splitting.

Normalize one PNG to a final delivery size:

```powershell
python "$SkillDir/scripts/imagegen.py" normalize "input.png" `
  --delivery-size 128x128 `
  --out "output.png"
```

Example effect: `input.png` remains unchanged, and `output.png` is written at `128x128`.

Split a known grid into complete cells, trim transparent bounds, and normalize each candidate:

```powershell
python "$SkillDir/scripts/imagegen.py" split-grid "grid.png" `
  --grid 3x3 `
  --delivery-size 128x128 `
  --out-dir "candidates" `
  --expected-count 9
```

Example effect: a `3x3` candidate sheet writes 9 PNG files into `candidates`. Each output is resized to `128x128`.

Run post-processing after generation:

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "single centered game icon" `
  -f "raw.png" `
  --delivery-size 128x128 `
  --postprocess-out-dir "final"
```

Example effect: the API response is saved as `raw.png`, and the resized delivery file is written under `final`.

For a generated grid:

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "3x3 sheet of distinct game icon candidates" `
  -f "grid.png" `
  --grid 3x3 `
  --delivery-size 128x128 `
  --expected-count 9 `
  --postprocess-out-dir "candidates"
```

Example effect: the API response is saved as `grid.png`, and 9 normalized PNG files are written under `candidates`.

## Current Limits

- Post-processing currently supports PNG input/output.
- `normalize` uses deterministic local resizing.
- `split-grid` requires an explicit grid such as `3x3`; automatic grid detection is not implemented.
- Background removal and semantic segmentation are not included.
