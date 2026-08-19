import assert from "node:assert/strict";
import test from "node:test";

import {
  selectPythonCommand,
  verifyPythonRuntime,
} from "../mcp/python-runtime.mjs";


test("Python command selection uses one explicit platform mapping", () => {
  assert.equal(selectPythonCommand({ platform: "win32", environment: {} }), "python");
  assert.equal(selectPythonCommand({ platform: "darwin", environment: {} }), "python3");
  assert.equal(selectPythonCommand({ platform: "linux", environment: {} }), "python3");
  assert.throws(
    () => selectPythonCommand({ platform: "freebsd", environment: {} }),
    /unsupported platform/i,
  );
});


test("Python command selection honors one configured executable without fallback", () => {
  const environment = { OPENAI_COMPATIBLE_IMAGEGEN_PYTHON: "/opt/python/3.12/bin/python3" };
  assert.equal(
    selectPythonCommand({ platform: "darwin", environment }),
    "/opt/python/3.12/bin/python3",
  );
  assert.throws(
    () => selectPythonCommand({
      platform: "darwin",
      environment: { OPENAI_COMPATIBLE_IMAGEGEN_PYTHON: "   " },
    }),
    /override is invalid/i,
  );
});


test("Python runtime preflight requires Python 3.12 or newer", async () => {
  const calls = [];
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: "Python 3.12.10\n", stderr: "" };
  };

  assert.equal(
    await verifyPythonRuntime("python3", { runCommand }),
    "python3",
  );
  assert.deepEqual(calls, [{
    command: "python3",
    args: ["--version"],
    options: { encoding: "utf8", timeout: 10_000, windowsHide: true },
  }]);

  assert.equal(
    await verifyPythonRuntime("python3", {
      runCommand: async () => ({ stdout: "Python 3.13.0\n", stderr: "" }),
    }),
    "python3",
  );

  for (const version of ["Python 3.11.9", "not Python"]) {
    await assert.rejects(
      verifyPythonRuntime("python3", {
        runCommand: async () => ({ stdout: "", stderr: `${version}\n` }),
      }),
      /Python 3\.12 or newer is required/i,
    );
  }
});
