import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runSelectedTests } from "./run-tests.mjs";


const projectRoot = fileURLToPath(new URL("..", import.meta.url));


const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const suites = process.argv.slice(2);
  if (suites.length === 0) throw new Error("usage: npm run test:suite -- <suite> [suite ...]");
  const manifestPath = path.join(projectRoot, "scripts", "test-impact.json");
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(manifestPath, "utf8"));
  process.exitCode = await runSelectedTests({ mode: "smart", changedFiles: [], manifestPath, explicitSuites: suites });
}
