import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const probePath = fileURLToPath(new URL("./probe-plugin.mjs", import.meta.url));
const result = spawnSync(process.execPath, [probePath], {
  encoding: "utf8",
  stdio: "pipe",
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || "plugin probe failed\n");
  process.exitCode = result.status ?? 1;
} else {
  process.stdout.write(result.stdout);
}
