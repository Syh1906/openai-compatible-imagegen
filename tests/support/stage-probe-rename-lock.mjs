import { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

// Simulate Windows refusing to rename a directory used by a completed probe.
const probedRoots = new Set();
const originalSpawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function (options) {
  const args = options.args ?? [];
  if (args.some((arg) => path.basename(arg) === "probe-plugin.mjs")) {
    const index = args.indexOf("--plugin-root");
    if (index >= 0) probedRoots.add(path.resolve(args[index + 1]));
  }
  return originalSpawn.call(this, options);
};

const originalRename = fs.rename;
fs.rename = async (source, destination) => {
  if (probedRoots.has(path.resolve(source))) {
    throw Object.assign(new Error("EPERM: cannot rename a probed directory"), { code: "EPERM" });
  }
  return await originalRename(source, destination);
};
syncBuiltinESMExports();
