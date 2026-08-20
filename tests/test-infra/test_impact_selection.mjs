import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  selectImpactPlan,
  validateImpactManifest,
} from "../../scripts/test-impact.mjs";


const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const projectManifest = JSON.parse(readFileSync(new URL("../../scripts/test-impact.json", import.meta.url), "utf8"));


const manifest = {
  version: 1,
  suites: {
    shared: { directory: "tests/shared", runtimes: ["python"] },
    standalone: { directory: "tests/standalone", runtimes: ["python"] },
    "plugin-runtime": { directory: "tests/plugin-runtime", runtimes: ["python"] },
    mcp: { directory: "tests/mcp", runtimes: ["node"] },
    web: { directory: "tests/web", runtimes: ["node"] },
    release: { directory: "tests/release", runtimes: ["node", "python"] },
    "test-infra": { directory: "tests/test-infra", runtimes: ["node"] },
  },
  rules: [
    {
      name: "release-build",
      files: ["scripts/build.mjs"],
      suites: ["release"],
      checks: ["build", "plugin"],
    },
    {
      name: "shared-runtime",
      prefixes: ["scripts/"],
      suites: ["shared", "standalone", "plugin-runtime", "mcp"],
    },
    {
      name: "widget",
      prefixes: ["web/"],
      suites: ["web"],
      checks: ["build", "plugin"],
    },
    {
      name: "windows-adapter",
      files: ["scripts/windows_repository_fs.py"],
      suites: ["plugin-runtime"],
      platforms: ["windows"],
    },
    {
      name: "documentation",
      prefixes: ["docs/"],
      suites: [],
    },
    {
      name: "web-tests",
      prefixes: ["tests/web/"],
      suites: ["web"],
    },
  ],
};


test("manifest validation accepts ordered exact and prefix rules", () => {
  assert.doesNotThrow(() => validateImpactManifest(manifest));
});


test("a widget change selects only the web suite and plugin checks", () => {
  assert.deepEqual(selectImpactPlan(["web/editor-runtime.mjs"], manifest), {
    mode: "smart",
    changedFiles: ["web/editor-runtime.mjs"],
    suites: ["web"],
    checks: ["build", "plugin"],
    platforms: ["linux"],
    reasons: [{ file: "web/editor-runtime.mjs", rule: "widget" }],
  });
});


test("the first matching rule keeps release builders out of shared regression", () => {
  const plan = selectImpactPlan(["scripts/build.mjs"], manifest);

  assert.deepEqual(plan.suites, ["release"]);
  assert.deepEqual(plan.checks, ["build", "plugin"]);
  assert.deepEqual(plan.reasons, [{ file: "scripts/build.mjs", rule: "release-build" }]);
});


test("shared runtime changes cover both distribution adapters and the bridge", () => {
  assert.deepEqual(
    selectImpactPlan(["scripts/image_runtime.py"], manifest).suites,
    ["mcp", "plugin-runtime", "shared", "standalone"],
  );
});


test("release and plugin helper scripts select their owning checks", () => {
  const releasePlan = selectImpactPlan(["scripts/stage-personal-plugin.mjs"], projectManifest);
  assert.deepEqual(releasePlan.suites, ["release"]);
  assert.deepEqual(releasePlan.checks, ["plugin"]);

  const pluginPlan = selectImpactPlan(["scripts/check-plugin.mjs"], projectManifest);
  assert.deepEqual(pluginPlan.suites, ["release"]);
  assert.deepEqual(pluginPlan.checks, ["plugin"]);
});


test("shared runtime changes require distribution checks", () => {
  const plan = selectImpactPlan(["scripts/image_runtime.py"], projectManifest);
  assert.ok(plan.checks.includes("build"));
  assert.ok(plan.checks.includes("plugin"));
  assert.ok(plan.checks.includes("diff"));
});


test("package tooling changes cover product consumers and release checks", () => {
  const plan = selectImpactPlan(["package-lock.json"], projectManifest);
  assert.deepEqual(plan.suites, ["mcp", "release", "test-infra", "web"]);
  assert.deepEqual(plan.checks, ["build", "plugin"]);
});


test("cross-suite direct consumers are included in MCP impact plans", () => {
  assert.deepEqual(
    selectImpactPlan(["mcp/python-runtime.mjs"], projectManifest).suites,
    ["mcp", "test-infra"],
  );
  assert.deepEqual(
    selectImpactPlan(["mcp/create-server.mjs"], projectManifest).suites,
    ["mcp", "release", "web"],
  );
  assert.deepEqual(
    selectImpactPlan(["web/host-observation.mjs"], projectManifest).suites,
    ["mcp", "web"],
  );
});


test("native platform consumers select their required runners", () => {
  assert.ok(selectImpactPlan(["scripts/reveal_in_explorer.py"], projectManifest).platforms.includes("windows"));
  assert.ok(selectImpactPlan(["mcp/filesystem-path-safety.mjs"], projectManifest).platforms.includes("macos"));
  assert.ok(selectImpactPlan(["tests/plugin-runtime/test_windows_repository_fs.py"], projectManifest).platforms.includes("windows"));
});


test("platform-sensitive repositories select their native runners", () => {
  const cases = [
    ["scripts/artifact_repository.py", ["linux", "macos", "windows"]],
    ["mcp/project-context.mjs", ["linux", "windows"]],
    ["mcp/project-binding-store.mjs", ["linux", "windows"]],
    ["mcp/file-lock-ownership.mjs", ["linux", "windows"]],
  ];
  for (const [file, platforms] of cases) {
    assert.deepEqual(selectImpactPlan([file], projectManifest).platforms, platforms, file);
  }
});


test("locale-sensitive widget paths select all runners without widening other widget changes", () => {
  for (const file of ["web/editor-runtime.mjs", "tests/web/test_widget_i18n.mjs"]) {
    const plan = selectImpactPlan([file], projectManifest);
    assert.deepEqual(plan.suites, ["web"], file);
    assert.deepEqual(plan.platforms, ["linux", "macos", "windows"], file);
  }
  assert.deepEqual(selectImpactPlan(["web/result-preview.mjs"], projectManifest).platforms, ["linux"]);
  assert.deepEqual(selectImpactPlan(["tests/web/test_widget_theme.mjs"], projectManifest).platforms, ["linux"]);
});


test("platform-specific production rules retain their build gates", () => {
  const cases = [
    ["scripts/reveal_in_explorer.py", ["build", "diff", "plugin"]],
    ["scripts/windows_repository_fs.py", ["build", "diff", "plugin"]],
    ["scripts/posix_repository_fs.py", ["build", "diff", "plugin"]],
    ["scripts/repository_fs.py", ["build", "diff", "plugin"]],
    ["mcp/filesystem-path-safety.mjs", ["build", "plugin"]],
    ["mcp/python-runtime.mjs", ["build", "plugin"]],
  ];
  for (const [file, checks] of cases) {
    assert.deepEqual(selectImpactPlan([file], projectManifest).checks, checks, file);
  }
});


test("release-only consumers are included for distributed runtime and public docs", () => {
  for (const file of [
    "scripts/image_alpha.py",
    "mcp/image-runtime.mjs",
    "web/result-state.mjs",
    "README.md",
    "docs/guides/update.md",
    "CHANGELOG.md",
  ]) {
    assert.ok(selectImpactPlan([file], projectManifest).suites.includes("release"), file);
  }
  assert.deepEqual(selectImpactPlan(["AGENTS.md"], projectManifest).suites, []);
});


test("the root skill contract selects standalone and release consumers", () => {
  assert.deepEqual(selectImpactPlan(["SKILL.md"], projectManifest).suites, ["release", "standalone"]);
});


test("platform-specific rules add native runners without removing Linux", () => {
  assert.deepEqual(
    selectImpactPlan(["scripts/windows_repository_fs.py"], manifest).platforms,
    ["linux", "windows"],
  );
});


test("known documentation changes select no product tests", () => {
  const plan = selectImpactPlan(["docs/arch.md"], manifest);

  assert.deepEqual(plan.suites, []);
  assert.deepEqual(plan.checks, []);
});


test("a changed test selects its owning suite", () => {
  assert.deepEqual(selectImpactPlan(["tests/web/test_widget_runtime.mjs"], manifest).suites, ["web"]);
});


test("unknown paths fail closed instead of selecting the release suite", () => {
  assert.throws(
    () => selectImpactPlan(["new-runtime/entry.mjs"], manifest),
    /no test impact rule matches new-runtime\/entry\.mjs/,
  );
});


test("release mode selects every suite and supported platform", () => {
  const plan = selectImpactPlan([], manifest, { mode: "release" });

  assert.deepEqual(plan.suites, [
    "mcp",
    "plugin-runtime",
    "release",
    "shared",
    "standalone",
    "test-infra",
    "web",
  ]);
  assert.deepEqual(plan.checks, ["build", "compile-python", "diff", "plugin"]);
  assert.deepEqual(plan.platforms, ["linux", "macos", "windows"]);
});


test("every tracked repository path has an explicit impact classification", () => {
  const trackedFiles = execFileSync("git", ["ls-files"], { cwd: projectRoot, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);

  for (const file of trackedFiles) {
    assert.doesNotThrow(() => selectImpactPlan([file], projectManifest), file);
  }
});


test("the test infrastructure suite includes both test runtimes", () => {
  assert.deepEqual(projectManifest.suites["test-infra"].runtimes, ["node", "python"]);
});


test("the MCP suite declares its external Python runtime dependency", () => {
  assert.deepEqual(projectManifest.suites.mcp.requires, ["python"]);
});


test("support fixtures select only their actual consumer suites", () => {
  assert.deepEqual(
    selectImpactPlan(["tests/support/python_fixtures.py"], projectManifest).suites,
    ["plugin-runtime"],
  );
  assert.deepEqual(
    selectImpactPlan(["tests/support/widget-runtime-host.mjs"], projectManifest).suites,
    ["web"],
  );
  assert.deepEqual(
    selectImpactPlan(["tests/support/fixture-project-context.mjs"], projectManifest).suites,
    ["mcp", "web"],
  );
});


test("retired runner paths remain classified for the migration change", () => {
  assert.deepEqual(
    selectImpactPlan(["scripts/run-node-tests.mjs", "tests/test_node_test_runner.mjs"], projectManifest).suites,
    ["test-infra"],
  );
});
