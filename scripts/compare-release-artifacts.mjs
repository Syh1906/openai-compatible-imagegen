import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";


export async function compareReleaseArtifactDirectories(leftDirectory, rightDirectory) {
  const [leftFiles, rightFiles] = await Promise.all([
    listFlatFiles(leftDirectory),
    listFlatFiles(rightDirectory),
  ]);
  if (JSON.stringify(leftFiles) !== JSON.stringify(rightFiles)) {
    const unexpected = rightFiles.filter((name) => !leftFiles.includes(name));
    const missing = leftFiles.filter((name) => !rightFiles.includes(name));
    throw new Error(`release artifact file sets differ; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`);
  }
  const hashes = {};
  for (const name of leftFiles) {
    const [left, right] = await Promise.all([
      readFile(path.join(leftDirectory, name)),
      readFile(path.join(rightDirectory, name)),
    ]);
    const leftHash = sha256(left);
    const rightHash = sha256(right);
    if (leftHash !== rightHash) {
      throw new Error(`release artifact ${name} differs between candidate directories`);
    }
    hashes[name] = leftHash;
  }
  return { ok: true, files: leftFiles, sha256: hashes };
}


async function listFlatFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new Error(`release candidate contains a non-file entry: ${entry.name}`);
    }
  }
  return entries.map((entry) => entry.name).sort();
}


function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}


function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}


const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    const result = await compareReleaseArtifactDirectories(
      readOption("--left"),
      readOption("--right"),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
