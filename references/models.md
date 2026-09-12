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
