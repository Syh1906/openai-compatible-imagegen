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

Single calls accept `size`, `aspectRatio`, `resolution`, `quality`, and `format`, where supported by the protocol. Standalone exposes corresponding CLI options. Do not specify `size` and aspect ratio/resolution at the same priority. A higher-priority dimension representation replaces the other lower-priority representation. V2 does not maintain a model-name or future quality/aspect/resolution value whitelist. Providers decide which values they support. V1 and Atlas retain their existing quality validation; saved formats remain PNG, JPEG, or WebP.

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

## Choosing a model

Name a configured model or alias in chat. `list_image_models` returns all configured profiles, provider labels, aliases, effective capabilities, defaults, and field declarations without generation or online probing. Matching uses exact profile ID, unique alias, then unique actual model ID. Multiple channels for the same model require an explicit choice.

In the canvas, choose API Key to load configured models. Open the picker to see every option, the current choice, and the default model, or search names, aliases, model/profile IDs, or providers. Models unavailable for the current edit show a reason. Failed reads and empty catalogs show a message with a Reload action. If a search has no matches, change or clear the query.

Selection and parameters apply only to this edit and never change `active_profile`. Drafts retain them, but selection alone cannot submit an empty edit. ChatGPT hides the API controls while preserving the local API choice.

Verified source profile and fingerprint metadata can restore a source choice. Imported or older images are not routed by guessing from a model string. Deleted or changed profile configurations require reselection. The server binds the route, model, and parameters to the prepared submission; an old submission cannot silently switch models.

Standalone supports `imagegen.py list-models`, `--profile` for a profile or unique alias, and `--parameters '{"seed":7}'` for native overrides. JSONL rows accept independent `modelProfileId` and `parameters` values.

See [migration](./migration.md) for explicit upgrades and [image jobs](./image-jobs.md) for polling, immutable originals, and complete final delivery.
