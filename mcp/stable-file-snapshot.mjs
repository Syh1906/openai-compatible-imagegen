import { lstat, open } from "node:fs/promises";
import path from "node:path";

import { pathContainsSymbolicLink } from "./filesystem-path-safety.mjs";


const RETRY = Symbol("retry");
const MISSING = Symbol("missing");


export class StableFileSnapshotError extends Error {
  constructor(kind) {
    super(`stable file snapshot ${kind}`);
    this.name = "StableFileSnapshotError";
    this.kind = kind;
  }
}


export async function readStableFileSnapshot(filePath, { maxBytes, attempts = 32 }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
  let sawReplacement = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await readSnapshotOnce(filePath, maxBytes);
    if (result === MISSING) {
      if (!sawReplacement) return null;
      continue;
    }
    if (result === RETRY) {
      sawReplacement = true;
      continue;
    }
    return result;
  }
  throw new StableFileSnapshotError("unavailable");
}


async function readSnapshotOnce(filePath, maxBytes) {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if (error?.code === "ENOENT") {
      try {
        const metadata = await lstat(filePath);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new StableFileSnapshotError("invalid");
        }
        return RETRY;
      } catch (metadataError) {
        if (metadataError instanceof StableFileSnapshotError) throw metadataError;
        if (metadataError?.code === "ENOENT") return MISSING;
        throw new StableFileSnapshotError("unavailable");
      }
    }
    throw new StableFileSnapshotError("unavailable");
  }
  try {
    const [pathMetadata, handleMetadata] = await Promise.all([
      lstat(filePath),
      handle.stat(),
    ]);
    if (
      !pathMetadata.isFile()
      || pathMetadata.isSymbolicLink()
      || !handleMetadata.isFile()
      || handleMetadata.size <= 0
      || handleMetadata.size > maxBytes
    ) {
      throw new StableFileSnapshotError("invalid");
    }
    if (pathMetadata.dev !== handleMetadata.dev || pathMetadata.ino !== handleMetadata.ino) {
      return RETRY;
    }
    if (await pathContainsSymbolicLink(filePath)) {
      throw new StableFileSnapshotError("invalid");
    }
    const bytes = await handle.readFile();
    if (bytes.length !== handleMetadata.size || bytes.length > maxBytes) {
      throw new StableFileSnapshotError("invalid");
    }
    return bytes;
  } catch (error) {
    if (error instanceof StableFileSnapshotError) throw error;
    if (error?.code === "ENOENT") return RETRY;
    throw new StableFileSnapshotError("unavailable");
  } finally {
    try {
      await handle.close();
    } catch {
      throw new StableFileSnapshotError("unavailable");
    }
  }
}
