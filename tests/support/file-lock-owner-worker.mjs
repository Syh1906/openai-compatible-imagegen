import { acquireFileLockOwnership } from "../../mcp/file-lock-ownership.mjs";


const [, , recordPath, lockPath, value] = process.argv;
const stateError = () => Object.assign(new Error("state unavailable"), {
  code: "state_unavailable",
});


try {
  const ownership = await acquireFileLockOwnership({
    recordPath,
    lockPath,
    maxRecordBytes: 1024,
    retries: { retries: 80, factor: 1, minTimeout: 5, maxTimeout: 25 },
    unavailableError: stateError,
  });
  await ownership.replaceSnapshot(Buffer.from(`${value}\n`, "utf8"));
  await ownership.release();
  process.stdout.write(`${JSON.stringify({ status: "ok" })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: error?.code ?? "unexpected_error" })}\n`);
}
