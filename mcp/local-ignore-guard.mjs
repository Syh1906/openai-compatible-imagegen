import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { pathContainsSymbolicLink } from "./filesystem-path-safety.mjs";


const LOCAL_IGNORE_CONTENT = "*\n";


export class LocalIgnoreGuardError extends Error {
  constructor() {
    super("local_ignore_guard_failed");
    this.name = "LocalIgnoreGuardError";
    this.code = "local_ignore_guard_failed";
  }
}


export async function ensureLocalIgnore(directory) {
  const resolvedDirectory = path.resolve(directory);
  try {
    await mkdir(resolvedDirectory, { recursive: true });
    if (await pathContainsSymbolicLink(resolvedDirectory)) throw new LocalIgnoreGuardError();
    const ignorePath = path.join(resolvedDirectory, ".gitignore");
    const existing = await lstat(ignorePath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) throw new LocalIgnoreGuardError();
      if (await readFile(ignorePath, "utf8") !== LOCAL_IGNORE_CONTENT) throw new LocalIgnoreGuardError();
      return { path: ignorePath, created: false };
    }
    try {
      await writeFile(ignorePath, LOCAL_IGNORE_CONTENT, { encoding: "utf8", flag: "wx" });
      return { path: ignorePath, created: true };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const metadata = await lstat(ignorePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new LocalIgnoreGuardError();
      if (await readFile(ignorePath, "utf8") !== LOCAL_IGNORE_CONTENT) throw new LocalIgnoreGuardError();
      return { path: ignorePath, created: false };
    }
  } catch (error) {
    if (error instanceof LocalIgnoreGuardError) throw error;
    throw new LocalIgnoreGuardError();
  }
}
