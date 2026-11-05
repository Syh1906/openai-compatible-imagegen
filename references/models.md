# API model profiles

Standalone reads this structure only from its own `auth.json`. Plugin configuration is separate. Existing flat and v1 configurations remain readable; v2 adds metadata and per-model defaults without silently changing existing files.

```json
{
  "config_version": 2,
  "active_profile": "studio/image",
  "providers": {
    "studio": {
      "protocol": "openai-compatible",
      "base_url": "https://images.example.com/v1",
      "api_key_env": "STUDIO_IMAGE_KEY"
    }
  },
  "models": {
    "studio/image": {
      "provider": "studio",
      "model": "gpt-image-2",
      "display_name": "Studio",
      "aliases": ["studio"],
      "capabilities": {"generate": true, "edit": true, "mask": true, "multi_reference": true},
      "limits": {"output_size": {"multiple_of": 16, "max_aspect_ratio": 3}},
      "defaults": {"size": "1024x1024", "quality": "medium", "output_format": "png"}
    }
  },
  "defaults": {"timeout_seconds": 600, "concurrency": 3}
}
```

Replace example addresses and exact model IDs with values supported by the selected provider. Each provider independently owns its protocol, URL, API key source, optional proxy, and optional full `endpoints.generate`/`endpoints.edit` URLs. `{model}` in an override URL is replaced with the URL-encoded model ID. No model-name or domain-based routing is performed.

Protocols are `openai-compatible`, `atlas`, `xai-images`, `gemini-interactions`, and `gemini-generate-content`. OpenAI-compatible edits use multipart; xAI and Gemini edits send image snapshots as JSON. Atlas supports generation only. The native adapters are independent and never automatically replace one another. Gemini common fields use aspect ratio and resolution; Interactions additionally supports format. xAI also supports quality. Native protocols do not inherit OpenAI pixel-size defaults.

Run `imagegen.py list-models`, then pass `--profile` with the exact profile ID or unique configured alias. Actual model IDs are accepted only when they resolve uniquely. JSONL rows can select independent `modelProfileId` values. Preserve explicit user selection and do not change the configured default for one request.

V2 API `transparency` also belongs to each model profile; top-level transparency does not override it. Only OpenAI-compatible supports the dedicated `native-alpha` request parameter. V2 image `defaults` belong to each model; shared defaults contain only execution settings. A higher-priority `size` replaces lower-priority aspect ratio/resolution and vice versa. Supplying both representations at the same priority is invalid. `parameters` extends native JSON fields, and `--parameters` or row-level `parameters` override corresponding configured fields. Request identity, inputs, count, authentication, and routing cannot be replaced. Common resolved fields win on overlap. Do not put credentials in parameters.

Model `parameter_fields` entries describe controls with `title`, `description`, `type`, `path`, optional `default`, `enum`, `minimum`, and `maximum`. Types are string, integer, number, boolean, object, and array; paths are non-overlapping lists of object keys. For example, a Gemini seed field can use `{"type":"integer","path":["generationConfig","seed"],"default":7}`. Field hints do not establish service support or a future value whitelist. Optional `limits.max_input_images` bounds the total parent and reference images.

For exact pixel size, use local delivery on supported PNG sources independently of native generation options. Local delivery does not transcode JPEG or WebP. Publish valid originals even when count, dimensions, or format differ from the request, and report those facts. Unknown provider outcomes do not authorize regeneration.

## Output size limits

`limits.output_size` is optional in v1/v2 model profiles and at the top level of flat Standalone configuration. It applies only to `openai-compatible` and `atlas` pixel `size` requests. Read it through `list-models` or flat-config `info`; missing or empty declarations mean unknown, not unlimited. Do not infer support from defaults or model names. Existing files are not upgraded automatically. A legacy `--model` override naming a different model does not inherit the old model's limits; use a configured profile to supply the new model's verified constraints.

Legacy Standalone `--size auto` remains service-selected and is not checked against pixel constraints because no exact dimensions are specified.

Declare `allowed_sizes` as a non-empty list of exact `WIDTHxHEIGHT` strings, `multiple_of` as the required divisor of each edge, `max_aspect_ratio` as the maximum long-edge/short-edge ratio (at least 1), `min_edge`/`max_edge` as inclusive bounds on each edge, and `min_pixels`/`max_pixels` as inclusive bounds on width times height. Integer bounds must be positive. All supplied constraints apply together, including to the allowed-size list. Native aspect/resolution options are not converted to guessed pixels.

The GPT Image 2 examples use `{"output_size":{"multiple_of":16,"max_aspect_ratio":3}}`, matching the [OpenAI generation](https://developers.openai.com/api/reference/resources/images/methods/generate) and [editing](https://developers.openai.com/api/reference/resources/images/methods/edit) contracts. This is a partial, explicit declaration, not a universal protocol rule. Confirm requirements for the selected provider before copying or changing it. New initialization with a different model omits the template's model-specific limits.

Limits are checked after request options are resolved and before transport, including generation, edits, and batch rows. A rejection explains the failing dimensions and constraint; do not change size, retry, or switch channels automatically. Passing these checks does not establish support for undeclared restrictions. A user's final file size is separate from the API generation size: choose a supported canvas and use explicit `--fit contain` for proportional local delivery with padding. The default `stretch` changes proportions. Full-bleed output without distortion needs an agreed crop/composition plan; local delivery has no crop mode.

## GPT Image 2.6: GIF, SVG and markup

This Standalone configuration example declares both `gpt-image-2.6-sunburst` and `gpt-image-2.6-flare`. Use the exact model IDs your service makes available. Add the required provider and profiles to this installed skill's `auth.json`; preserve unrelated profiles. Standalone uses API Key authentication only.

```json
{
  "config_version": 2,
  "active_profile": "openai/flare",
  "providers": {
    "openai": {
      "protocol": "openai-compatible",
      "base_url": "https://api.openai.com/v1",
      "api_key_env": "OPENAI_API_KEY"
    }
  },
  "models": {
    "openai/sunburst": {
      "provider": "openai",
      "model": "gpt-image-2.6-sunburst",
      "capabilities": {
        "generate": true,
        "edit": true,
        "mask": true,
        "markup": true,
        "multi_reference": true
      },
      "defaults": {
        "size": "auto",
        "quality": "medium",
        "output_format": "png"
      },
      "parameters": {
        "complexity": "high"
      },
      "parameter_fields": {
        "complexity": {
          "title": "Complexity",
          "type": "string",
          "path": [
            "complexity"
          ],
          "enum": [
            "low",
            "medium",
            "high"
          ]
        }
      }
    },
    "openai/flare": {
      "provider": "openai",
      "model": "gpt-image-2.6-flare",
      "capabilities": {
        "generate": true,
        "edit": true,
        "mask": true,
        "markup": true,
        "multi_reference": true
      },
      "defaults": {
        "size": "auto",
        "quality": "medium",
        "output_format": "png"
      },
      "parameters": {
        "complexity": "high"
      },
      "parameter_fields": {
        "complexity": {
          "title": "Complexity",
          "type": "string",
          "path": [
            "complexity"
          ],
          "enum": [
            "low",
            "medium",
            "high"
          ]
        }
      }
    }
  }
}
```

`complexity` controls planning before rendering and is separate from `quality`. The supported values are `low`, `medium`, and `high`. Override it per request through `--parameters`.

- **GIF:** generation only. Request `format: "gif"`, `size: "auto"`, and optionally `parameters: {"frame_count": 9, "frame_duration_ms": 200}`. Local validation accepts 2–64 frames and durations of 20–2000 milliseconds. These client bounds do not establish service support: OpenAI’s guide and endpoint reference currently give different GIF limits, and the endpoint reference requires preview access. Confirm the selected service’s limits before choosing values. Explicit frame dimensions must be positive multiples of 16. The provider also enforces its frame-size and total-pixel limits.
- **SVG:** generation only, one image per provider request. Request `format: "svg"`; Standalone uses `--n 1`. Static SVG is saved as UTF-8 XML. Vector shapes, text, gradients, basic styles and local references are accepted. Scripts, external resources, embedded raster images, animation and unsupported elements are rejected.
- **SVG author model:** the official API requires `svg.model` when SVG model selection is enabled for the account; otherwise omit the `svg` object. The top-level image model creates the reference image, while `svg.model` authors the vector content. Confirm the supported author model before passing it in the nested `svg.model` field of `--parameters`. Optional `svg.reasoning.effort` is independent of image `complexity`. Do not guess or automatically select an author model after a missing-parameter error; consult the [API reference](https://developers.openai.com/api/reference/resources/images/methods/generate) and the specific provider error.
- **Original delivery:** both formats are preserved byte for byte, written to the requested output path with the matching `.gif` or `.svg` extension. Raster editing, resizing, grid splitting and transparency processing are unavailable for these originals. Neither format supports streaming, partial images, output compression or `prompt_rewriter`.
- **Markup:** with `capabilities.markup: true`, pass a separate transparent PNG through `--markup`. The first input image remains the clean parent; additional images remain references. Use `--mask` for a separate mask edit. A markup layer cannot be sent with a mask or `prompt_rewriter`; it must match the first input dimensions, contain transparent pixels, fit within 50 MB and have at most 16,777,216 pixels.

Standalone examples, after configuring the profile:

Windows PowerShell, from your image project directory outside the installation:

```powershell
$SkillDir = "C:/path/to/openai-compatible-imagegen"
python "$SkillDir/scripts/imagegen.py" generate --profile openai/flare --prompt "A lantern gently swaying in a seamless loop" --format gif --size auto --file output/lantern.gif
python "$SkillDir/scripts/imagegen.py" generate --profile openai/sunburst --prompt "A simple vector leaf logo" --format svg --n 1 --file output/leaf.svg
python "$SkillDir/scripts/imagegen.py" edit --profile openai/flare --prompt "Recolor the circled vase blue and remove the annotation" --image kitchen.png --markup markup.png --file output/kitchen-blue.png
```

macOS or Linux shell, from your image project directory outside the installation:

```bash
SkillDir="/absolute/path/to/openai-compatible-imagegen"
python3 "$SkillDir/scripts/imagegen.py" generate --profile openai/flare --prompt "A lantern gently swaying in a seamless loop" --format gif --size auto --file output/lantern.gif
python3 "$SkillDir/scripts/imagegen.py" generate --profile openai/sunburst --prompt "A simple vector leaf logo" --format svg --n 1 --file output/leaf.svg
python3 "$SkillDir/scripts/imagegen.py" edit --profile openai/flare --prompt "Recolor the circled vase blue and remove the annotation" --image kitchen.png --markup markup.png --file output/kitchen-blue.png
```

The SVG example assumes the service does not require explicit author selection. Otherwise configure `parameters.svg.model` in the selected profile first. The edit example requires your existing `kitchen.png` and matching transparent `markup.png`.

Use `--parameters` for JSON animation and complexity overrides. `--markup` requires an explicit `capabilities.markup: true` declaration. Model access and format availability depend on the configured service. See the [official Image API guide](https://developers.openai.com/api/docs/guides/image-generation).
