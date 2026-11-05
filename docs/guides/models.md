# Providers and model selection

> Parent: [User guides](./README.md)

English | [简体中文](./models.zh-CN.md)

These controls apply only to API Key requests. ChatGPT continues to use Codex's built-in image capability and does not consume API provider endpoints, model profiles, or native parameter fields.

## Configuration

With `config_version: 2`, `providers` hold connections and credentials; `models` hold exact provider model IDs, display names, aliases, capabilities, and image defaults. The Plugin uses its user configuration; Standalone can use the same structure in its own `auth.json`. Existing v1 and flat Standalone configurations remain readable and are never upgraded automatically.

The example below selects the Plugin API Key route. Standalone shares the providers, models, and defaults structure, but omits Plugin-only `auth_mode`, `canvas_submission_mode`, and `host_defaults`; it uses APIs only, without ChatGPT subscription handoff. To default the Plugin to built-in generation, set `auth_mode` to `chatgpt`; API profiles can remain configured for explicit selection.

```json
{
  "config_version": 2,
  "auth_mode": "apikey",
  "active_profile": "studio/image",
  "providers": {
    "studio": {
      "display_name": "Studio service",
      "protocol": "openai-compatible",
      "base_url": "https://images.example.com/v1",
      "api_key_env": "STUDIO_IMAGE_KEY"
    },
    "google": {
      "display_name": "Google",
      "protocol": "gemini-generate-content",
      "base_url": "https://generativelanguage.googleapis.com/v1beta",
      "api_key_env": "GOOGLE_IMAGE_KEY"
    }
  },
  "models": {
    "studio/image": {
      "provider": "studio",
      "model": "gpt-image-2",
      "display_name": "Studio image",
      "aliases": ["studio"],
      "capabilities": { "generate": true, "edit": true, "mask": true, "multi_reference": true },
      "defaults": { "size": "1024x1024", "quality": "medium", "output_format": "png" }
    },
    "google/image": {
      "provider": "google",
      "model": "gemini-3.1-flash-image",
      "display_name": "Google image",
      "aliases": ["google image"],
      "capabilities": { "generate": true, "edit": true, "mask": false, "multi_reference": true },
      "defaults": { "aspect_ratio": "1:1", "resolution": "1K" }
    }
  },
  "defaults": { "timeout_seconds": 600, "concurrency": 3 }
}
```

Replace the example service address and model ID with supported values. Stable profile IDs, exact model IDs, display names, and aliases are independent. The same actual model can have separate profiles for different providers, even when their addresses currently match. Adding a provider or model using an existing protocol requires configuration only; a new wire protocol requires its own adapter.

| Protocol | Transport | Path appended to the base URL |
| --- | --- | --- |
| `openai-compatible` | JSON generation, multipart editing | `images/generations`, `images/edits` |
| `atlas` | Asynchronous generation and bounded polling; no editing | `api/v1/model/generateImage`, then the Atlas result path |
| `xai-images` | JSON generation and editing; data URI inputs | `images/generations`, `images/edits` |
| `gemini-interactions` | Synchronous Interactions with `store=false` | `interactions` |
| `gemini-generate-content` | Independent generateContent request and response format | `models/{model}:generateContent` |

Protocol selection is explicit, never inferred from a model name or domain. Gemini uses `x-goog-api-key`; the other listed protocols use Bearer authentication. The Gemini protocols never fall back to each other.

Optional provider `endpoints.generate` and `endpoints.edit` specify complete URLs. `{model}` is replaced with the URL-encoded exact model ID. Otherwise the standard path is appended to `base_url`; `/v1` is not inserted automatically. An Atlas generation override changes submission only; polling still uses its configured base URL.

## Defaults and native fields

V2 API transparency policy belongs to `models[profileId].transparency`. Top-level `transparency` controls Plugin host-image and independent local-delivery operations, not API profiles; top-level `postprocess.enabled` still controls permission for local transparency processing. Only OpenAI-compatible transports `native-alpha`; Atlas, xAI, and Gemini do not support that dedicated parameter here. See [transparency settings](./configuration.md#transparency-settings).

In v2, top-level `defaults` contains execution settings only. Image defaults belong to each model; `host_defaults` stores host and local output preferences. xAI accepts common aspect ratio, resolution, and quality fields; Interactions accepts aspect ratio, resolution, and format; generateContent accepts aspect ratio and resolution. Use local delivery for exact pixel sizing of supported PNG sources. Local delivery does not transcode JPEG or WebP.

Single calls accept `size`, `aspectRatio`, `resolution`, `quality`, and `format`, where supported by the protocol. Standalone exposes corresponding CLI options. Do not specify `size` and aspect ratio/resolution at the same priority. A higher-priority dimension representation replaces the other lower-priority representation. V2 does not maintain a model-name or future quality/aspect/resolution value whitelist. Providers decide which values they support. V1 and Atlas retain their existing quality validation; OpenAI-compatible generation also accepts GIF and static SVG, with the restrictions below.

Put native JSON extensions in model `parameters`. Per-call `parameters` override matching configured fields; nested objects merge recursively. They cannot replace request identity, prompt, image inputs, count, authentication, or routing. Resolved common request fields take precedence. Never put credentials in parameters.

Declare optional canvas controls with `parameter_fields`, for example in a generateContent profile:

```json
{
  "parameter_fields": {
    "seed": {
      "title": "Seed",
      "type": "integer",
      "path": ["generationConfig", "seed"],
      "minimum": 0,
      "default": 7
    }
  }
}
```

Supported types are `string`, `integer`, `number`, `boolean`, `object`, and `array`. Non-overlapping `path` values identify native JSON fields. `default`, `enum`, `minimum`, and `maximum` describe values and controls. Enum declarations are hints, not a whitelist against future service values. Declaring a field does not prove provider support.

`capabilities` describes the profile's intended operations; `limits.max_input_images` can bound the total parent and reference images. Implemented protocol capabilities still apply: Atlas cannot edit, and xAI/Gemini have no dedicated mask transport here. Semantic region annotations remain usable without promising strict pixel boundaries.

## Output size limits

Generation `size` is the canvas requested from the API. Local `deliverySize` is the final PNG canvas; it can differ from the generation size. Reference-image dimensions do not establish a supported API size.

For OpenAI-compatible and Atlas profiles, v1 and v2 accept an optional `limits.output_size` declaration. Add it to the selected entry under `models`; flat Standalone configuration uses top-level `limits`. For example:

```json
{
  "limits": {
    "output_size": { "multiple_of": 16, "max_aspect_ratio": 3 }
  }
}
```

The new API configuration template and GPT Image 2 examples include these two constraints, based on the [OpenAI generation](https://developers.openai.com/api/reference/resources/images/methods/generate) and [editing](https://developers.openai.com/api/reference/resources/images/methods/edit) contracts. Confirm the selected provider's requirements before copying them to another model or channel; this declaration does not cover every service restriction.

| Field | Meaning |
| --- | --- |
| `allowed_sizes` | Non-empty list of exact `WIDTHxHEIGHT` strings; orientation matters |
| `multiple_of` | Both dimensions must be multiples of this positive integer |
| `max_aspect_ratio` | Maximum long-edge/short-edge ratio, a finite number of at least 1; `3` permits 1:3 through 3:1 |
| `min_edge`, `max_edge` | Inclusive bounds on each edge, in pixels |
| `min_pixels`, `max_pixels` | Inclusive bounds on width times height |

All declared constraints apply together. Edge, pixel, and multiple values are positive integers; minimum bounds cannot exceed maximum bounds, and allowed sizes must satisfy any accompanying constraints. These declarations apply to pixel `size` requests, not native xAI/Gemini aspect/resolution fields or ChatGPT host generation. Project configuration cannot override model limits.

`list_image_models` and Standalone `list-models` return the configured limits; flat Standalone `info` also shows them. Omitted or empty limits mean unknown, not unlimited. A configured default is not proof that the service supports it. Existing configuration files remain unchanged and readable. To enable checks for an existing model, add verified limits to its user configuration (or Standalone `auth.json`); rebind the Plugin project afterward. Never automatically copy limits between models.

When `update_image_config` changes a profile's `model`, it removes the previous model's limits unless the update supplies replacement `limits`. Supplied limits replace the old declaration in full. When editing the file manually, remove the old limits or replace them with verified limits for the new model. Legacy Standalone `size="auto"` remains service-selected; pixel limits cannot validate dimensions that have not been specified.

After defaults and explicit options are resolved, violations stop before an image request is sent, without changing size, retrying, or switching providers. For example, `3072x704` has a long/short ratio of about 4.36:1 and fails a declared maximum of 3. The Plugin job item reports `image_size_unsupported` with the failing size, constraint, and limit. Unrelated batch items can continue. Passing local validation confirms only the declared constraints; the provider still validates its current requirements.

For final dimensions outside the supported generation shape, choose a supported canvas and plan local delivery separately. Explicit `fit: "contain"` preserves proportions with padding; the default `stretch` changes proportions when shapes differ. Full-bleed output without distortion requires a crop or composition plan; local delivery has no crop mode. Original images remain immutable.

## Choosing a model

Name a configured model or alias in chat. `list_image_models` returns all configured profiles, provider labels, aliases, effective capabilities, defaults, and field declarations without generation or online probing. Matching uses exact profile ID, unique alias, then unique actual model ID. Multiple channels for the same model require an explicit choice.

In the canvas, choose API Key to load configured models. Open the picker to see every option, the current choice, and the default model, or search names, aliases, model/profile IDs, or providers. Models unavailable for the current edit show a reason. Failed reads and empty catalogs show a message with a Reload action. If a search has no matches, change or clear the query.

Selection and parameters apply only to this edit and never change `active_profile`. Drafts retain them, but selection alone cannot submit an empty edit. ChatGPT hides the API controls while preserving the local API choice.

Verified source profile and fingerprint metadata can restore a source choice. Imported or older images are not routed by guessing from a model string. Deleted or changed profile configurations require reselection. The server binds the route, model, and parameters to the prepared submission; an old submission cannot silently switch models.

Standalone supports `imagegen.py list-models`, `--profile` for a profile or unique alias, and `--parameters '{"seed":7}'` for native overrides. JSONL rows accept independent `modelProfileId` and `parameters` values.

See [migration](./migration.md) for explicit upgrades and [image jobs](./image-jobs.md) for polling, immutable originals, and complete final delivery.

## GPT Image 2.6: GIF, SVG and markup

This API configuration example declares both `gpt-image-2.6-sunburst` and `gpt-image-2.6-flare`. Use the exact model IDs your service makes available. Add these providers and profiles to your API configuration; do not replace unrelated profiles. For the Plugin, retain your existing `auth_mode` and other Plugin settings. Standalone uses this structure in its own `auth.json`. Configuration does not change the model used by the ChatGPT built-in route.

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

`complexity` controls planning before rendering and is separate from `quality`. The supported values are `low`, `medium`, and `high`. Override it per request through `parameters` or the canvas control.

- **GIF:** generation only. Request `format: "gif"`, `size: "auto"`, and optionally `parameters: {"frame_count": 9, "frame_duration_ms": 200}`. Local validation accepts 2–64 frames and durations of 20–2000 milliseconds. These client bounds do not establish service support: OpenAI’s guide and endpoint reference currently give different GIF limits, and the endpoint reference requires preview access. Confirm the selected service’s limits before choosing values. Explicit frame dimensions must be positive multiples of 16. The provider also enforces its frame-size and total-pixel limits.
- **SVG:** generation only, one image per provider request. Request `format: "svg"`; Standalone uses `--n 1`. Static SVG is saved as UTF-8 XML. Vector shapes, text, gradients, basic styles and local references are accepted. Scripts, external resources, embedded raster images, animation and unsupported elements are rejected.
- **SVG author model:** the official API requires `svg.model` when SVG model selection is enabled for the account; otherwise omit the `svg` object. The top-level image model creates the reference image, while `svg.model` authors the vector content. After confirming a supported author model, pass it through `parameters.svg.model`, or the same nested field in Standalone `--parameters`. Optional `svg.reasoning.effort` is independent of image `complexity`. If the service reports a missing `svg.model`, confirm an available SVG author model with the provider before submitting a new request. See the [API reference](https://developers.openai.com/api/reference/resources/images/methods/generate) and the specific provider error.
- **Original delivery:** both formats are preserved byte for byte, previewed in result cards and exported with the matching `.gif` or `.svg` extension. Raster editing, resizing, grid splitting and transparency processing are unavailable for these originals. Neither format supports streaming, partial images, output compression or `prompt_rewriter`.
- **Markup:** with `capabilities.markup: true`, the API canvas sends ordinary annotations as a separate transparent PNG. The first input image remains the clean parent; additional images remain references. Mask annotations continue to use the existing mask flow. A markup layer cannot be sent with a mask or `prompt_rewriter`; it must match the first input dimensions, contain transparent pixels, fit within 50 MB and have at most 16,777,216 pixels.

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

Use `--parameters` for JSON animation and complexity overrides. The Plugin passes the same fields through its `parameters` object. Existing profiles without `markup` keep their previous semantic annotation behavior. Model access and format availability depend on the configured service. See the [official Image API guide](https://developers.openai.com/api/docs/guides/image-generation).
