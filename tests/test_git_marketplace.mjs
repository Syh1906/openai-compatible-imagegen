import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { pluginReleaseFiles } from "../scripts/plugin-file-set.mjs";


const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginId = "openai-compatible-imagegen";


test("the repository is a Git-backed marketplace with a runnable root plugin", async () => {
  const marketplace = JSON.parse(await readFile(
    path.join(projectRoot, ".agents/plugins/marketplace.json"),
    "utf8",
  ));

  assert.equal(marketplace.name, pluginId);
  assert.equal(marketplace.interface?.displayName, "OpenAI-Compatible Images");
  assert.equal(marketplace.plugins?.length, 1);
  assert.deepEqual(marketplace.plugins[0], {
    name: pluginId,
    source: {
      source: "url",
      url: "https://github.com/Syh1906/openai-compatible-imagegen.git",
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  });

  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--", ...pluginReleaseFiles],
    { cwd: projectRoot, encoding: "utf8" },
  );
  assert.deepEqual(
    stdout.trim().split(/\r?\n/).filter(Boolean).sort(),
    [...pluginReleaseFiles].sort(),
  );
});
