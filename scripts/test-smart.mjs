import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { prepareSelectedTests, runSelectedTests } from "./run-tests.mjs";


const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const ZERO_SHA = "0000000000000000000000000000000000000000";


export function listChangedFiles({ base, head, cwd = projectRoot, env = process.env } = {}) {
  base ??= env.TEST_BASE_SHA;
  head ??= env.TEST_HEAD_SHA ?? env.GITHUB_SHA;
  if (!base && !head && env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    base = event.pull_request?.base?.sha || event.before;
    head = event.pull_request?.head?.sha || event.after;
  }
  if (env.GITHUB_ACTIONS === "true" && (!base || !head || head === ZERO_SHA)) {
    throw new Error("smart regression requires explicit head revision in CI");
  }
  if ((base && !head) || (!base && head)) {
    throw new Error("smart regression requires both base and head revisions");
  }

  const outputs = [];
  if (base && head) {
    const resolvedBase = base === ZERO_SHA ? resolveCiBase({ cwd, head }) : base;
    outputs.push(execFileSync("git", ["diff", "--no-renames", "--name-only", resolvedBase, head], { cwd, encoding: "utf8" }));
  } else {
    let localBase;
    try {
      localBase = execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (cause) {
      throw new Error(
        "cannot resolve smart regression base from origin/main; set TEST_BASE_SHA and TEST_HEAD_SHA explicitly",
        { cause },
      );
    }
    outputs.push(execFileSync("git", ["diff", "--no-renames", "--name-only", `${localBase}...HEAD`], { cwd, encoding: "utf8" }));
  }
  if (env.GITHUB_ACTIONS !== "true") {
    outputs.push(execFileSync("git", ["diff", "--no-renames", "--name-only", "HEAD"], { cwd, encoding: "utf8" }));
    outputs.push(execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, encoding: "utf8" }));
  }
  return [...new Set(outputs.join("\n").split(/\r?\n/).map((line) => line.trim()).filter(Boolean))].sort();
}


function resolveCiBase({ cwd, head }) {
  try {
    return execFileSync("git", ["merge-base", head, "origin/main"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (cause) {
    throw new Error("cannot resolve smart regression base for a new CI ref from origin/main", { cause });
  }
}


export function writeGitHubOutput({ plan, execution, outputPath }) {
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required with --github-output");
  const runnerNames = { linux: "ubuntu-latest", macos: "macos-latest", windows: "windows-latest" };
  appendFileSync(outputPath, [
    `matrix=${JSON.stringify(plan.platforms.map((platform) => runnerNames[platform]))}`,
    `has_tests=${plan.suites.length > 0}`,
    `has_node=${execution.node.length > 0}`,
    `has_python=${execution.python.length > 0 || execution.requirements?.includes("python") === true}`,
    `needs_build=${plan.checks.includes("build")}`,
    `needs_plugin_check=${plan.checks.includes("plugin")}`,
    "",
  ].join("\n"), "utf8");
}


const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const changedFiles = listChangedFiles();
  if (process.argv.includes("--github-output")) {
    const { plan, execution } = await prepareSelectedTests({ changedFiles });
    writeGitHubOutput({ plan, execution, outputPath: process.env.GITHUB_OUTPUT });
    console.log(JSON.stringify({ ...plan, execution }, null, 2));
    process.exitCode = 0;
  } else if (changedFiles.length === 0) {
    console.log("No changed files detected; smart regression is empty.");
    process.exitCode = 0;
  } else {
    process.exitCode = await runSelectedTests({ changedFiles, dryRun: process.argv.includes("--plan") });
  }
}
