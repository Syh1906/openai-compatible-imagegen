# Post-Processing Reference

Post-processing covers PNG inspection, resizing, and grid splitting. It can run as a standalone command or after `generate`, `edit`, and `batch` when post-processing flags are present.

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

## Commands

Inspect a PNG without modifying it:

```powershell
python "$SkillDir/scripts/imagegen.py" inspect-image "input.png"
```

Normalize one PNG to a final delivery size:

```powershell
python "$SkillDir/scripts/imagegen.py" normalize "input.png" `
  --delivery-size 128x128 `
  --out "output.png"
```

Split a known grid into complete cells, trim transparent bounds, and normalize each candidate:

```powershell
python "$SkillDir/scripts/imagegen.py" split-grid "grid.png" `
  --grid 3x3 `
  --delivery-size 128x128 `
  --out-dir "candidates" `
  --expected-count 9
```

Run post-processing after generation:

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "single centered game icon" `
  -f "raw.png" `
  --delivery-size 128x128 `
  --postprocess-out-dir "final"
```

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

## Current Limits

- Post-processing currently supports PNG input/output.
- `normalize` uses deterministic local resizing.
- `split-grid` requires an explicit grid such as `3x3`; automatic grid detection is not implemented.
- Background removal and semantic segmentation are not included.
