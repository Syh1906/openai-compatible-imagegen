# Prompting Guide

Use this guide when a request needs prompt construction or a batch with controlled variation. Include only details that support the user's intended result.

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

For transparent output, describe an isolated subject and alpha-friendly edges only when transparency is requested. Do not use those constraints for scenes, posters, backgrounds, or layouts.

## Cross-Industry Examples

- Product: "Studio photograph of a reusable stainless-steel bottle, three-quarter view, neutral gray background, realistic shadow, room for price text on the right, no embedded text."
- Editorial: "Wide editorial illustration about urban heat resilience, rooftops and shaded streets, restrained palette, clear foreground and background, no labels."
- Marketing: "Vertical launch poster for a community workshop, energetic paper-cut style, clear top area for a headline, no generated lettering."
- Interface: "Desktop analytics dashboard reference, dense but readable tables and charts, light neutral theme, realistic application layout."
- Game: "Square fantasy strategy game ability icon, a cracked ice sigil with a distinct silhouette, high contrast at small display sizes, no text."
- Transparent subject: "Isolated ceramic vase, front three-quarter view, clean alpha-friendly edges, no floor or backdrop, no lettering."

## Batch Variation

State the invariant and the variable for each batch. For example:

```text
Keep the product, camera height, crop, and background color consistent. Vary only the lighting direction and supporting props across four images.
```

Do not rely on similarity metrics to judge semantic correctness. Use them only to find results that are unexpectedly repetitive or unexpectedly different.
