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

Generation success remains separate from QA. `ok=true` means at least one complete API original was published; it does not claim semantic, aesthetic, dimensional, format, or transparency quality. A failed transparency, transform, or optional QA condition is reported with `delivery_ready=false` and warnings while the API image remains available. QA judges multi-image derivatives per image: passing derivatives remain available, while failed, unsupported, or not-evaluated images fall back to their published originals when that result can be assigned to one image. A global derivative count or global QA failure omits the complete derivative set. The `qa` record contains only published-file evidence.

The response writer records requested-versus-actual published count, pixel size, and format in `api_delivery`. These specification deviations produce warnings and never hide a complete image. Invalid, incomplete, or unpublishable response items are reported individually without suppressing valid peers; the operation fails only when no complete image can be published. Item-specific size and format warnings are emitted only after that original is published. An explicit `delivery_size` describes a separate local derivative.

For transparent generation or editing, the transparency record contains route-specific checks for the API image and any local output. When a derived result exists, QA evaluates the final transparent delivery files represented by `derived_files`; it does not treat the simultaneously returned opaque API original as the transparent deliverable. When transparency is unmet, QA evaluates the preserved API original and reports the transparent condition as failed. A failed transparency route skips dependent resize or grid transforms, so `contain` padding or a safe margin cannot make an opaque source look transparent.

`chroma-matting` reports residual `key_contamination`; its contamination threshold is fixed independently from the tunable matte tolerances, so a narrower processing range cannot convert a visible key-color edge into a pass. `emissive-alpha` reports dark-border and luminance mapping checks; `mask-alpha` reports mask-source and mask-processing checks. These are technical signals, not semantic claims about the subject.

## Boundaries

- Original PNG publication and deep local QA use separate validation boundaries. Publication always checks PNG container structure, chunk ordering, CRCs, dimensions, encoding fields, compressed-stream completion, and a 4096-`IDAT`-chunk limit. Full scanline, filter, and Adam7 pass validation runs through 96 MiB of expected decompressed scanlines. From 96 MiB through 512 MiB, a bounded streaming pass validates zlib completion and exact decompressed length without retaining scanlines; a complete original is published with `api_response_validation_budget_exceeded`. Above 512 MiB, that item is rejected with `api_response_item_resource_limited`, while originals published from earlier response items remain available. Corrupt, incomplete, or excessively fragmented IDAT data is rejected at every size. Deep QA supports non-interlaced 8-bit or 16-bit RGB/RGBA PNG files up to 25 million pixels, a 256 MiB PNG file limit, and the same IDAT chunk limit. The local codec reduces 16-bit channel samples to 8-bit RGBA. Unsupported QA leaves the published original visible and reports a partial or unmet delivery state.
- JPEG and WebP originals receive bounded publication checks. JPEG receives framing checks; WebP receives RIFF and chunk-bound checks, VP8 adds keyframe, dimension, and first-partition checks, and VP8L receives full bounded entropy-stream validation. Deep local pixel QA still reports JPEG and WebP as unsupported.
- `--expect-transparent` checks alpha and visible content. It does not prove semantic isolation or remove a non-uniform background.
- `--transparent` is delivery intent; it does not send a transparent background parameter to the API.
- If prompt-only alpha or a local route fails, the original API file is returned with a warning instead of being rejected.
- An HTTP 4xx response is `api_rejected`, not a transparency failure; no image exists to return.
- Reference-image technical metadata may be `not_evaluated` for semantics. It does not automatically block an edit request.
- Component metrics do not prove that the subject is correct.
- Reference-image style, identity, layout, and semantic fidelity require an external visual review.
- QA never changes the model, endpoint, prompt, background, or request parameters.
- LLM-assisted adjustment can select only documented local routes and parameters within its configured attempt limit. It does not change what deterministic QA proves.
