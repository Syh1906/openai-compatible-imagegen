# Delivery QA Reference

Use QA when the user asks to inspect a file, verify a delivery size, confirm transparency, diagnose alpha geometry, or attach deterministic checks to generated output.

## Commands

Inspect a PNG:

```powershell
python "$SkillDir/scripts/imagegen.py" inspect-image "input.png"
```

Add connected-component diagnostics and an expected size:

```powershell
python "$SkillDir/scripts/imagegen.py" inspect-image "input.png" `
  --components `
  --expected-size 128x128
```

Require visible content with a real alpha channel:

```powershell
python "$SkillDir/scripts/imagegen.py" inspect-image "input.png" `
  --expect-transparent
```

Attach QA to generated or edited output:

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Wide editorial illustration about public transit" `
  -f "raw.png" `
  --qa
```

## Inspection Fields

The PNG inspection includes:

- width, height, format, RGBA mode, and SHA-256;
- whether any pixel has alpha below 255;
- alpha bounding box and pixel margins;
- nontransparent coverage and semitransparent ratio;
- corner alpha values and edge contact;
- optional connected-component count, largest component, and tiny component count.

Connected components are diagnostics for isolated subjects, marks, cutouts, and similar files. They are not a universal quality score for scenes, photographs, posters, or layouts.

## QA Status

`qa.v1` uses these statuses:

| Status | Meaning |
| --- | --- |
| `pass` | Every requested deterministic check was evaluated and passed. |
| `fail` | At least one requested deterministic check failed. |
| `partial` | Some checks passed while another check or format is unsupported or not evaluated. |
| `not_evaluated` | No deterministic check produced a result. |

Generation success remains separate from QA. `ok=true` means the request and file-writing workflow completed; it does not claim semantic or aesthetic quality.

For transparent generation or editing with a delivery transform, `qa.artifacts` includes both `source` and `delivery` roles. Transparency conditions carry a matching `scope`; the aggregate status fails if either the API source or the delivery file fails. This prevents `contain` padding or a safe margin from masking an opaque source.

## Boundaries

- Returned-PNG validation and deep local QA use the same parser: non-interlaced 8-bit RGB/RGBA PNG files up to 25 million pixels and a 256 MiB PNG file limit. RGB PNG files with a `tRNS` transparency chunk and other PNG encodings are rejected instead of being guessed.
- JPEG and WebP generation remain supported, but deep local QA reports them as unsupported.
- `--expect-transparent` checks alpha and visible content. It does not prove semantic isolation or remove a background.
- Generated-output QA treats both `--transparent` and `--background transparent` as transparent intent.
- Component metrics do not prove that the subject is correct.
- Reference-image style, identity, layout, and semantic fidelity require an external visual review.
- QA never changes the model, endpoint, prompt, background, or request parameters.
