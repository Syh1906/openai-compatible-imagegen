# Delivery QA Reference

Use QA when the user asks to inspect a file, verify a delivery size, confirm transparency, diagnose alpha geometry, or attach deterministic checks to generated output.

Both release packages use the same `qa.v1` checks. Standalone includes them in CLI JSON and `delivery_ready`; the Codex Plugin maps delivery readiness to `deliveryReady` and persists QA with the related artifact or delivery receipt. QA does not change the model, endpoint, request parameters, or retry policy.

The CLI examples below are for Standalone. Set `SkillDir` as shown in [Local Auth](../SKILL.md#local-auth). Plugin agents use their bundled MCP workflow.

## Commands

Inspect a PNG:

Windows PowerShell:

```powershell
python "$SkillDir/scripts/imagegen.py" inspect-image "input.png"
```

macOS or Linux shell:

```bash
python3 "$SkillDir/scripts/imagegen.py" inspect-image "input.png"
```

Add connected-component diagnostics and an expected size:

Windows PowerShell:

```powershell
python "$SkillDir/scripts/imagegen.py" inspect-image "input.png" `
  --components `
  --expected-size 128x128
```

macOS or Linux shell:

```bash
python3 "$SkillDir/scripts/imagegen.py" inspect-image "input.png" \
  --components \
  --expected-size 128x128
```

Require visible content with a real alpha channel:

Windows PowerShell:

```powershell
python "$SkillDir/scripts/imagegen.py" inspect-image "input.png" `
  --expect-transparent
```

macOS or Linux shell:

```bash
python3 "$SkillDir/scripts/imagegen.py" inspect-image "input.png" \
  --expect-transparent
```

Attach QA to generated or edited output:

Windows PowerShell:

```powershell
python "$SkillDir/scripts/imagegen.py" generate `
  -p "Wide editorial illustration about public transit" `
  -f "raw.png" `
  --qa
```

macOS or Linux shell:

```bash
python3 "$SkillDir/scripts/imagegen.py" generate \
  -p "Wide editorial illustration about public transit" \
  -f "raw.png" \
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

Generation success remains separate from QA. `ok=true` means at least one complete API original was published; it does not claim semantic, aesthetic, dimensional, format, or transparency quality. A failed transparency, transform, or optional QA condition is reported with `delivery_ready=false` and warnings while the API image remains available. QA judges multi-image derivatives per image: passing derivatives remain available, while failed, unsupported, or not-evaluated images fall back to their published originals when that result can be assigned to one image. A global derivative count or global QA failure omits the complete derivative set. The `qa` record contains only published-file evidence.

The response writer records requested-versus-actual published count, pixel size, and format in `api_delivery`. These specification deviations produce warnings and never hide a complete image. Invalid, incomplete, or unpublishable items within a completed response are reported individually without suppressing valid peers; response publication fails only when no complete image can be published. Atomic candidate groups must first collect every requested response successfully; a failed candidate request prevents publication of that group. Item-specific size and format warnings are emitted only after that original is published. An explicit `delivery_size` describes a separate local derivative.

For transparent generation or editing, the transparency record contains route-specific checks for the API image and any local output. When a derived result exists, QA evaluates the final transparent delivery files represented by `derived_files`; it does not treat the simultaneously returned opaque API original as the transparent deliverable. When transparency is unmet, QA evaluates the preserved API original and reports the transparent condition as failed. A failed transparency route skips dependent resize or grid transforms, so `contain` padding or a safe margin cannot make an opaque source look transparent.

`chroma-matting` reports residual `key_contamination`; its contamination threshold is fixed independently from the tunable matte tolerances, so a narrower processing range cannot convert a visible key-color edge into a pass. `emissive-alpha` reports dark-border and luminance mapping checks; `mask-alpha` reports mask-source and mask-processing checks. These are technical signals, not semantic claims about the subject.

## Boundaries

- Original publication accepts a broader PNG subset than local processing. Deep inspection and transforms support non-interlaced 8-bit or 16-bit RGB/RGBA PNG, reducing 16-bit samples to 8-bit for processing. See the [parameter reference](parameters.md#delivery-transform-parameters) for size and validation budgets. Unsupported QA leaves the valid original visible and reports partial or unmet delivery.
- JPEG and WebP originals receive bounded publication checks; deep local pixel QA reports those formats as unsupported.
- `--expect-transparent` checks alpha and visible content. It does not prove semantic isolation or remove a non-uniform background.
- `--transparent` is delivery intent; only the resolved `native-alpha` route sends the API transparency parameter. The native retry policy runs before QA and does not change its checks.
- If prompt-only alpha or a local route fails, the original API file is returned with a warning instead of being rejected.
- An HTTP 4xx response is `api_rejected`, not a transparency failure; no image exists to return.
- Reference-image technical metadata may be `not_evaluated` for semantics. It does not automatically block an edit request.
- Component metrics do not prove that the subject is correct.
- Reference-image style, identity, layout, and semantic fidelity require an external visual review.
- QA never changes the model, endpoint, prompt, background, or request parameters.
- LLM-assisted adjustment can select only documented local routes and parameters within its configured attempt limit. It does not change what deterministic QA proves.
