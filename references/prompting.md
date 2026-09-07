# Prompting Guide

Use this shared guide with either the Standalone Skill or Codex Plugin when a request needs prompt construction or a batch with controlled variation. Include only details that support the user's intended result.

## Request Structure

Build prompts from these fields:

| Field | Questions to resolve |
| --- | --- |
| Purpose | Where will the image be used: product page, article, campaign, presentation, interface, game, or print? |
| Subject | What must appear, how many subjects exist, and which relationships matter? |
| Composition | What viewpoint, crop, placement, depth, or empty space is required? |
| Style | Is the result photographic, illustrated, three-dimensional, diagrammatic, or mixed media? |
| Context | Who is the audience and what visual environment or brand context applies? |
| Delivery | What size, aspect ratio, format, background, transparency, and file count are required? |
| Constraints | What text, colors, objects, or failure patterns must be included or excluded? |
| Fidelity | Is this free generation, a loose reference, a local edit, or a structure-preserving edit? |
| Variation | In a batch, what stays consistent and what changes between results? |

Do not invent an industry, audience, brand, platform, or composition that the user did not provide. Ask only when a missing choice materially changes the result; otherwise make a conservative choice and report it.

## Prompt Pattern

```text
[Purpose and subject]. [Composition and relationships]. [Style, material, lighting, and color].
[Delivery context and target dimensions]. [Required text or no-text rule]. [Concrete exclusions].
```

For transparent output, describe an isolated subject and clean subject edges only when transparency is requested. Do not add transparency constraints to scenes, posters, backgrounds, or layouts.

## Transparency Prompts

Let the runtime add the wording for its selected transparency route:

Construct the base prompt from user-visible semantics first. Represent transparency with the delivery controls, not by manually adding transparent-background wording, a real-alpha contract, `alpha 0`, a checkerboard, a key-color background, a pure-black emissive background, or mask alignment. `resolve_plan` owns route selection and appends one verified route contract after considering subject wording and reference-image colors. Without an exact prompt-only allow rule, `inspect-alpha` sends the semantic base prompt unchanged. Preserve any colors the user explicitly requires on the subject.

- `chroma-matting`: the runtime appends one uniform flat key-color background, no gradient, texture, shadow, glow, floor, or key color on the subject. The local processor needs a solid canvas edge to distinguish background from subject.
- `emissive-alpha`: the runtime appends a uniform pure-black background contract for particles, fire, lightning, smoke, or glow. It keeps the canvas edge black and preserves soft light falloff.
- `mask-alpha`: the runtime appends alignment to the supplied mask and prohibits content outside its bounds. This route requires an explicit mask.
- `native-alpha`: the runtime adds a real-alpha prompt contract and sends the native transparency parameter when the configured protocol supports it and native transparency is enabled.
- `prompt-alpha`: the runtime adds the real-alpha prompt contract only for an exact `transparency.prompt_only_allow` rule, without sending the native parameter. Do not append these instructions manually.

Prompt-only wording increases the chance of alpha output; it does not guarantee it. If the returned image is opaque, the skill returns that API image unchanged and reports `transparency.status=unmet`. Do not describe the result as transparent merely because the prompt contained alpha instructions.

An exact prompt-only rule is not required for `native-alpha`. For other routes, do not downgrade a 2K or 4K request to 1K or change models to match a rule. Use the configured local route when processing is allowed; otherwise keep the prompt unchanged and inspect the original's alpha. A prompt-only rule must match the exact pixel size, mode, and model. Failed transparency checks preserve the API original.

When `transparency.llm_assisted.enabled=true`, prompt changes remain bounded by the policy. The Standalone adapter may send an additional image API request only when `allow_api_retry=true`, keeping the configured model, endpoint, and requested size. The Plugin permits only local adjustment through that policy. Both adapters separately support the configured native-parameter retry described in [parameters](parameters.md#visual-deliverables-and-transparency). If the attempt limit is reached, return the original image and factual warnings.

## Cross-Industry Examples

- Product: "Studio photograph of a reusable stainless-steel bottle, three-quarter view, neutral gray background, realistic shadow, room for price text on the right, no embedded text."
- Editorial: "Wide editorial illustration about urban heat resilience, rooftops and shaded streets, restrained palette, clear foreground and background, no labels."
- Marketing: "Vertical launch poster for a community workshop, energetic paper-cut style, clear top area for a headline, no generated lettering."
- Interface: "Desktop analytics dashboard reference, dense but readable tables and charts, light neutral theme, realistic application layout."
- Game: "Square fantasy strategy game ability icon, a cracked ice sigil with a distinct silhouette, high contrast at small display sizes, no text."
- Transparent with local processing, base prompt: "Isolated ceramic vase, front three-quarter view, preserve the complete silhouette and clean edge, no floor, shadow, glow, texture, or lettering." The runtime selects and appends the key-color contract.
- Transparent emissive effect, base prompt: "Isolated cyan lightning burst with branching particles, preserve soft glow falloff, no scenery, frame, or text." The runtime appends the pure-black contract.
- Transparent with mask, base prompt: "Isolated cosmetic bottle, preserve the full product and its clean outline, no cast shadow or glow." The runtime appends the supplied-mask contract.
- Transparent with native or verified prompt-only alpha, base prompt: "Isolated ceramic vase, front three-quarter view, preserve the complete silhouette and clean edges, no floor, shadow, glow, or lettering." The runtime appends the selected alpha contract.

## Batch Variation

State the invariant and the variable for each batch. For example:

```text
Keep the product, camera height, crop, and background color consistent. Vary only the lighting direction and supporting props across four images.
```

Do not rely on similarity metrics to judge semantic correctness. Use them only to find results that are unexpectedly repetitive or unexpectedly different.
