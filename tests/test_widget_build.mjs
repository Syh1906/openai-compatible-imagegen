import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const widgetOutput = fileURLToPath(new URL("../dist/widget/index.html", import.meta.url));
const resultStateSource = fileURLToPath(new URL("../web/result-state.mjs", import.meta.url));

test("widget build embeds the runtime without duplicating the HTML document", async () => {
  await execFileAsync(process.execPath, ["scripts/build.mjs"], { cwd: projectRoot });

  const html = await readFile(widgetOutput, "utf8");
  assert.equal(count(html, "<!doctype html>"), 1);
  assert.equal(count(html, '<body data-tool="open_image_editor">'), 1);
  assert.equal(html.includes("<!-- WIDGET_SCRIPT -->"), false);
  assert.equal(html.includes("read_image_artifact_data"), true);
  assert.equal(html.includes("imageArtifacts"), false);

  const imageLoader = await readFile(resultStateSource, "utf8");
  assert.equal(imageLoader.includes("readServerResource"), false);
  assert.equal(imageLoader.includes("resources/read"), false);
});

function count(value, needle) {
  return value.split(needle).length - 1;
}
