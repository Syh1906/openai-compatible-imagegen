import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";


const execFileAsync = promisify(execFile);
const defaultSourceRoot = fileURLToPath(new URL("..", import.meta.url));
const stageScript = fileURLToPath(new URL("./stage-personal-plugin.mjs", import.meta.url));


export async function preparePersonalPlugin({
  sourceRoot = defaultSourceRoot,
  marketplacePath = path.join(os.homedir(), ".agents", "plugins", "marketplace.json"),
  npmCliPath = process.env.npm_execpath,
  execute = execFileAsync,
} = {}) {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const resolvedMarketplacePath = path.resolve(marketplacePath);
  const npmCommand = npmCliPath ? process.execPath : "npm";
  const npmArgs = (args) => npmCliPath ? [npmCliPath, ...args] : args;
  const commands = [
    { name: "build", command: npmCommand, args: npmArgs(["run", "build"]) },
    { name: "test", command: npmCommand, args: npmArgs(["run", "test"]) },
    { name: "check", command: npmCommand, args: npmArgs(["run", "check"]) },
    {
      name: "stage:personal",
      command: process.execPath,
      args: [
        stageScript,
        "--source-root",
        resolvedSourceRoot,
        "--marketplace-path",
        resolvedMarketplacePath,
      ],
    },
  ];
  let stage = null;
  for (const step of commands) {
    let result;
    try {
      result = await execute(step.command, step.args, {
        cwd: resolvedSourceRoot,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(`${step.name} failed: ${formatCommandError(error)}`, { cause: error });
    }
    if (step.name === "stage:personal") {
      stage = parseStageResult(result.stdout);
    }
  }

  return {
    ok: true,
    steps: commands.map(({ name }) => name),
    stage,
  };
}


function parseStageResult(stdout) {
  let result;
  try {
    result = JSON.parse(String(stdout).trim());
  } catch (error) {
    throw new Error("stage:personal returned invalid JSON", { cause: error });
  }
  if (
    result.ok !== true
    || result.sourceConsistent !== true
    || result.probeOk !== true
    || result.plugin !== "openai-compatible-imagegen"
    || typeof result.marketplaceName !== "string"
    || result.marketplaceName.length === 0
  ) {
    throw new Error("stage:personal did not prove source consistency");
  }
  return result;
}


function formatCommandError(error) {
  const stdout = tail(String(error?.stdout ?? "").trim(), 6000);
  const stderr = String(error?.stderr ?? "").trim();
  const output = [stdout, tail(stderr, 2000)].filter(Boolean).join("\n");
  return output || error?.message || "command failed";
}


function tail(value, limit) {
  return value.length > limit ? value.slice(-limit) : value;
}


function parseOptions(args) {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === "--marketplace-path" && args[1]) {
    return { marketplacePath: args[1] };
  }
  throw new Error(
    "usage: node scripts/prepare-personal-plugin.mjs [--marketplace-path <path>]",
  );
}


async function main() {
  const result = await preparePersonalPlugin(parseOptions(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}


const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
