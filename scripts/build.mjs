import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const pluginManifest = JSON.parse(await readFile(fileURLToPath(new URL("../.codex-plugin/plugin.json", import.meta.url)), "utf8"));
const packageManifest = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
const packageLock = JSON.parse(await readFile(fileURLToPath(new URL("../package-lock.json", import.meta.url)), "utf8"));
if (
  packageManifest.name !== pluginManifest.name
  || packageManifest.version !== pluginManifest.version
  || packageLock.name !== pluginManifest.name
  || packageLock.version !== pluginManifest.version
  || packageLock.packages?.[""]?.name !== pluginManifest.name
  || packageLock.packages?.[""]?.version !== pluginManifest.version
) {
  throw new Error("plugin manifest, package.json, and package-lock.json identity must match");
}
const paths = {
  serverSource: fileURLToPath(new URL("../mcp/server.mjs", import.meta.url)),
  serverOutput: fileURLToPath(new URL("../dist/server.mjs", import.meta.url)),
  widgetSource: fileURLToPath(new URL("../web/index.html", import.meta.url)),
  widgetOutput: fileURLToPath(new URL("../dist/widget/index.html", import.meta.url)),
  runtimeOutput: fileURLToPath(new URL("../dist/scripts", import.meta.url)),
};

await rm(fileURLToPath(new URL("../dist/scripts/__pycache__", import.meta.url)), { recursive: true, force: true });
await mkdir(fileURLToPath(new URL("../dist/widget", import.meta.url)), { recursive: true });
await mkdir(paths.runtimeOutput, { recursive: true });
await build({
  entryPoints: [paths.serverSource],
  outfile: paths.serverOutput,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  sourcemap: false,
  define: { __PLUGIN_VERSION__: JSON.stringify(pluginManifest.version) },
});
const widgetHtml = await readFile(paths.widgetSource, "utf8");
const widgetBundle = await build({
  entryPoints: [fileURLToPath(new URL("../web/editor-runtime.mjs", import.meta.url))],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  write: false,
  minify: true,
});
const widgetScript = new TextDecoder().decode(widgetBundle.outputFiles[0].contents);
await writeFile(
  paths.widgetOutput,
  widgetHtml.replace("    <!-- WIDGET_SCRIPT -->", () => `    <script>${widgetScript}</script>`),
);

const runtimeFiles = ["imagegen.py", "artifact_repository.py", "image_download.py", "provider_config.py"];
await Promise.all(runtimeFiles.map((name) => copyFile(
  fileURLToPath(new URL(`./${name}`, import.meta.url)),
  fileURLToPath(new URL(`../dist/scripts/${name}`, import.meta.url)),
)));

process.stdout.write(`${JSON.stringify({
  ok: true,
  root,
  outputs: [paths.serverOutput, paths.widgetOutput, ...runtimeFiles.map((name) => fileURLToPath(new URL(`../dist/scripts/${name}`, import.meta.url)))],
})}\n`);
