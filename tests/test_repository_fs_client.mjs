import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runRepositoryFsOperation } from "../mcp/repository-fs-client.mjs";


test("repository client sends one bounded request to the hidden Python helper", async () => {
  const launches = [];
  const runtimePath = path.resolve("scripts/repository_fs_helper.py");
  const request = {
    operation: "read-artifact",
    artifactRoot: path.resolve("output/imagegen"),
    imageId: "img_01J00000000000000000000000",
  };
  const result = await runRepositoryFsOperation(request, {
    runtimePath,
    pythonCommand: "python-test",
    spawnProcess(command, args, options) {
      const child = completedChild({ stdout: '{"ok":true,"result":{"value":1}}\n' });
      launches.push({ command, args, options, child });
      return child;
    },
  });

  assert.deepEqual(result, { value: 1 });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].command, "python-test");
  assert.deepEqual(launches[0].args, [runtimePath]);
  assert.equal(launches[0].options.windowsHide, true);
  assert.deepEqual(launches[0].options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(launches[0].child.stdinValue, JSON.stringify(request));
});


test("repository client rejects non-serializable requests before starting the helper", async (t) => {
  const cases = [
    {
      name: "circular reference",
      createRequest() {
        const request = { operation: "read-artifact" };
        request.self = request;
        return request;
      },
    },
    {
      name: "BigInt",
      createRequest() {
        return { operation: "read-artifact", imageId: 1n };
      },
    },
    {
      name: "throwing getter",
      createRequest() {
        return {
          operation: "read-artifact",
          get imageId() {
            throw new Error("C:/Users/private/output/index.json");
          },
        };
      },
    },
    {
      name: "non-string serialization result",
      createRequest() {
        return { operation: "read-artifact", toJSON: () => undefined };
      },
    },
  ];

  for (const { name, createRequest } of cases) {
    await t.test(name, async () => {
      let launches = 0;

      await assert.rejects(
        runRepositoryFsOperation(createRequest(), {
          runtimePath: path.resolve("scripts/repository_fs_helper.py"),
          spawnProcess() {
            launches += 1;
            return completedChild({ stdout: '{"ok":true,"result":{}}\n' });
          },
        }),
        { message: "repository operation is not serializable" },
      );
      assert.equal(launches, 0);
    });
  }
});


test("repository client serializes a valid request exactly once", async () => {
  let serializationCount = 0;
  const request = {
    operation: "read-artifact",
    toJSON() {
      serializationCount += 1;
      return { operation: this.operation };
    },
  };
  const child = completedChild({ stdout: '{"ok":true,"result":{}}\n' });

  await runRepositoryFsOperation(request, {
    runtimePath: path.resolve("scripts/repository_fs_helper.py"),
    spawnProcess() {
      return child;
    },
  });

  assert.equal(serializationCount, 1);
  assert.equal(child.stdinValue, '{"operation":"read-artifact"}');
});


test("repository client does not disclose helper paths in runtime errors", async () => {
  await assert.rejects(
    runRepositoryFsOperation(
      { operation: "read-artifact" },
      {
        runtimePath: path.resolve("scripts/repository_fs_helper.py"),
        spawnProcess() {
          return completedChild({
            stdout: '{"ok":false,"error":"failed at C:/Users/private/output/index.json"}\n',
          });
        },
      },
    ),
    (error) => {
      assert.equal(error.message.includes("C:/Users/private"), false);
      assert.match(error.message, /repository operation failed/i);
      return true;
    },
  );
});


test("repository client recognizes the standard English Windows missing-file error", async () => {
  await assert.rejects(
    runRepositoryFsOperation(
      { operation: "read-annotation" },
      {
        runtimePath: path.resolve("scripts/repository_fs_helper.py"),
        spawnProcess() {
          return completedChild({
            stdout: '{"ok":false,"error":"[WinError 2] The system cannot find the file specified"}\n',
          });
        },
      },
    ),
    /repository entry not found/i,
  );
});


test("repository client does not disclose UNC or extended Windows paths in validation errors", async (t) => {
  const cases = [
    {
      name: "UNC path",
      message: "invalid artifact root at \\\\private-server\\private-share\\output\\index.json",
      privateParts: ["private-server", "private-share"],
    },
    {
      name: "extended UNC path",
      message: "required artifact root at \\\\?\\UNC\\private-server\\private-share\\output\\index.json",
      privateParts: ["private-server", "private-share"],
    },
    {
      name: "extended drive path",
      message: "unsupported artifact root at \\\\?\\C:\\Users\\private-user\\output\\index.json",
      privateParts: ["private-user", "Users"],
    },
  ];

  for (const { name, message, privateParts } of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        runRepositoryFsOperation(
          { operation: "read-artifact" },
          {
            runtimePath: path.resolve("scripts/repository_fs_helper.py"),
            spawnProcess() {
              return completedChild({
                stdout: `${JSON.stringify({ ok: false, error: message })}\n`,
              });
            },
          },
        ),
        (error) => {
          assert.match(error.message, /invalid|required|unsupported/i);
          for (const privatePart of privateParts) {
            assert.equal(error.message.includes(privatePart), false);
          }
          assert.equal(error.message.includes("\\\\"), false);
          return true;
        },
      );
    });
  }
});


test("repository client rejects successful JSON when the helper exits nonzero", async () => {
  await assert.rejects(
    runRepositoryFsOperation(
      { operation: "read-artifact" },
      {
        runtimePath: path.resolve("scripts/repository_fs_helper.py"),
        spawnProcess() {
          return completedChild({
            stdout: '{"ok":true,"result":{"unsafe":true}}\n',
            exitCode: 1,
          });
        },
      },
    ),
    { message: "repository runtime failed" },
  );
});


test("repository client rejects successful JSON when the helper exits by signal", async () => {
  await assert.rejects(
    runRepositoryFsOperation(
      { operation: "read-artifact" },
      {
        runtimePath: path.resolve("scripts/repository_fs_helper.py"),
        spawnProcess() {
          return completedChild({
            stdout: '{"ok":true,"result":{"unsafe":true}}\n',
            exitCode: null,
            signal: "SIGTERM",
          });
        },
      },
    ),
    { message: "repository runtime failed" },
  );
});


test("repository client sanitizes synchronous helper startup failures", async () => {
  await assert.rejects(
    runRepositoryFsOperation(
      { operation: "read-artifact" },
      {
        runtimePath: path.resolve("scripts/repository_fs_helper.py"),
        spawnProcess() {
          throw new Error("spawn failed at C:/Users/private/repository_fs_helper.py");
        },
      },
    ),
    (error) => {
      assert.equal(error.message, "repository runtime could not start");
      assert.equal(error.message.includes("C:/Users/private"), false);
      return true;
    },
  );
});


test("repository client immediately terminates when stdout reaches the combined output limit", async () => {
  let lateChunkConversions = 0;
  const lateChunk = {
    toString() {
      lateChunkConversions += 1;
      return "late-output";
    },
  };
  const child = outputFloodChild({
    stdoutChunks: ["x".repeat(48 * 1024 * 1024), lateChunk],
  });

  await assert.rejects(
    runRepositoryFsOperation(
      { operation: "read-artifact" },
      {
        runtimePath: path.resolve("scripts/repository_fs_helper.py"),
        helperTimeoutMs: 100,
        helperTerminationGraceMs: 30,
        spawnProcess() {
          return child;
        },
      },
    ),
    { message: "repository runtime output exceeded the limit" },
  );
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(lateChunkConversions, 0);
});


test("repository client applies one combined output limit across stdout and stderr", async () => {
  const halfLimit = "x".repeat(24 * 1024 * 1024);
  const child = outputFloodChild({
    stdoutChunks: [halfLimit],
    stderrChunks: [halfLimit],
  });

  await assert.rejects(
    runRepositoryFsOperation(
      { operation: "read-artifact" },
      {
        runtimePath: path.resolve("scripts/repository_fs_helper.py"),
        helperTimeoutMs: 100,
        helperTerminationGraceMs: 30,
        spawnProcess() {
          return child;
        },
      },
    ),
    { message: "repository runtime output exceeded the limit" },
  );
  assert.deepEqual(child.kills, ["SIGTERM"]);
});


test("repository client counts multibyte UTF-8 bytes across both output streams", async () => {
  const child = outputFloodChild({
    stdoutChunks: [Buffer.from("\u754c".repeat(8 * 1024 * 1024))],
    stderrChunks: [Buffer.from("\u754c".repeat(8 * 1024 * 1024))],
  });

  await assert.rejects(
    runRepositoryFsOperation(
      { operation: "read-artifact" },
      {
        runtimePath: path.resolve("scripts/repository_fs_helper.py"),
        helperTimeoutMs: 100,
        helperTerminationGraceMs: 30,
        spawnProcess() {
          return child;
        },
      },
    ),
    { message: "repository runtime output exceeded the limit" },
  );
  assert.deepEqual(child.kills, ["SIGTERM"]);
});


test("repository client safely rejects invalid UTF-8 helper output", async () => {
  const stdout = Buffer.concat([
    Buffer.from('{"ok":true,"result":"'),
    Buffer.from([0xff]),
    Buffer.from('"}\n'),
  ]);
  await assert.rejects(
    runRepositoryFsOperation(
      { operation: "read-artifact" },
      {
        runtimePath: path.resolve("scripts/repository_fs_helper.py"),
        spawnProcess() {
          return completedChild({ stdout });
        },
      },
    ),
    { message: "repository runtime returned invalid output" },
  );
});


test("repository client terminates a stuck helper at its deadline", async () => {
  const child = hangingChild({ safetyCloseMs: 100 });

  await assert.rejects(
    runRepositoryFsOperation(
      { operation: "read-artifact" },
      {
        runtimePath: path.resolve("scripts/repository_fs_helper.py"),
        helperTimeoutMs: 5,
        helperTerminationGraceMs: 30,
        spawnProcess() {
          return child;
        },
      },
    ),
    (error) => {
      assert.equal(error.message, "repository runtime timed out");
      assert.equal(error.message.includes("C:/Users/private"), false);
      return true;
    },
  );
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(child.closed, true);
  child.dispose();
});


test("repository client escalates to SIGKILL when a stuck helper ignores SIGTERM", async () => {
  const child = hangingChild({ closeOnSignal: "SIGKILL", safetyCloseMs: 100 });

  await assert.rejects(
    runRepositoryFsOperation(
      { operation: "read-artifact" },
      {
        runtimePath: path.resolve("scripts/repository_fs_helper.py"),
        helperTimeoutMs: 5,
        helperTerminationGraceMs: 5,
        spawnProcess() {
          return child;
        },
      },
    ),
    /repository runtime timed out/i,
  );
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.closed, true);
  child.dispose();
});


test("repository client rejects when helper termination cannot be confirmed", async () => {
  const child = hangingChild({ closeOnSignal: null, killResult: false, safetyCloseMs: 100 });

  await assert.rejects(
    runRepositoryFsOperation(
      { operation: "read-artifact" },
      {
        runtimePath: path.resolve("scripts/repository_fs_helper.py"),
        helperTimeoutMs: 5,
        helperTerminationGraceMs: 5,
        spawnProcess() {
          return child;
        },
      },
    ),
    (error) => {
      assert.equal(error.message, "repository runtime timed out; helper termination was not confirmed");
      assert.equal(error.message.includes("C:/Users/private"), false);
      return true;
    },
  );
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.closed, false);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(child.unrefCount, 1);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.listenerCount("error"), 0);
  child.dispose();
});


test("repository client releases a terminated helper when exit arrives without close", async () => {
  const child = exitOnlyTerminationChild();

  await assert.rejects(
    runRepositoryFsOperation(
      { operation: "read-artifact" },
      {
        runtimePath: path.resolve("scripts/repository_fs_helper.py"),
        helperTimeoutMs: 5,
        helperTerminationGraceMs: 10,
        spawnProcess() {
          return child;
        },
      },
    ),
    { message: "repository runtime timed out" },
  );

  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(child.unrefCount, 1);
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0);
  assert.equal(child.stdin.listenerCount("finish"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(child.kills, ["SIGTERM"]);
});


test("repository client settles once when startup error and close race the deadline", async () => {
  const child = racingFailureChild();
  let rejectionCount = 0;

  await runRepositoryFsOperation(
    { operation: "read-artifact" },
    {
      runtimePath: path.resolve("scripts/repository_fs_helper.py"),
      helperTimeoutMs: 20,
      helperTerminationGraceMs: 5,
      spawnProcess() {
        return child;
      },
    },
  ).catch((error) => {
    rejectionCount += 1;
    assert.equal(error.message, "repository runtime could not start");
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(rejectionCount, 1);
  assert.deepEqual(child.kills, []);
});


test("repository client safely terminates a helper when writing its request fails", async () => {
  const child = stdinFailureChild();

  await assert.rejects(
    runRepositoryFsOperation(
      { operation: "read-artifact", payload: "x".repeat(32 * 1024 * 1024) },
      {
        runtimePath: path.resolve("scripts/repository_fs_helper.py"),
        helperTerminationGraceMs: 30,
        spawnProcess() {
          return child;
        },
      },
    ),
    (error) => {
      assert.equal(error.message, "repository runtime input failed");
      assert.equal(error.message.includes("C:/Users/private"), false);
      return true;
    },
  );
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(child.closed, true);
});


test("repository client prefers a pending stdin failure when close arrives first", async () => {
  const child = stdinFailureChild({ closeBeforeError: true });

  await assert.rejects(
    runRepositoryFsOperation(
      { operation: "read-artifact", payload: "x".repeat(32 * 1024 * 1024) },
      {
        runtimePath: path.resolve("scripts/repository_fs_helper.py"),
        helperTerminationGraceMs: 30,
        spawnProcess() {
          return child;
        },
      },
    ),
    { message: "repository runtime input failed" },
  );
  assert.deepEqual(child.kills, []);
  assert.equal(child.closed, true);
});


function completedChild({ stdout = "", stderr = "", exitCode = 0, signal = null } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdinValue = "";
  child.stdin.on("data", (chunk) => { child.stdinValue += chunk.toString("utf8"); });
  queueMicrotask(() => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit("exit", exitCode, signal);
    child.emit("close", exitCode, signal);
  });
  return child;
}


function hangingChild({
  closeOnSignal = "SIGTERM",
  closeDelayMs = 1,
  killResult = true,
  safetyCloseMs,
} = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.closed = false;
  child.unrefCount = 0;
  child.unref = () => { child.unrefCount += 1; };
  let safetyHandle;
  const close = (signal = null) => {
    if (child.closed) return;
    child.closed = true;
    child.stdout.end();
    child.stderr.end();
    child.emit("close", null, signal);
  };
  child.kill = (signal) => {
    child.kills.push(signal);
    if (signal === closeOnSignal) setTimeout(() => close(signal), closeDelayMs);
    return killResult;
  };
  if (safetyCloseMs) safetyHandle = setTimeout(() => close(), safetyCloseMs);
  child.dispose = () => {
    clearTimeout(safetyHandle);
    close();
  };
  return child;
}


function outputFloodChild({ stdoutChunks = [], stderrChunks = [] } = {}) {
  const child = hangingChild({ safetyCloseMs: 500 });
  queueMicrotask(() => {
    for (const chunk of stdoutChunks) child.stdout.emit("data", chunk);
    for (const chunk of stderrChunks) child.stderr.emit("data", chunk);
  });
  return child;
}


function exitOnlyTerminationChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.unrefCount = 0;
  child.unref = () => { child.unrefCount += 1; };
  child.kill = (signal) => {
    child.kills.push(signal);
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  return child;
}


function stdinFailureChild({ closeBeforeError = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.closed = false;
  child.stdin.end = () => {
    queueMicrotask(() => {
      if (closeBeforeError) {
        child.closed = true;
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 1);
        child.emit("close", 1);
      }
      child.stdin.emit("error", new Error("write EPIPE at C:/Users/private/request.json"));
    });
  };
  child.kill = (signal) => {
    child.kills.push(signal);
    queueMicrotask(() => {
      if (child.closed) return;
      child.closed = true;
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", null, signal);
      child.emit("close", null, signal);
    });
    return true;
  };
  return child;
}


function racingFailureChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  queueMicrotask(() => {
    child.emit("error", new Error("failed at C:/Users/private/repository_fs_helper.py"));
    child.emit("close", 1);
  });
  return child;
}
