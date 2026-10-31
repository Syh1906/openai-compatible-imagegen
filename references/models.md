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
