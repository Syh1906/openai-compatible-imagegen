# Post-Processing Reference

Load this file only when the user explicitly asks for image inspection, delivery-size normalization, resizing, cropping, grid splitting, candidate extraction, or when `auth.json` has `postprocess.enabled=true`.

## Compatibility Contract

Post-processing is opt-in and must not change legacy behavior.

- Missing `postprocess` in `auth.json` means disabled.
- When disabled and no explicit post-processing command is used, `generate`, `edit`, and `batch` keep their existing behavior: call the API, save returned images, and print paths.
- Do not auto-resize, crop, split grids, overwrite files, or switch models just because an output does not match an expected delivery size.
- Read-only inspection is allowed only when the task asks for inspection or a post-processing command is being run.

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

Run post-processing directly after generation or edit only when explicitly requested:

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

## Decision Rules

- Treat a user-specified small icon size as the final delivery size, not proof that the backend will return that size.
- If the API returns a different size and post-processing is disabled, report the mismatch and ask before normalizing.
- Prefer batch generation for multiple independent candidates.
- Use grid splitting only when the user requests a grid/candidate sheet or provides a grid image.
- Do not let the LLM hand-write crop coordinates for a grid. Use `split-grid` with explicit or verified rows and columns.
- If expected count and grid count differ, stop and ask whether to keep all candidates, discard extras, or regenerate.

## Current Limits

- Post-processing currently supports PNG input/output.
- `normalize` uses deterministic local resizing.
- `split-grid` requires an explicit grid such as `3x3`; automatic grid detection is not implemented.
- Background removal and semantic segmentation are not included.
