import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";


const WINDOWS_SHARING_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);


export async function replaceFileAtomically(sourcePath, destinationPath) {
  const attempts = process.platform === "win32" ? 80 : 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      lastError = error;
      if (!WINDOWS_SHARING_ERRORS.has(error?.code) || attempt === attempts - 1) throw error;
      await delay(1);
    }
  }
  throw lastError;
}
