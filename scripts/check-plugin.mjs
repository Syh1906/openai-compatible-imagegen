import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const probePath = fileURLToPath(new URL("./probe-plugin.mjs", import.meta.url));
const projectRoot = mkdtempSync(path.join(os.tmpdir(), "imagegen-check-"));
let result;

try {
  result = spawnSync(
    process.execPath,
    [probePath, "--project-root", projectRoot],
    {
      encoding: "utf8",
      stdio: "pipe",
    },
  );
} finally {
  rmSync(projectRoot, { recursive: true });
}

if (result.status !== 0) {
  process.stderr.write(result.stderr || "plugin probe failed\n");
  process.exitCode = result.status ?? 1;
} else {
  process.stdout.write(result.stdout);
}
