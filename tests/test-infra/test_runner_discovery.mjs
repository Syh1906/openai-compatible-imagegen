import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertTestLayout,
  buildCheckCommand,
  buildPythonTestCommand,
  buildTestExecution,
  listTestFiles,
} from "../../scripts/run-tests.mjs";


test("test discovery is recursive, sorted, and ignores support files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-test-discovery-"));
  try {
    await Promise.all([
      mkdir(path.join(root, "nested"), { recursive: true }),
      mkdir(path.join(root, "support"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(root, "test_z.mjs"), "", "utf8"),
      writeFile(path.join(root, "nested", "test_a.py"), "", "utf8"),
      writeFile(path.join(root, "nested", "helper.mjs"), "", "utf8"),
      writeFile(path.join(root, "support", "test_fixture.mjs"), "", "utf8"),
    ]);

    assert.deepEqual(await listTestFiles(root), [
      path.join(root, "nested", "test_a.py"),
      path.join(root, "test_z.mjs"),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("test layout rejects executable tests outside an owning suite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-test-layout-"));
  try {
    await mkdir(path.join(root, "tests"), { recursive: true });
    await writeFile(path.join(root, "tests", "test_accidental.py"), "raise AssertionError('must run')\n", "utf8");

    await assert.rejects(
      () => assertTestLayout(root),
      /test file must belong to an owning suite.*tests\/test_accidental\.py/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("execution planning groups selected suites by runtime without duplicates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-test-execution-"));
  try {
    const directories = {
      alpha: path.join(root, "tests", "alpha"),
      beta: path.join(root, "tests", "beta"),
    };
    await Promise.all(Object.values(directories).map((directory) => mkdir(directory, { recursive: true })));
    await Promise.all([
      writeFile(path.join(directories.alpha, "test_alpha.py"), "", "utf8"),
      writeFile(path.join(directories.beta, "test_beta.mjs"), "", "utf8"),
    ]);
    const manifest = {
      suites: {
        alpha: { directory: "tests/alpha", runtimes: ["python"] },
        beta: { directory: "tests/beta", runtimes: ["node"] },
      },
    };

    assert.deepEqual(
      await buildTestExecution({ suites: ["alpha", "beta"] }, manifest, { projectRoot: root }),
      {
        node: [path.join(directories.beta, "test_beta.mjs")],
        python: [path.join(directories.alpha, "test_alpha.py")],
        requirements: [],
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("execution planning reports suite runtime requirements outside test files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-test-requirements-"));
  try {
    const directory = path.join(root, "tests", "bridge");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "test_bridge.mjs"), "", "utf8");

    const execution = await buildTestExecution(
      { suites: ["bridge"] },
      { suites: { bridge: { directory: "tests/bridge", runtimes: ["node"], requires: ["python"] } } },
      { projectRoot: root },
    );

    assert.deepEqual(execution.requirements, ["python"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("execution planning rejects runtime mismatches and empty declared runtimes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-test-execution-invalid-"));
  try {
    const directory = path.join(root, "tests", "alpha");
    await mkdir(directory, { recursive: true });
    await mkdir(path.join(root, "tests", "beta"), { recursive: true });
    await writeFile(path.join(directory, "test_alpha.py"), "", "utf8");

    await assert.rejects(
      () => buildTestExecution(
        { suites: ["alpha"] },
        { suites: { alpha: { directory: "tests/alpha", runtimes: ["node"] } } },
        { projectRoot: root },
      ),
      /runtime mismatch.*test_alpha\.py/,
    );

    await assert.rejects(
      () => buildTestExecution(
        { suites: ["beta"] },
        { suites: { beta: { directory: "tests/beta", runtimes: ["python"] } } },
        { projectRoot: root },
      ),
      /suite beta declares python runtime but no matching tests were found/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("selected checks map to executable project commands", () => {
  assert.deepEqual(buildCheckCommand("build"), ["npm", ["run", "build"]]);
  assert.deepEqual(buildCheckCommand("plugin"), ["npm", ["run", "check"]]);
  assert.deepEqual(buildCheckCommand("compile-python", { python: "py" }), ["py", ["-m", "compileall", "-q", "scripts"]]);
  assert.deepEqual(buildCheckCommand("diff"), ["git", ["diff", "--check"]]);
});


test("python execution runs the explicit nested test files selected by discovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-python-execution-"));
  try {
    const nestedTest = path.join(root, "tests", "alpha", "nested", "test_nested.py");
    await mkdir(path.dirname(nestedTest), { recursive: true });
    await writeFile(nestedTest, [
      "import unittest",
      "",
      "class NestedTests(unittest.TestCase):",
      "    def test_selected(self):",
      "        self.assertTrue(True)",
      "",
    ].join("\n"), "utf8");

    const command = buildPythonTestCommand([nestedTest], { projectRoot: root });
    const result = spawnSync(command[0], command[1], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
