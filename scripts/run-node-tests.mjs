import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";


const projectRoot = fileURLToPath(new URL("..", import.meta.url));


export async function listNodeTestFiles(testsDirectory) {
  const entries = await readdir(testsDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^test_.*\.mjs$/.test(entry.name))
    .map((entry) => path.join(testsDirectory, entry.name))
    .sort();
}


export async function runNodeTests() {
  const testFiles = await listNodeTestFiles(path.join(projectRoot, "tests"));
  if (testFiles.length === 0) {
    throw new Error("no Node test files were found");
  }
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=1", ...testFiles],
    { cwd: projectRoot, stdio: "inherit" },
  );
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}


const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  process.exitCode = await runNodeTests();
}
