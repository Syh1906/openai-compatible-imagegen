import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";


const runtimeRelativePath = import.meta.url.replaceAll("\\", "/").includes("/dist/server.mjs")
  ? "./scripts/repository_fs_helper.py"
  : "../scripts/repository_fs_helper.py";
const defaultRuntimePath = fileURLToPath(new URL(runtimeRelativePath, import.meta.url));
const MAX_RUNTIME_OUTPUT = 48 * 1024 * 1024;
const DEFAULT_HELPER_TIMEOUT_MS = 120_000;
const DEFAULT_HELPER_TERMINATION_GRACE_MS = 1_000;


export async function runRepositoryFsOperation(request, {
  pythonCommand = "python",
  runtimePath = defaultRuntimePath,
  spawnProcess = spawn,
  helperTimeoutMs = DEFAULT_HELPER_TIMEOUT_MS,
  helperTerminationGraceMs = DEFAULT_HELPER_TERMINATION_GRACE_MS,
} = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("repository operation is required");
  }
  if (typeof runtimePath !== "string" || !path.isAbsolute(runtimePath)) {
    throw new Error("repository runtime is unavailable");
  }
  if (!Number.isFinite(helperTimeoutMs) || helperTimeoutMs <= 0) {
    throw new Error("repository runtime timeout is invalid");
  }
  if (!Number.isFinite(helperTerminationGraceMs) || helperTerminationGraceMs <= 0) {
    throw new Error("repository runtime termination grace is invalid");
  }
  let serializedRequest;
  try {
    serializedRequest = JSON.stringify(request);
  } catch {
    throw new Error("repository operation is not serializable");
  }
  if (typeof serializedRequest !== "string") {
    throw new Error("repository operation is not serializable");
  }
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(pythonCommand, [runtimePath], {
        cwd: path.dirname(runtimePath),
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONIOENCODING: "utf-8",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      reject(new Error("repository runtime could not start"));
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let outputLength = 0;
    let settled = false;
    let exited = false;
    let exitCode;
    let exitSignal;
    let inputFinished = false;
    let closePending = false;
    let terminationReason;
    let terminationPhase = 0;
    let timeoutHandle;
    let terminationHandle;
    const registeredListeners = [];
    const registerListener = (emitter, event, listener, once = false) => {
      registeredListeners.push({ emitter, event, listener });
      if (once) emitter.once(event, listener);
      else emitter.on(event, listener);
    };
    const removeRegisteredListeners = () => {
      for (const { emitter, event, listener } of registeredListeners) {
        emitter.removeListener(event, listener);
      }
      registeredListeners.length = 0;
    };
    const releaseTerminatedChild = () => {
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        if (stream && typeof stream.destroy === "function") stream.destroy();
      }
      removeRegisteredListeners();
      if (typeof child.unref === "function") child.unref();
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(terminationHandle);
      callback();
    };
    const rejectTermination = (unconfirmed = false) => {
      if (settled) return;
      releaseTerminatedChild();
      settle(() => {
        const message = terminationReason === "input"
          ? "repository runtime input failed"
          : terminationReason === "output"
            ? "repository runtime output exceeded the limit"
            : "repository runtime timed out";
        reject(new Error(unconfirmed ? `${message}; helper termination was not confirmed` : message));
      });
    };
    const scheduleTerminationEscalation = () => {
      terminationHandle = setTimeout(() => {
        if (settled || exited) return;
        if (terminationPhase === 1) {
          terminationPhase = 2;
          try {
            child.kill("SIGKILL");
          } catch {
            // The helper may have exited between termination phases.
          }
          scheduleTerminationEscalation();
          return;
        }
        rejectTermination(true);
      }, helperTerminationGraceMs);
    };
    const beginTermination = (reason) => {
      if (settled || terminationReason) return;
      terminationReason = reason;
      terminationPhase = 1;
      if (exited) {
        rejectTermination();
        return;
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // The helper may have exited between the failure and termination.
      }
      if (exited) rejectTermination();
      else scheduleTerminationEscalation();
    };
    const settleFromClose = () => {
      if (terminationReason) {
        rejectTermination();
        return;
      }
      settle(() => {
        if (exitCode !== 0 || exitSignal !== null) {
          reject(new Error("repository runtime failed"));
          return;
        }
        let stdout;
        let stderr;
        try {
          stdout = decodeRuntimeOutput(stdoutChunks);
          stderr = decodeRuntimeOutput(stderrChunks);
        } catch {
          reject(new Error("repository runtime returned invalid output"));
          return;
        }
        let response;
        try {
          response = JSON.parse(stdout);
        } catch {
          reject(new Error("repository runtime returned invalid output"));
          return;
        }
        if (response?.ok !== true) {
          reject(new Error(safeRuntimeError(response?.error, stderr)));
          return;
        }
        resolve(response.result);
      });
    };
    const onStdoutData = (chunk) => {
      if (terminationReason) return;
      const appended = appendOutput(stdoutChunks, chunk, outputLength);
      outputLength = appended.outputLength;
      if (appended.limitReached) beginTermination("output");
    };
    const onStderrData = (chunk) => {
      if (terminationReason) return;
      const appended = appendOutput(stderrChunks, chunk, outputLength);
      outputLength = appended.outputLength;
      if (appended.limitReached) beginTermination("output");
    };
    const onStdinError = () => {
      beginTermination("input");
    };
    const onStdinFinish = () => {
      inputFinished = true;
      if (closePending) settleFromClose();
    };
    const onChildError = () => {
      if (!terminationReason) settle(() => reject(new Error("repository runtime could not start")));
    };
    const onChildExit = (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      if (terminationReason) rejectTermination();
    };
    const onChildClose = (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      if (terminationReason) {
        rejectTermination();
        return;
      }
      if (!inputFinished) {
        closePending = true;
        return;
      }
      settleFromClose();
    };
    registerListener(child.stdout, "data", onStdoutData);
    registerListener(child.stderr, "data", onStderrData);
    registerListener(child.stdin, "error", onStdinError);
    registerListener(child.stdin, "finish", onStdinFinish, true);
    registerListener(child, "error", onChildError, true);
    registerListener(child, "exit", onChildExit, true);
    registerListener(child, "close", onChildClose, true);
    timeoutHandle = setTimeout(() => {
      beginTermination("timeout");
    }, helperTimeoutMs);
    child.stdin.end(serializedRequest);
  });
}


function appendOutput(chunks, chunk, outputLength) {
  const chunkValue = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = MAX_RUNTIME_OUTPUT - outputLength;
  const appended = chunkValue.subarray(0, remaining);
  if (appended.length > 0) chunks.push(appended);
  return {
    outputLength: outputLength + appended.length,
    limitReached: chunkValue.length >= remaining,
  };
}


function decodeRuntimeOutput(chunks) {
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}


function safeRuntimeError(error, stderr) {
  const value = String(error || stderr || "repository operation failed");
  if (/not found|cannot find|no such file/i.test(value) || /找不到/.test(value)) return "repository entry not found";
  if (/reparse point/i.test(value)) return "repository path contains a reparse point";
  if (/locked by another image task/i.test(value)) return "repository is locked by another image task";
  if (/required/i.test(value)) return "repository operation is missing required data";
  if (/unsupported/i.test(value)) return "repository operation is unsupported";
  if (/invalid|does not match|unknown entries/i.test(value)) return "repository operation is invalid";
  return "repository operation failed";
}
