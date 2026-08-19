import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";


const [, , stateRoot, bindingHash, pauseAt] = process.argv;
if (!new Set(["committed-list", "epoch-directory"]).has(pauseAt)) {
  throw new Error("pauseAt must select a supported read race window");
}
const committedRoot = path.join(
  stateRoot,
  "project-bindings",
  bindingHash,
  "binding.json.epochs",
  "committed",
);
const originalReaddir = fs.promises.readdir.bind(fs.promises);
let paused = false;

fs.promises.readdir = async (directory, options) => {
  if (
    !paused
    && pauseAt === "epoch-directory"
    && samePath(path.dirname(path.resolve(directory)), committedRoot)
  ) {
    await pauseReader();
  }
  const entries = await originalReaddir(directory, options);
  if (!paused && pauseAt === "committed-list" && samePath(directory, committedRoot)) {
    await pauseReader();
  }
  return entries;
};
syncBuiltinESMExports();

const { createProjectBindingStore } = await import("../../mcp/project-binding-store.mjs");
try {
  await createProjectBindingStore({ stateRoot }).require(bindingHash);
  process.stdout.write(`${JSON.stringify({ status: "ok" })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: error?.code ?? "unexpected_error" })}\n`);
}


async function pauseReader() {
  paused = true;
  process.stdout.write("ready\n");
  await new Promise((resolve) => process.stdin.once("data", resolve));
}


function samePath(left, right) {
  const normalizedLeft = path.resolve(left).replaceAll("\\", "/");
  const normalizedRight = path.resolve(right).replaceAll("\\", "/");
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
