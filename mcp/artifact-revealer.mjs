import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";


const runtimeRelativePath = import.meta.url.replaceAll("\\", "/").includes("/dist/server.mjs")
  ? "./scripts/reveal_in_explorer.py"
  : "../scripts/reveal_in_explorer.py";
const defaultRuntimePath = fileURLToPath(new URL(runtimeRelativePath, import.meta.url));
const MAX_RUNTIME_OUTPUT = 16 * 1024;
const DEFAULT_HELPER_TIMEOUT_MS = 8_000;
const DEFAULT_HELPER_TERMINATION_GRACE_MS = 1_000;


export async function revealImageArtifact(imageId, {
  artifactRoot,
  platform = process.platform,
  pythonCommand = "python",
  runtimePath = defaultRuntimePath,
  spawnProcess = spawn,
  helperTimeoutMs = DEFAULT_HELPER_TIMEOUT_MS,
  helperTerminationGraceMs = DEFAULT_HELPER_TERMINATION_GRACE_MS,
} = {}) {
  if (platform !== "win32") {
    throw new Error("artifact reveal is not supported on this platform");
  }
  if (typeof artifactRoot !== "string" || !path.isAbsolute(artifactRoot)) {
    throw new Error("artifact root is required");
  }
  await runShellHelper({
    pythonCommand,
    runtimePath,
    imageId,
    artifactRoot,
    spawnProcess,
    helperTimeoutMs,
    helperTerminationGraceMs,
  });
  return { status: "revealed", imageId };
}


async function runShellHelper({
  pythonCommand,
  runtimePath,
  imageId,
  artifactRoot,
  spawnProcess,
  helperTimeoutMs,
  helperTerminationGraceMs,
}) {
  if (typeof runtimePath !== "string" || !path.isAbsolute(runtimePath)) {
    throw new Error("artifact reveal runtime is unavailable");
  }
  if (!Number.isFinite(helperTimeoutMs) || helperTimeoutMs <= 0) {
    throw new Error("artifact reveal timeout is invalid");
  }
  if (!Number.isFinite(helperTerminationGraceMs) || helperTerminationGraceMs <= 0) {
    throw new Error("artifact reveal termination grace is invalid");
  }
  const child = spawnProcess(pythonCommand, [
    runtimePath,
    "--artifact-root",
    artifactRoot,
    "--image-id",
    imageId,
  ], {
    cwd: path.dirname(runtimePath),
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONIOENCODING: "utf-8",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let outputExceeded = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    ({ value: stdout, exceeded: outputExceeded } = appendOutput(stdout, chunk, outputExceeded));
  });
  child.stderr.on("data", (chunk) => {
    ({ value: stderr, exceeded: outputExceeded } = appendOutput(stderr, chunk, outputExceeded));
  });
  await new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let exited = false;
    let terminationPhase = 0;
    let timeoutHandle;
    let terminationHandle;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(terminationHandle);
      callback();
    };
    const rejectTimeout = (unconfirmed = false) => settle(() => reject(new Error(
      unconfirmed
        ? "artifact reveal timed out; helper termination was not confirmed"
        : "artifact reveal timed out",
    )));
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
        rejectTimeout(true);
      }, helperTerminationGraceMs);
    };
    child.once("error", (error) => {
      if (!timedOut) settle(() => reject(new Error("artifact reveal helper failed to start")));
    });
    child.once("exit", () => {
      exited = true;
      if (timedOut) rejectTimeout();
    });
    child.once("close", (code) => {
      exited = true;
      if (timedOut) {
        rejectTimeout();
        return;
      }
      settle(() => {
      if (outputExceeded) {
        reject(new Error("artifact reveal runtime output exceeded the limit"));
        return;
      }
      if (code !== 0) {
        reject(new Error("artifact reveal helper failed"));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        if (
          result?.status !== "revealed"
          || result.targetSelected !== true
          || result.windowVisible !== true
          || result.windowForeground !== true
        ) {
          throw new Error("shell selection confirmation is incomplete");
        }
        resolve();
      } catch (error) {
        reject(new Error(`artifact reveal failed: ${error.message}`));
      }
      });
    });
    timeoutHandle = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminationPhase = 1;
      try {
        child.kill("SIGTERM");
      } catch {
        // The helper may have exited between the deadline and termination.
      }
      if (exited) rejectTimeout();
      else scheduleTerminationEscalation();
    }, helperTimeoutMs);
  });
}


function appendOutput(current, chunk, exceeded) {
  const next = current + String(chunk);
  return {
    value: next.slice(0, MAX_RUNTIME_OUTPUT),
    exceeded: exceeded || next.length > MAX_RUNTIME_OUTPUT,
  };
}
