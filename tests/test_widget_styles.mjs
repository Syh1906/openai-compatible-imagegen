import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


test("shallow editor viewports keep the canvas and primary controls inside the fixed layout", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const shallowViewport = html.match(/@media \(max-height: 640px\) \{(?<rules>[\s\S]*?)\n      \}/)?.groups?.rules || "";

  assert.match(shallowViewport, /\.editor-app \{[^}]*grid-template-rows:/);
  assert.match(shallowViewport, /\.canvas-frame \{[^}]*min-height: 0/);
  assert.match(shallowViewport, /\.tool-rail \{[^}]*overflow-y: auto/);
  assert.match(shallowViewport, /\.version-item \{[^}]*grid-template-rows:/);
  assert.doesNotMatch(shallowViewport, /\.stroke-button, \.swatch, \.custom-color \{[^}]*width:/);
});

test("interactive controls use restrained motion with a reduced-motion override", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");

  assert.match(html, /\.text-icon, \.return-button,[^{]+\{[^}]*transition:[^}]*140ms/);
  assert.match(html, /button:active:not\(:disabled\) \{[^}]*translateY\(1px\)/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)[^{]+\{[^}]*transition-duration: 0\.01ms/);
  assert.match(html, /\.canvas-content:focus-visible \{[^}]*outline: 2px solid var\(--focus\)/);
});

test("color editor uses a viewport-clamped overlay isolated from canvas layout", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");

  assert.match(html, /\.color-editor-overlay \{[^}]*position: fixed;[^}]*inset: 0;[^}]*pointer-events: none;[^}]*contain: layout style/);
  assert.match(html, /\.color-editor-overlay\[data-open="true"\] \{[^}]*pointer-events: auto/);
  assert.match(html, /\.editor-app\[data-color-editor-open="true"\] \.tool-rail \{[^}]*z-index: 21/);
  assert.match(html, /\.custom-color-panel \{[^}]*position: absolute;[^}]*max-height: calc\(100vh - 16px\)[^}]*pointer-events: auto/);
  assert.match(html, /\.custom-color-panel-body \{[^}]*overflow-y: auto/);
  assert.match(html, /\.custom-color-panel-actions \{[^}]*border-top:/);
  assert.match(html, /@media \(max-width: 900px\) \{[\s\S]*?\.tool-rail \{[^}]*z-index: 5/);
  assert.doesNotMatch(html, /\.custom-color-panel \{[^}]*top: 62px;[^}]*left: 60px/);
  assert.doesNotMatch(html, /\.custom-color-panel \{[^}]*top: 58px/);
});

test("mask mode reliably hides standard color and stroke controls", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");

  assert.match(html, /\.rail-style-controls\[hidden\] \{[^}]*display: none/);
});

test("compact result previews keep reveal errors inside the toolbar layout", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const compactViewport = html.match(/@media \(max-width: 520px\) \{(?<rules>[\s\S]*?)\n      \}/)?.groups?.rules || "";

  assert.match(compactViewport, /\.result-preview-status \{[^}]*grid-area: status/);
  assert.doesNotMatch(compactViewport, /\.result-preview-status,[^{]+\{[^}]*display: none/);
});

test("multiple mixed-aspect results stay compact and independently scannable", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const compactViewport = html.match(/@media \(max-width: 520px\) \{(?<rules>[\s\S]*?)\n      \}/)?.groups?.rules || "";

  assert.match(html, /\.inline-results\.multiple \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 220px\), 1fr\)\);[^}]*grid-auto-rows: max-content;[^}]*align-items: start;[^}]*align-content: start/);
  assert.match(html, /\.inline-results\.multiple \.inline-result \{[^}]*grid-template-columns: 1fr;[^}]*grid-template-rows: auto auto;[^}]*align-self: start/);
  assert.match(html, /\.inline-results\.multiple \.inline-preview \{[^}]*aspect-ratio: 16 \/ 10/);
  assert.match(html, /\.inline-results\.multiple \.inline-preview-trigger \{[^}]*position: absolute;[^}]*inset: 0/);
  assert.match(html, /\.inline-results\.multiple \.source-image \{[^}]*display: block;[^}]*width: 100%;[^}]*height: 100%;[^}]*object-fit: contain/);
  assert.match(html, /\.inline-results\.multiple \.inline-details \{[^}]*align-self: start/);
  assert.doesNotMatch(html, /\.inline-results\.multiple \{[^}]*grid-auto-rows: minmax\([^)]*1fr/);
  assert.match(compactViewport, /\.inline-results\.multiple \{[^}]*grid-template-columns: 1fr/);
  assert.match(compactViewport, /\.inline-results\.multiple \.inline-result \{[^}]*grid-template-columns: minmax\(104px, 36%\) minmax\(0, 1fr\);[^}]*grid-template-rows: auto/);
  assert.match(compactViewport, /\.inline-results\.multiple \.inline-preview \{[^}]*height: 180px;[^}]*aspect-ratio: auto/);
});

test("compact editors keep toolbar actions and every mask control reachable", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const compactViewport = html.match(/@media \(max-width: 520px\) \{(?<rules>[\s\S]*?)\n      \}/)?.groups?.rules || "";

  assert.match(compactViewport, /\.return-button \{[^}]*width: 32px/);
  assert.match(compactViewport, /\.return-button span \{[^}]*display: none/);
  assert.doesNotMatch(compactViewport, /\.top-actions \{[^}]*overflow-x: auto/);
  assert.match(compactViewport, /\.canvas-options \{[^}]*display: grid;[^}]*grid-template-areas:/);
  assert.match(compactViewport, /\.mask-actions \{[^}]*grid-area: actions/);
  assert.match(compactViewport, /\.mask-modes \{[^}]*grid-area: modes/);
  assert.match(compactViewport, /\.brush-sizes \{[^}]*grid-area: brushes/);
});

test("compact icon-only action labels stay in the accessibility tree", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const compactViewport = html.match(/@media \(max-width: 520px\) \{(?<rules>[\s\S]*?)\n      \}/)?.groups?.rules || "";

  assert.match(compactViewport, /\.intent-panel-toggle span, \.destroy-button span \{[^}]*position: absolute/);
  assert.match(compactViewport, /\.intent-panel-toggle span, \.destroy-button span \{[^}]*clip: rect\(0, 0, 0, 0\)/);
  assert.doesNotMatch(compactViewport, /\.intent-panel-toggle span, \.destroy-button span \{[^}]*display: none/);
  assert.doesNotMatch(compactViewport, /\.close-guidance(?:,|\s*\{)[^}]*display: none/);
});

test("close guidance stays focusable and reveals its explanation without relying on title", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");

  assert.match(html, /\.close-guidance:focus-visible \{[^}]*outline: 2px solid var\(--focus\)/);
  assert.match(html, /\.close-guidance-wrap\[data-open="true"\] \.close-guidance-tooltip/);
  assert.doesNotMatch(html, /\.close-guidance-wrap:hover \.close-guidance-tooltip/);
  assert.match(html, /\.close-guidance-tooltip \{[^}]*position: absolute;[^}]*visibility: hidden/);
});

test("primary actions use the host inverse surface and text tokens", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");

  for (const selector of [".open-editor-button", ".color-apply-button", ".submit-button"]) {
    const rule = cssRule(html, selector);
    assert.match(rule, /background:\s*var\(--action-bg\)/);
    assert.match(rule, /color:\s*var\(--action-text\)/);
  }
});

test("result context menu preserves a visible keyboard focus ring", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const rule = cssRule(html, ".result-context-menu button:focus-visible");

  assert.match(rule, /outline:\s*2px solid var\(--focus\)/);
  assert.doesNotMatch(rule, /outline:\s*none/);
});

function cssRule(html, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))?.groups?.body || "";
}
