import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

import { replaceFileAtomically } from "./atomic-file-replace.mjs";
import { pathContainsSymbolicLink } from "./filesystem-path-safety.mjs";
import { parseHostObservationReport } from "./host-observation-contract.mjs";
import {
  StableFileSnapshotError,
  readStableFileSnapshot,
} from "./stable-file-snapshot.mjs";


const SCHEMA_VERSION = "host-observation.v1";
const BINDING_KEY_PATTERN = /^[0-9a-f]{64}$/;
const RELEASE_FINGERPRINT_PATTERN = /^[0-9a-f]{20}$/;
const MAX_RECORD_BYTES = 320 * 1024;


export function createFileHostObservationStore() {
  return Object.freeze({ read, write });

  async function read({ context, releaseFingerprint }) {
    const recordPath = await resolveRecordPath(context, releaseFingerprint, { create: false });
    if (recordPath === null) return null;
    let bytes;
    try {
      bytes = await readStableFileSnapshot(recordPath, { maxBytes: MAX_RECORD_BYTES });
    } catch (error) {
      if (error instanceof StableFileSnapshotError && error.kind === "invalid") {
        throw observationError("host_observation_state_invalid");
      }
      throw observationError("host_observation_unavailable");
    }
    if (bytes === null) return null;
    try {
      const record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (
        !record
        || Object.getPrototypeOf(record) !== Object.prototype
        || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([
          "bindingKey",
          "releaseFingerprint",
          "report",
          "schemaVersion",
        ])
        || record.schemaVersion !== SCHEMA_VERSION
        || record.bindingKey !== context.bindingKey
        || record.releaseFingerprint !== releaseFingerprint
      ) {
        throw observationError("host_observation_state_invalid");
      }
      return parseHostObservationReport(record.report);
    } catch (error) {
      if (error?.code === "host_observation_state_invalid") throw error;
      throw observationError("host_observation_state_invalid");
    }
  }

  async function write({ context, releaseFingerprint, report }) {
    let validatedReport;
    try {
      validatedReport = parseHostObservationReport(report);
    } catch {
      throw observationError("host_observation_state_invalid");
    }
    await read({ context, releaseFingerprint });
    const recordPath = await resolveRecordPath(context, releaseFingerprint, { create: true });
    const record = {
      schemaVersion: SCHEMA_VERSION,
      bindingKey: context.bindingKey,
      releaseFingerprint,
      report: validatedReport,
    };
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (bytes.length > MAX_RECORD_BYTES) {
      throw observationError("host_observation_state_invalid");
    }
    const temporaryPath = path.join(
      path.dirname(recordPath),
      `.observation-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await replaceFileAtomically(temporaryPath, recordPath);
    } catch (error) {
      if (error?.code === "host_observation_state_invalid") throw error;
      throw observationError("host_observation_unavailable");
    } finally {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw observationError("host_observation_unavailable");
        }
      }
    }
  }
}


export function createInMemoryHostObservationStore() {
  const reports = new Map();
  return Object.freeze({
    async read({ context, releaseFingerprint }) {
      return reports.get(recordKey(context.bindingKey, releaseFingerprint)) ?? null;
    },
    async write({ context, releaseFingerprint, report }) {
      reports.set(recordKey(context.bindingKey, releaseFingerprint), report);
    },
  });
}


async function resolveRecordPath(context, releaseFingerprint, { create }) {
  if (
    typeof context?.artifactRoot !== "string"
    || !path.isAbsolute(context.artifactRoot)
    || !BINDING_KEY_PATTERN.test(context.bindingKey)
    || !RELEASE_FINGERPRINT_PATTERN.test(releaseFingerprint)
  ) {
    throw observationError("host_observation_state_invalid");
  }
  const artifactRoot = path.resolve(context.artifactRoot);
  const directories = [
    artifactRoot,
    path.join(artifactRoot, ".runtime"),
    path.join(artifactRoot, ".runtime", "host-observations"),
    path.join(artifactRoot, ".runtime", "host-observations", context.bindingKey),
  ];
  for (let index = 0; index < directories.length; index += 1) {
    const available = await requireCanonicalDirectory(directories[index], {
      create: create && index > 0,
    });
    if (!available) return null;
  }
  const directory = directories.at(-1);
  return path.join(directory, `${releaseFingerprint}.json`);
}


async function requireCanonicalDirectory(directory, { create }) {
  try {
    if (create) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch (error) {
      if (!create && error?.code === "ENOENT") return false;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw observationError("host_observation_state_invalid");
    }
    if (await pathContainsSymbolicLink(directory)) {
      throw observationError("host_observation_state_invalid");
    }
    return true;
  } catch (error) {
    if (error?.code === "host_observation_state_invalid") throw error;
    throw observationError("host_observation_unavailable");
  }
}


function recordKey(bindingKey, releaseFingerprint) {
  return JSON.stringify([bindingKey, releaseFingerprint]);
}


function observationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
