import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import {
  IMAGE_ID,
  PROJECT_BINDING_ID,
  installDomGlobals,
  installHost,
  restoreDomGlobals,
  waitFor,
} from "../support/widget-runtime-host.mjs";

test("focused canvas reveals its image in the folder", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor" });

  try {
    await import(`../../web/editor-runtime.mjs?editor-reveal=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const revealButton = document.querySelector('button[aria-label="在文件夹中显示"]');
    assert.equal(revealButton?.disabled, false);
    assert.ok(revealButton, "聚焦画布必须提供在文件夹中显示按钮");
    revealButton.click();
    assert.equal(revealButton.disabled, true);
    assert.equal(revealButton.getAttribute("aria-busy"), "true");
    await waitFor(() => host.toolCalls.some(({ name }) => name === "reveal_image_artifact"));
    await waitFor(() => revealButton.disabled === false);
    assert.equal(document.querySelector("[data-toast]")?.textContent, "");
    assert.deepEqual(
      host.toolCalls.find(({ name }) => name === "reveal_image_artifact").arguments,
      { imageId: IMAGE_ID, projectBindingId: PROJECT_BINDING_ID },
    );
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});

test("focused canvas reveal ignores duplicate clicks and recovers after a failed request", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><main><p>正在加载图片...</p></main></body></html>',
    { pretendToBeVisual: true, url: "https://widget.local/" },
  );
  const previous = installDomGlobals(dom.window);
  const host = installHost(dom.window, { toolName: "open_image_editor", revealArtifactIsError: true });

  try {
    await import(`../../web/editor-runtime.mjs?editor-reveal-error=${Date.now()}`);
    await waitFor(() => document.querySelector("[data-image]")?.hidden === false);
    const revealButton = document.querySelector('[data-action="reveal-image"]');
    assert.ok(revealButton);
    revealButton.click();
    revealButton.click();
    await waitFor(() => host.toolCalls.filter(({ name }) => name === "reveal_image_artifact").length === 1);
    await waitFor(() => document.querySelector("[data-action=reveal-image]")?.disabled === false);
    assert.equal(document.querySelector("[data-toast]")?.textContent, "无法在文件夹中显示图片");
  } finally {
    host.dispose();
    restoreDomGlobals(previous);
    dom.window.close();
  }
});
