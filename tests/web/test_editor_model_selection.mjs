import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { initialModelSelection, modelSelectionStatus, renderModelSelector } from "../../web/editor-model-selection.mjs";

const models = [
  { id: "one", model: "same", displayName: "第一个", aliases: ["alpha"], provider: "p", isDefault: true, effectiveCapabilities: { edit: true }, selectionFingerprint: "1".repeat(64) },
  { id: "two", model: "same", displayName: "第二个", aliases: ["beta"], provider: "q", effectiveCapabilities: { edit: true }, selectionFingerprint: "2".repeat(64) },
];

test("catalog loading, failure and empty states never expose an empty search menu", () => {
  const dom = new JSDOM('<main><div data-model-selector></div></main>');
  const root = dom.window.document.querySelector("main");
  let retries = 0;
  for (const catalogStatus of ["loading", "error", "empty", "unconfigured"]) {
    renderModelSelector(root, { models: [], catalogStatus, selection: { authMode: "apikey" }, onRetry: () => { retries += 1; }, onChange() {} });
    assert.equal(root.querySelector('input[type="search"]'), null);
    assert.ok(root.querySelector("[data-model-catalog-state]").textContent.trim());
    assert.equal(root.querySelector("[data-model-catalog-state]").dataset.modelCatalogState, catalogStatus);
    if (catalogStatus === "error") root.querySelector("[data-model-retry]").click();
  }
  assert.equal(retries, 1);
});

test("all configured choices are present before search and ArrowUp starts at the last choice", () => {
  const dom = new JSDOM('<main><div data-model-selector></div></main>');
  const root = dom.window.document.querySelector("main");
  const configured = [...models, { ...models[0], id: "three", displayName: "第三个", isDefault: false }];
  renderModelSelector(root, { models: configured, selection: { authMode: "apikey", modelProfileId: "one" }, onChange() {} });
  root.querySelector("summary").click();
  assert.equal([...root.querySelectorAll("[data-profile]")].filter((node) => !node.hidden).length, 3);
  const search = root.querySelector('input[type="search"]');
  search.focus();
  search.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  assert.equal(dom.window.document.activeElement.dataset.profile, "three");
});
test("parameter enum suggestions allow future values and preserve configured native paths", () => {
  const dom = new JSDOM('<main><div data-model-selector></div></main>');
  const root = dom.window.document.querySelector("main");
  const configured = [{ ...models[0], parameterFields: { style: { type: "string", path: ["generationConfig", "style"], enum: ["soft", "sharp"] } } }];
  let selection;
  renderModelSelector(root, { models: configured, selection: { authMode: "apikey", modelProfileId: "one" }, onChange: (value) => { selection = value; } });
  assert.deepEqual([...root.querySelectorAll("datalist option")].map((item) => item.value), ["soft", "sharp"]);
  const input = root.querySelector(".model-parameter input");
  input.value = "future";
  input.dispatchEvent(new dom.window.Event("change"));
  assert.equal(selection.parameters.generationConfig.style, "future");
});
test("changing a parameter keeps the parameter panel open and restores its focus", () => {
  const dom = new JSDOM('<main><div data-model-selector></div></main>');
  const root = dom.window.document.querySelector("main");
  const configured = [{ ...models[0], parameterFields: { seed: { type: "integer", path: ["seed"] } } }];
  const render = (selection) => renderModelSelector(root, { models: configured, selection, onChange: render });
  render({ authMode: "apikey", modelProfileId: "one" });
  root.querySelector(".model-parameters").open = true;
  const input = root.querySelector(".model-parameter input");
  input.focus(); input.value = "7"; input.dispatchEvent(new dom.window.Event("change"));
  assert.equal(root.querySelector(".model-parameters").open, true);
  assert.equal(dom.window.document.activeElement, root.querySelector(".model-parameter input"));
});
test("selection restores exact provenance and preserves missing draft choices", () => {
  const saved = { authMode: "apikey", modelProfileId: "removed" };
  assert.equal(initialModelSelection(saved, {}, models, "apikey"), saved);
  assert.equal(modelSelectionStatus(saved, models).blocked, true);
  assert.equal(initialModelSelection(null, { parameters: { modelProfileId: "two", selectionFingerprint: "2".repeat(64) } }, models, "apikey").modelProfileId, "two");
  assert.equal(initialModelSelection(null, { model: "same" }, models, "apikey").modelProfileId, "one");
});
test("searchable selector switches only the local edit and closes with focus restored", () => {
  const dom = new JSDOM('<main><div data-model-selector></div></main>');
  let selected;
  const root = dom.window.document.querySelector("main");
  renderModelSelector(root, { models, selection: { authMode: "apikey", modelProfileId: "one" }, onChange: (value) => { selected = value; } });
  root.querySelector("summary").click();
  const search = root.querySelector('input[type="search"]');
  search.value = "beta";
  search.dispatchEvent(new dom.window.Event("input"));
  const visible = [...root.querySelectorAll("[data-profile]")].filter((node) => !node.hidden);
  assert.equal(visible.length, 1);
  visible[0].click();
  assert.equal(selected.modelProfileId, "two");
  assert.equal(root.querySelector("details").open, false);
  assert.equal(dom.window.document.activeElement, root.querySelector("summary"));
});
