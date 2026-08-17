import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import {
  installDomGlobals,
  installHost,
  restoreDomGlobals,
  waitFor,
} from "./support/widget-runtime-host.mjs";


test("widget applies host theme variables on startup and live theme changes", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, {
    toolName: "render_image_results",
    initialHostContext: {
      theme: "dark",
      styles: {
        variables: {
          "--color-background-primary": "#241d2b",
          "--color-text-primary": "#f8ecff",
          "--color-border-primary": "#6d557d",
        },
      },
    },
  });

  try {
    await import(`../web/editor-runtime.mjs?host-theme=${Date.now()}`);
    await waitFor(() => document.documentElement.dataset.theme === "dark");

    assert.equal(document.documentElement.style.colorScheme, "dark");
    assert.equal(document.documentElement.style.getPropertyValue("--color-background-primary"), "#241d2b");
    assert.equal(document.documentElement.style.getPropertyValue("--color-text-primary"), "#f8ecff");
    assert.equal(document.documentElement.style.getPropertyValue("--color-border-primary"), "#6d557d");

    const result = document.querySelector(".inline-result");
    host.notifyHostContextChanged({
      theme: "light",
      styles: {
        variables: {
          "--color-background-primary": "#fff7ed",
          "--color-text-primary": "#422006",
          "--color-border-primary": "#fdba74",
        },
      },
    });
    await waitFor(() => document.documentElement.dataset.theme === "light");

    assert.equal(document.documentElement.style.colorScheme, "light");
    assert.equal(document.documentElement.style.getPropertyValue("--color-background-primary"), "#fff7ed");
    assert.equal(document.documentElement.style.getPropertyValue("--color-text-primary"), "#422006");
    assert.equal(document.documentElement.style.getPropertyValue("--color-border-primary"), "#fdba74");
    assert.equal(document.querySelector(".inline-result"), result);
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});


test("widget styles consume standardized host tokens before their local baselines", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");

  assert.match(html, /--bg:\s*var\(--color-background-secondary,\s*#f4f5f7\)/);
  assert.match(html, /--surface:\s*var\(--color-background-primary,\s*#ffffff\)/);
  assert.match(html, /--surface-muted:\s*var\(--color-background-secondary,\s*#f8f9fa\)/);
  assert.match(html, /--line:\s*var\(--color-border-primary,\s*#dedfe3\)/);
  assert.match(html, /--text:\s*var\(--color-text-primary,\s*#17191d\)/);
  assert.match(html, /--muted:\s*var\(--color-text-secondary,\s*#6c7078\)/);
  assert.match(html, /--focus:\s*var\(--color-ring-primary,\s*#2563eb\)/);
  assert.match(html, /--action-bg:\s*var\(--color-background-inverse,\s*#0c7959\)/);
  assert.match(html, /--action-text:\s*var\(--color-text-inverse,\s*#ffffff\)/);
  assert.doesNotMatch(html, /color-scheme:\s*light;/);
});
