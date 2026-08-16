import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { createReleaseBundle } from "../mcp/release-identity.mjs";
import { runtimeFileNames } from "./plugin-file-set.mjs";

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
  distributionOutput: fileURLToPath(new URL("../dist", import.meta.url)),
  mcpSourceDirectory: fileURLToPath(new URL("../mcp", import.meta.url)),
  serverSource: fileURLToPath(new URL("../mcp/server.mjs", import.meta.url)),
  serverOutput: fileURLToPath(new URL("../dist/server.mjs", import.meta.url)),
  widgetSource: fileURLToPath(new URL("../web/index.html", import.meta.url)),
  widgetOutput: fileURLToPath(new URL("../dist/widget/index.html", import.meta.url)),
  runtimeOutput: fileURLToPath(new URL("../dist/scripts", import.meta.url)),
};
await rm(paths.distributionOutput, { recursive: true, force: true });
await mkdir(fileURLToPath(new URL("../dist/widget", import.meta.url)), { recursive: true });
await mkdir(paths.runtimeOutput, { recursive: true });
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
const assembledWidgetHtml = widgetHtml.replace(
  "    <!-- WIDGET_SCRIPT -->",
  () => `    <script>${widgetScript}</script>`,
);
const mcpFiles = (await readdir(paths.mcpSourceDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
  .map((entry) => entry.name)
  .sort();
const serverBuildPaths = [
  ...mcpFiles.map((name) => ({ path: `mcp/${name}`, url: new URL(`../mcp/${name}`, import.meta.url) })),
  ...runtimeFileNames.map((name) => ({ path: `scripts/${name}`, url: new URL(`./${name}`, import.meta.url) })),
  { path: "scripts/build.mjs", url: new URL("./build.mjs", import.meta.url) },
  { path: "scripts/plugin-file-set.mjs", url: new URL("./plugin-file-set.mjs", import.meta.url) },
  { path: ".mcp.json", url: new URL("../.mcp.json", import.meta.url) },
  { path: "package-lock.json", url: new URL("../package-lock.json", import.meta.url) },
];
const { releaseIdentity, widgetHtml: releaseWidgetHtml } = createReleaseBundle({
  pluginId: pluginManifest.name,
  pluginVersion: pluginManifest.version,
  serverBuildInputs: await Promise.all(serverBuildPaths.map(async ({ path, url }) => ({
    path,
    content: await readFile(fileURLToPath(url)),
  }))),
  widgetHtml: assembledWidgetHtml,
});
await build({
  entryPoints: [paths.serverSource],
  outfile: paths.serverOutput,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  legalComments: "none",
  sourcemap: false,
  define: { __RELEASE_IDENTITY__: JSON.stringify(releaseIdentity) },
});
await writeFile(paths.widgetOutput, releaseWidgetHtml);

await Promise.all(runtimeFileNames.map((name) => copyFile(
  fileURLToPath(new URL(`./${name}`, import.meta.url)),
  fileURLToPath(new URL(`../dist/scripts/${name}`, import.meta.url)),
)));

process.stdout.write(`${JSON.stringify({
  ok: true,
  releaseIdentity,
  outputs: [
    "dist/server.mjs",
    "dist/widget/index.html",
    ...runtimeFileNames.map((name) => `dist/scripts/${name}`),
  ],
})}\n`);
