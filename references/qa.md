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

Generation success remains separate from QA. `ok=true` means the API request and file-writing workflow completed; it does not claim semantic, aesthetic, or transparency quality. A transparency failure is reported as `transparency.status=unmet` with warnings while the API image remains deliverable.

The response writer also enforces the resolved API pixel size before publication. A backend response with different dimensions is rejected and no mismatched source file is published. This check is separate from an explicit `delivery_size`, which describes a permitted local derivative.

For transparent generation or editing, the transparency record contains route-specific checks for the API image and, when used, the chroma-key output. QA evaluates the file returned in `files`. A failed transparency route skips dependent resize or grid transforms, so `contain` padding or a safe margin cannot make an opaque source look transparent.

The chroma-key checks also report `key_contamination` for residual key color near partial-alpha and subject-boundary pixels. This is a quality signal for the local route, not a semantic claim about the subject.

## Boundaries

- Returned-PNG validation and deep local QA use the same parser: non-interlaced 8-bit RGB/RGBA PNG files up to 25 million pixels and a 256 MiB PNG file limit. RGB PNG files with a `tRNS` transparency chunk and other PNG encodings are rejected instead of being guessed.
- JPEG and WebP generation remain supported, but deep local QA reports them as unsupported.
- `--expect-transparent` checks alpha and visible content. It does not prove semantic isolation or remove a non-uniform background.
- `--transparent` is delivery intent; it does not send a transparent background parameter to the API.
- If the prompt-only alpha route fails, or chroma-key validation fails, the original API file is returned with a warning instead of being rejected.
- An HTTP 4xx response is `api_rejected`, not a transparency failure; no image exists to return.
- Reference-image technical metadata may be `not_evaluated` for semantics. It does not automatically block an edit request.
- Component metrics do not prove that the subject is correct.
- Reference-image style, identity, layout, and semantic fidelity require an external visual review.
- QA never changes the model, endpoint, prompt, background, or request parameters.
