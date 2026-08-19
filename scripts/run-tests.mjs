import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { selectImpactPlan } from "./test-impact.mjs";


const projectRoot = fileURLToPath(new URL("..", import.meta.url));


export async function listTestFiles(directory) {
  const result = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "support" || entry.name === "__pycache__") continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && /^test_.*\.(mjs|py)$/.test(entry.name)) {
        result.push(entryPath);
      }
    }
  }
  await visit(directory);
  return result.sort();
}


export async function assertTestLayout(root = projectRoot) {
  const testsRoot = path.join(root, "tests");
  const entries = await readdir(testsRoot, { withFileTypes: true });
  const misplaced = entries
    .filter((entry) => entry.isFile() && /^test_.*\.(mjs|py)$/.test(entry.name))
    .map((entry) => `tests/${entry.name}`)
    .sort();
  if (misplaced.length > 0) {
    throw new Error(`test file must belong to an owning suite: ${misplaced.join(", ")}`);
  }
}


export async function buildTestExecution(plan, manifest, { projectRoot: root = projectRoot } = {}) {
  await assertTestLayout(root);
  const execution = { node: [], python: [], requirements: [] };
  const requirements = new Set();
  for (const suiteName of plan.suites) {
    const suite = manifest.suites[suiteName];
    if (!suite) throw new Error(`unknown test suite: ${suiteName}`);
    for (const requirement of suite.requires ?? []) requirements.add(requirement);
    const files = await listTestFiles(path.join(root, suite.directory));
    const allowedExtensions = new Set(suite.runtimes.map((runtime) => runtime === "node" ? ".mjs" : ".py"));
    for (const file of files) {
      const extension = path.extname(file);
      if (!allowedExtensions.has(extension)) {
        throw new Error(`runtime mismatch in suite ${suiteName}: ${file}`);
      }
    }
    for (const runtime of suite.runtimes) {
      const matching = files.filter((file) => file.endsWith(runtime === "node" ? ".mjs" : ".py"));
      if (matching.length === 0) {
        throw new Error(`suite ${suiteName} declares ${runtime} runtime but no matching tests were found`);
      }
      execution[runtime].push(...matching);
    }
  }
  execution.node = [...new Set(execution.node)].sort();
  execution.python = [...new Set(execution.python)].sort();
  execution.requirements = [...requirements].sort();
  return execution;
}


export async function prepareSelectedTests({ mode = "smart", changedFiles = [], manifestPath = path.join(projectRoot, "scripts", "test-impact.json"), explicitSuites = null } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const plan = explicitSuites
    ? {
        mode: "explicit",
        changedFiles: [],
        suites: [...new Set(explicitSuites)].sort(),
        checks: [],
        platforms: ["linux"],
        reasons: [],
      }
    : selectImpactPlan(changedFiles, manifest, { mode });
  for (const suite of plan.suites) {
    if (!manifest.suites[suite]) throw new Error(`unknown test suite: ${suite}`);
  }
  const execution = await buildTestExecution(plan, manifest);
  return { manifest, plan, execution };
}


export async function runSelectedTests(options = {}) {
  const { plan, execution } = await prepareSelectedTests(options);
  console.log(JSON.stringify({ ...plan, execution }, null, 2));
  if (options.dryRun) return 0;
  if (execution.python.length > 0) {
    const command = buildPythonTestCommand(execution.python);
    const result = spawnSync(command[0], command[1], { cwd: projectRoot, stdio: "inherit" });
    if (result.status !== 0) return result.status ?? 1;
  }
  if (execution.node.length > 0) {
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...execution.node], { cwd: projectRoot, stdio: "inherit" });
    if (result.status !== 0) return result.status ?? 1;
  }
  for (const check of plan.checks) {
    const command = buildCheckCommand(check);
    const result = spawnSync(command[0], command[1], { cwd: projectRoot, stdio: "inherit", shell: process.platform === "win32" && command[0] === "npm" });
    if (result.status !== 0) {
      console.error(`test check failed: ${check} (status=${result.status ?? "signal"})`);
      if (result.error) console.error(result.error.message);
      return result.status ?? 1;
    }
  }
  return 0;
}


export function buildPythonTestCommand(files, { projectRoot: root = projectRoot, python = process.env.PYTHON ?? "python" } = {}) {
  const relativeFiles = files.map((file) => path.relative(root, file).split(path.sep).join("/"));
  return [python, ["-m", "unittest", ...relativeFiles]];
}


export function buildCheckCommand(check, { python = process.env.PYTHON ?? "python", npm = "npm" } = {}) {
  switch (check) {
    case "build": return [npm, ["run", "build"]];
    case "plugin": return [npm, ["run", "check"]];
    case "compile-python": return [python, ["-m", "compileall", "-q", "scripts"]];
    case "diff": return ["git", ["diff", "--check"]];
    default: throw new Error(`unsupported test check: ${check}`);
  }
}


const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const mode = process.argv.includes("--release") ? "release" : "smart";
  const changedFiles = process.argv.slice(2).filter((value) => value !== "--release");
  process.exitCode = await runSelectedTests({ mode, changedFiles });
}
