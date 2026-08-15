import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";


const runtimeRelativePath = import.meta.url.replaceAll("\\", "/").includes("/dist/server.mjs")
  ? "./scripts/image_runtime.py"
  : "../scripts/image_runtime.py";
const runtimePath = fileURLToPath(new URL(runtimeRelativePath, import.meta.url));

export async function runImageTask(task, {
  projectRoot,
  effectiveConfigJson,
  effectiveConfigSha256,
  artifactRoot,
} = {}) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw new Error("project root is required");
  }
  if (typeof effectiveConfigJson !== "string" || !effectiveConfigJson) {
    throw new Error("effective config JSON is required");
  }
  if (typeof effectiveConfigSha256 !== "string" || !/^[a-f0-9]{64}$/.test(effectiveConfigSha256)) {
    throw new Error("effective config SHA-256 is required");
  }
  if (typeof artifactRoot !== "string" || !path.isAbsolute(artifactRoot)) {
    throw new Error("artifact root is required");
  }
  return await new Promise((resolve, reject) => {
    const args = [
      runtimePath,
      "machine",
      "--project-root",
      projectRoot,
      "--artifact-root",
      artifactRoot,
    ];
    const child = spawn(
      "python",
      args,
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONIOENCODING: "utf-8",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new Error(`image runtime could not start: ${error.message}`));
    });
    child.on("close", () => {
      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch {
        const code = stderr.trim().split(/\r?\n/).at(-1) || "invalid runtime output";
        reject(new Error(`image runtime failed: ${code}`));
      }
    });
    child.stdin.end(JSON.stringify({
      task,
      effectiveConfigJson,
      effectiveConfigSha256,
    }));
  });
}
