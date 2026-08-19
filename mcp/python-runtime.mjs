import { execFile } from "node:child_process";
import { promisify } from "node:util";


const execFileAsync = promisify(execFile);
const PYTHON_OVERRIDE = "OPENAI_COMPATIBLE_IMAGEGEN_PYTHON";
let verifiedDefaultRuntime;


export function selectPythonCommand({
  platform = process.platform,
  environment = process.env,
} = {}) {
  if (Object.hasOwn(environment, PYTHON_OVERRIDE)) {
    const override = environment[PYTHON_OVERRIDE];
    if (typeof override !== "string" || !override.trim() || override.includes("\0")) {
      throw new Error(`${PYTHON_OVERRIDE} override is invalid`);
    }
    return override.trim();
  }
  if (platform === "win32") return "python";
  if (platform === "darwin" || platform === "linux") return "python3";
  throw new Error(`Python runtime has an unsupported platform: ${platform}`);
}


export async function verifyPythonRuntime(pythonCommand, { runCommand = execFileAsync } = {}) {
  if (typeof pythonCommand !== "string" || !pythonCommand) {
    throw new Error("Python runtime command is invalid");
  }
  let output;
  try {
    const result = await runCommand(pythonCommand, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  } catch (error) {
    throw new Error(`Python runtime preflight failed: ${error?.message || "could not start"}`);
  }
  const match = /^Python (\d+)\.(\d+)\.(\d+)(?:\s|$)/m.exec(output);
  if (!match || Number(match[1]) !== 3 || Number(match[2]) < 12) {
    throw new Error("Python 3.12 or newer is required");
  }
  return pythonCommand;
}


export async function resolvePythonRuntime() {
  if (!verifiedDefaultRuntime) {
    const command = selectPythonCommand();
    verifiedDefaultRuntime = verifyPythonRuntime(command).catch((error) => {
      verifiedDefaultRuntime = undefined;
      throw error;
    });
  }
  return await verifiedDefaultRuntime;
}
