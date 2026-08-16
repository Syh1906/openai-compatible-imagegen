import { readdir } from "node:fs/promises";
import path from "node:path";


const COMMITTED_PATTERN = /^e-([0-9a-f]{16})-[0-9a-f]{32}$/;


export async function latestCommittedRecordPath(recordPath) {
  const committedRoot = path.join(`${recordPath}.epochs`, "committed");
  const entries = await readdir(committedRoot, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && COMMITTED_PATTERN.test(entry.name))
    .map((entry) => ({ entry, generation: COMMITTED_PATTERN.exec(entry.name)[1] }))
    .sort((left, right) => left.generation.localeCompare(right.generation));
  const latest = candidates.at(-1);
  if (!latest) throw new Error(`no committed record epoch for ${recordPath}`);
  return path.join(committedRoot, latest.entry.name, "record.json");
}
