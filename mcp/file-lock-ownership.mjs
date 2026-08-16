import fs from "node:fs";
import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import lockfile from "proper-lockfile";

import { replaceFileAtomically } from "./atomic-file-replace.mjs";
import {
  StableFileSnapshotError,
  readStableFileSnapshot,
} from "./stable-file-snapshot.mjs";


const EPOCH_SCHEMA_VERSION = "fenced-file-record.v1";
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const GENERATION_PATTERN = /^[0-9a-f]{16}$/;
const COMMITTED_PATTERN = /^e-([0-9a-f]{16})-([0-9a-f]{32})$/;
const RESERVATION_PATTERN = /^r-([0-9a-f]{16})$/;
const CLOSING_PATTERN = /^c-([0-9a-f]{32})$/;
const RECORD_TEMP_PATTERN = /^\.record-[0-9]+-[0-9a-f]{16}\.tmp$/;
const MAX_GENERATION = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_DIRECTORY_ENTRIES = 4096;
const MAX_EPOCH_METADATA_BYTES = 1024;


export async function acquireFileLockOwnership({
  recordPath,
  lockPath,
  maxRecordBytes,
  retries,
  unavailableError,
  invalidError = unavailableError,
}) {
  requireOptions({ recordPath, lockPath, maxRecordBytes, unavailableError, invalidError });
  const context = {
    recordPath: path.resolve(recordPath),
    lockPath: path.resolve(lockPath),
    maxRecordBytes,
    unavailableError,
    invalidError,
    installed: null,
    ownershipReady: false,
    compromised: false,
    ownershipLost: false,
  };
  let rawRelease;
  const guardedFs = createGuardedLockFs(context);
  try {
    rawRelease = await lockfile.lock(context.recordPath, {
      fs: guardedFs,
      lockfilePath: context.lockPath,
      onCompromised: () => {
        context.compromised = true;
        context.ownershipLost = true;
      },
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries,
    });
    context.ownershipReady = true;
    await assertOwned(context);
    const ownerRecordPath = path.join(context.installed.ownerPath, "record.json");
    return Object.freeze({
      assertOwned: async () => await assertOwned(context),
      readSnapshot: async () => await readStableFileSnapshot(ownerRecordPath, {
        maxBytes: context.maxRecordBytes,
      }),
      replaceSnapshot: async (bytes) => await replaceOwnedSnapshot(context, bytes),
      release: async () => await releaseOwnership(context, rawRelease, unavailableError),
    });
  } catch (error) {
    context.ownershipLost = true;
    if (rawRelease) {
      try {
        await rawRelease();
      } catch {
        // The caller receives the stable state error below.
      }
    }
    throw mapStateError(error, { invalidError, unavailableError });
  }
}


export async function readLatestFencedFileSnapshot(recordPath, { maxBytes }) {
  if (typeof recordPath !== "string" || !path.isAbsolute(recordPath)) {
    throw new TypeError("recordPath must be an absolute path");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
  const resolvedRecordPath = path.resolve(recordPath);
  const storage = storagePaths(resolvedRecordPath);
  const storageExists = await requireCanonicalDirectory(storage.root, {
    allowMissing: true,
    create: false,
  });
  if (!storageExists) {
    return await readStableFileSnapshot(resolvedRecordPath, { maxBytes });
  }
  await requireCanonicalDirectory(storage.committed, { create: false });
  await requireCanonicalDirectory(storage.reservations, { create: false });
  await requireCanonicalDirectory(storage.closing, { create: false });
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const epochs = await listCommittedEpochs(storage.committed);
    const initialized = await requireInitializationMarker(storage.initialized, { allowMissing: true });
    const latest = requireUniqueLatestEpoch(epochs);
    if (!latest && !initialized) {
      return await readStableFileSnapshot(resolvedRecordPath, { maxBytes });
    }
    if (latest && initialized) {
      return await readEpochRecord(latest.path, latest, maxBytes);
    }
    await delay(1);
  }
  throw new StableFileSnapshotError("invalid");
}


async function releaseOwnership(context, rawRelease, unavailableError) {
  let failure = null;
  try {
    await assertOwned(context);
  } catch (error) {
    failure = error;
  }
  try {
    await rawRelease();
  } catch {
    failure ??= unavailableError();
  }
  if (failure) throw failure;
}


async function replaceOwnedSnapshot(context, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length <= 0 || bytes.length > context.maxRecordBytes) {
    throw new TypeError("bytes must be a non-empty Buffer within maxRecordBytes");
  }
  await assertOwned(context);
  const temporaryPath = path.join(
    context.installed.ownerPath,
    `.record-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  const destinationPath = path.join(context.installed.ownerPath, "record.json");
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertOwned(context);
    await replaceFileAtomically(temporaryPath, destinationPath);
    await assertOwned(context);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    context.ownershipLost = true;
    throw context.unavailableError();
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        context.ownershipLost = true;
        throw context.unavailableError();
      }
    }
  }
}


function createGuardedLockFs(context) {
  const guardedFs = Object.create(fs);
  guardedFs.mkdir = (targetPath, callback) => {
    if (!samePath(targetPath, context.lockPath)) {
      fs.mkdir(targetPath, callback);
      return;
    }
    installOwnedLock(context).then(() => callback(null), callback);
  };
  guardedFs.rmdir = (targetPath, callback) => {
    if (!samePath(targetPath, context.lockPath)) {
      fs.rmdir(targetPath, callback);
      return;
    }
    if (context.ownershipLost) {
      queueMicrotask(() => callback(releasedError()));
      return;
    }
    const close = context.installed
      ? closeInstalledLock(context)
      : closeStaleLock(context);
    close.then(() => callback(null), callback);
  };
  guardedFs.rmdirSync = (targetPath) => {
    if (samePath(targetPath, context.lockPath)) throw releasedError();
    return fs.rmdirSync(targetPath);
  };
  return guardedFs;
}


async function installOwnedLock(context) {
  if (await isExistingCanonicalLock(context.lockPath)) {
    throw Object.assign(new Error("Lock file is already being held"), { code: "EEXIST" });
  }
  const storage = storagePaths(context.recordPath);
  await prepareStorage(storage);
  await withAllocatorLock(storage, async () => {
    if (await isExistingCanonicalLock(context.lockPath)) {
      throw Object.assign(new Error("Lock file is already being held"), { code: "EEXIST" });
    }
    await recoverClosingEpochs(storage);
    await pruneCommittedEpochs(storage.committed);
    const generation = await reserveGeneration(storage);
    const token = randomBytes(16).toString("hex");
    const candidatePath = path.join(path.dirname(context.lockPath), `.candidate-${token}`);
    const ownerPath = path.join(candidatePath, token);
    let installed = false;
    try {
      await mkdir(candidatePath, { mode: 0o700 });
      await mkdir(ownerPath, { mode: 0o700 });
      await writeExclusiveFile(
        path.join(ownerPath, "epoch.json"),
        Buffer.from(`${JSON.stringify(epochMetadata(generation, token))}\n`, "utf8"),
      );
      const current = await readLatestFencedFileSnapshot(context.recordPath, {
        maxBytes: context.maxRecordBytes,
      });
      if (current !== null) {
        await writeExclusiveFile(path.join(ownerPath, "record.json"), current);
      }
      await requireCurrentGeneration(storage, generation);
      await rename(candidatePath, context.lockPath);
      installed = true;
      context.installed = Object.freeze({
        generation,
        token,
        ownerPath: path.join(context.lockPath, token),
      });
    } catch (error) {
      if (await isExistingCanonicalLock(context.lockPath)) {
        throw Object.assign(new Error("Lock file is already being held"), { code: "EEXIST" });
      }
      throw error;
    } finally {
      if (!installed) await removeCandidateDirectory(candidatePath);
    }
  });
}


async function withAllocatorLock(storage, callback) {
  let compromised = false;
  const release = await lockfile.lock(storage.root, {
    lockfilePath: storage.allocator,
    onCompromised: () => {
      compromised = true;
    },
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 160, factor: 1, minTimeout: 5, maxTimeout: 25 },
  });
  let result;
  let failure;
  try {
    if (compromised) throw new StableFileSnapshotError("unavailable");
    result = await callback();
    if (compromised) throw new StableFileSnapshotError("unavailable");
  } catch (error) {
    failure = error;
  }
  try {
    await release();
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  return result;
}


async function closeInstalledLock(context) {
  if (!context.ownershipReady) {
    await removeCandidateOwner(context.lockPath, context.installed.token, { removeRoot: true });
    context.installed = null;
    return;
  }
  await assertOwned(context);
  const storage = storagePaths(context.recordPath);
  await commitOwnerDirectory(context.installed.ownerPath, storage.committed);
  try {
    await rmdir(context.lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}


async function closeStaleLock(context) {
  const storage = storagePaths(context.recordPath);
  await prepareStorage(storage);
  const closingPath = path.join(storage.closing, `c-${randomBytes(16).toString("hex")}`);
  try {
    await rename(context.lockPath, closingPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await recoverClosingEpochs(storage);
}


async function recoverClosingEpochs(storage) {
  const entries = await safeReadDirectory(storage.closing);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !CLOSING_PATTERN.test(entry.name)) {
      throw new StableFileSnapshotError("invalid");
    }
    await recoverClosingEpoch(path.join(storage.closing, entry.name), storage.committed);
  }
}


async function recoverClosingEpoch(closingPath, committedRoot) {
  let entries;
  try {
    entries = await safeReadDirectory(closingPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (entries.length > 1) throw new StableFileSnapshotError("invalid");
  if (entries.length === 1) {
    const [entry] = entries;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !TOKEN_PATTERN.test(entry.name)) {
      throw new StableFileSnapshotError("invalid");
    }
    await commitOwnerDirectory(path.join(closingPath, entry.name), committedRoot);
  }
  try {
    await rmdir(closingPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}


async function commitOwnerDirectory(ownerPath, committedRoot) {
  let metadata;
  try {
    metadata = await readOwnerMetadata(ownerPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await removeOwnedTemporaryFiles(ownerPath);
  const destinationPath = path.join(
    committedRoot,
    committedName(metadata.generation, metadata.token),
  );
  await createInitializationMarker(path.join(path.dirname(committedRoot), "initialized"));
  try {
    await rename(ownerPath, destinationPath);
  } catch (error) {
    if (error?.code !== "ENOENT" || !(await epochMatches(destinationPath, metadata))) throw error;
  }
}


async function assertOwned(context) {
  if (context.compromised || context.ownershipLost || !context.installed) {
    context.ownershipLost = true;
    throw context.unavailableError();
  }
  try {
    const metadata = await readOwnerMetadata(context.installed.ownerPath);
    if (
      metadata.generation !== context.installed.generation
      || metadata.token !== context.installed.token
    ) {
      throw new Error("lock owner changed");
    }
  } catch {
    context.ownershipLost = true;
    throw context.unavailableError();
  }
  if (context.compromised) {
    context.ownershipLost = true;
    throw context.unavailableError();
  }
}


async function readOwnerMetadata(ownerPath) {
  await requireCanonicalDirectory(ownerPath, { create: false });
  const bytes = await readStableFileSnapshot(path.join(ownerPath, "epoch.json"), {
    maxBytes: MAX_EPOCH_METADATA_BYTES,
  });
  if (bytes === null) throw new StableFileSnapshotError("invalid");
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new StableFileSnapshotError("invalid");
  }
  if (
    !plainObject(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["generation", "schemaVersion", "token"])
    || value.schemaVersion !== EPOCH_SCHEMA_VERSION
    || typeof value.generation !== "string"
    || !GENERATION_PATTERN.test(value.generation)
    || typeof value.token !== "string"
    || !TOKEN_PATTERN.test(value.token)
  ) {
    throw new StableFileSnapshotError("invalid");
  }
  const generation = BigInt(`0x${value.generation}`);
  if (generation <= 0n || generation > MAX_GENERATION) {
    throw new StableFileSnapshotError("invalid");
  }
  return Object.freeze({ generation, token: value.token });
}


async function readEpochRecord(epochPath, expected, maxBytes) {
  const metadata = await readOwnerMetadata(epochPath);
  if (metadata.generation !== expected.generation || metadata.token !== expected.token) {
    throw new StableFileSnapshotError("invalid");
  }
  const entries = await safeReadDirectory(epochPath);
  for (const entry of entries) {
    if (
      entry.isSymbolicLink()
      || !entry.isFile()
      || !["epoch.json", "record.json"].includes(entry.name)
    ) {
      throw new StableFileSnapshotError("invalid");
    }
  }
  return await readStableFileSnapshot(path.join(epochPath, "record.json"), { maxBytes });
}


async function listCommittedEpochs(committedRoot) {
  const entries = await safeReadDirectory(committedRoot);
  const epochs = [];
  for (const entry of entries) {
    const match = COMMITTED_PATTERN.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new StableFileSnapshotError("invalid");
    }
    const generation = BigInt(`0x${match[1]}`);
    if (generation <= 0n || generation > MAX_GENERATION) {
      throw new StableFileSnapshotError("invalid");
    }
    epochs.push({
      generation,
      token: match[2],
      path: path.join(committedRoot, entry.name),
    });
  }
  return epochs;
}


function requireUniqueLatestEpoch(epochs) {
  if (epochs.length === 0) return null;
  const sorted = [...epochs].sort((left, right) => (
    left.generation < right.generation ? -1 : left.generation > right.generation ? 1 : 0
  ));
  const latest = sorted.at(-1);
  if (sorted.length > 1 && sorted.at(-2).generation === latest.generation) {
    throw new StableFileSnapshotError("invalid");
  }
  return latest;
}


async function pruneCommittedEpochs(committedRoot) {
  const epochs = await listCommittedEpochs(committedRoot);
  const latest = requireUniqueLatestEpoch(epochs);
  for (const epoch of epochs) {
    if (epoch !== latest) await removeCommittedEpoch(epoch.path, epoch);
  }
}


async function removeCommittedEpoch(epochPath, expected) {
  await readEpochRecord(epochPath, expected, Number.MAX_SAFE_INTEGER);
  const entries = await safeReadDirectory(epochPath);
  for (const entry of entries) await unlink(path.join(epochPath, entry.name));
  await rmdir(epochPath);
}


async function reserveGeneration(storage) {
  for (;;) {
    const reservations = await listReservations(storage.reservations);
    const committed = await listCommittedEpochs(storage.committed);
    let maximum = 0n;
    for (const generation of reservations) if (generation > maximum) maximum = generation;
    for (const epoch of committed) if (epoch.generation > maximum) maximum = epoch.generation;
    if (maximum >= MAX_GENERATION) throw new StableFileSnapshotError("invalid");
    const generation = maximum + 1n;
    const reservationPath = path.join(storage.reservations, reservationName(generation));
    try {
      const handle = await open(reservationPath, "wx", 0o600);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await pruneReservations(storage.reservations, generation);
      return generation;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}


async function requireCurrentGeneration(storage, generation) {
  const reservations = await listReservations(storage.reservations);
  const committed = await listCommittedEpochs(storage.committed);
  for (const candidate of reservations) {
    if (candidate > generation) throw Object.assign(new Error("newer lock generation exists"), { code: "EEXIST" });
  }
  for (const epoch of committed) {
    if (epoch.generation > generation) throw Object.assign(new Error("newer record generation exists"), { code: "EEXIST" });
  }
}


async function listReservations(reservationsRoot) {
  const entries = await safeReadDirectory(reservationsRoot);
  const values = [];
  for (const entry of entries) {
    const match = RESERVATION_PATTERN.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      throw new StableFileSnapshotError("invalid");
    }
    const generation = BigInt(`0x${match[1]}`);
    if (generation <= 0n || generation > MAX_GENERATION) {
      throw new StableFileSnapshotError("invalid");
    }
    values.push(generation);
  }
  return values;
}


async function pruneReservations(reservationsRoot, keepFrom) {
  const entries = await safeReadDirectory(reservationsRoot);
  for (const entry of entries) {
    const match = RESERVATION_PATTERN.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      throw new StableFileSnapshotError("invalid");
    }
    if (BigInt(`0x${match[1]}`) < keepFrom) {
      await unlink(path.join(reservationsRoot, entry.name));
    }
  }
}


async function removeOwnedTemporaryFiles(ownerPath) {
  const entries = await safeReadDirectory(ownerPath);
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new StableFileSnapshotError("invalid");
    }
    if (["epoch.json", "record.json"].includes(entry.name)) continue;
    if (!RECORD_TEMP_PATTERN.test(entry.name)) throw new StableFileSnapshotError("invalid");
    await unlink(path.join(ownerPath, entry.name));
  }
}


async function removeCandidateDirectory(candidatePath) {
  let entries;
  try {
    entries = await safeReadDirectory(candidatePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (entries.length > 1) throw new StableFileSnapshotError("invalid");
  if (entries.length === 1) {
    const [entry] = entries;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !TOKEN_PATTERN.test(entry.name)) {
      throw new StableFileSnapshotError("invalid");
    }
    await removeCandidateOwner(candidatePath, entry.name, { removeRoot: false });
  }
  try {
    await rmdir(candidatePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}


async function removeCandidateOwner(rootPath, token, { removeRoot }) {
  const ownerPath = path.join(rootPath, token);
  let entries;
  try {
    entries = await safeReadDirectory(ownerPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (
      entry.isSymbolicLink()
      || !entry.isFile()
      || (!["epoch.json", "record.json"].includes(entry.name) && !RECORD_TEMP_PATTERN.test(entry.name))
    ) {
      throw new StableFileSnapshotError("invalid");
    }
    await unlink(path.join(ownerPath, entry.name));
  }
  await rmdir(ownerPath);
  if (removeRoot) {
    try {
      await rmdir(rootPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}


async function prepareStorage(storage) {
  await requireCanonicalDirectory(path.dirname(storage.root), { create: false });
  await requireCanonicalDirectory(storage.root, { create: true });
  await requireCanonicalDirectory(storage.committed, { create: true });
  await requireCanonicalDirectory(storage.reservations, { create: true });
  await requireCanonicalDirectory(storage.closing, { create: true });
}


async function createInitializationMarker(markerPath) {
  try {
    const handle = await open(markerPath, "wx", 0o600);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await requireInitializationMarker(markerPath);
}


async function requireInitializationMarker(markerPath, { allowMissing = false } = {}) {
  try {
    const metadata = await lstat(markerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== 0) {
      throw new StableFileSnapshotError("invalid");
    }
    if (!samePath(await realpath(markerPath), markerPath)) {
      throw new StableFileSnapshotError("invalid");
    }
    return true;
  } catch (error) {
    if (error instanceof StableFileSnapshotError) throw error;
    if (error?.code === "ENOENT" && allowMissing) return false;
    if (error?.code === "ENOENT") throw new StableFileSnapshotError("invalid");
    throw new StableFileSnapshotError("unavailable");
  }
}


async function requireCanonicalDirectory(directory, { create, allowMissing = false }) {
  try {
    if (create) {
      await mkdir(directory, { mode: 0o700 }).catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
    }
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(await realpath(directory), directory)) {
      throw new StableFileSnapshotError("invalid");
    }
    return true;
  } catch (error) {
    if (error instanceof StableFileSnapshotError) throw error;
    if (error?.code === "ENOENT" && allowMissing) return false;
    if (error?.code === "ENOENT") throw new StableFileSnapshotError("invalid");
    throw new StableFileSnapshotError("unavailable");
  }
}


async function safeReadDirectory(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > MAX_DIRECTORY_ENTRIES) throw new StableFileSnapshotError("invalid");
    return entries;
  } catch (error) {
    if (error instanceof StableFileSnapshotError) throw error;
    throw error;
  }
}


async function writeExclusiveFile(filePath, bytes) {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}


async function epochMatches(epochPath, expected) {
  try {
    const actual = await readOwnerMetadata(epochPath);
    return actual.generation === expected.generation && actual.token === expected.token;
  } catch {
    return false;
  }
}


async function isExistingCanonicalLock(lockPath) {
  try {
    const metadata = await lstat(lockPath);
    return metadata.isDirectory()
      && !metadata.isSymbolicLink()
      && samePath(await realpath(lockPath), lockPath);
  } catch {
    return false;
  }
}


function storagePaths(recordPath) {
  const root = `${recordPath}.epochs`;
  return {
    root,
    committed: path.join(root, "committed"),
    reservations: path.join(root, "reservations"),
    closing: path.join(root, "closing"),
    allocator: path.join(root, "allocator.lock"),
    initialized: path.join(root, "initialized"),
  };
}


function epochMetadata(generation, token) {
  return {
    schemaVersion: EPOCH_SCHEMA_VERSION,
    generation: generationHex(generation),
    token,
  };
}


function committedName(generation, token) {
  return `e-${generationHex(generation)}-${token}`;
}


function reservationName(generation) {
  return `r-${generationHex(generation)}`;
}


function generationHex(generation) {
  return generation.toString(16).padStart(16, "0");
}


function requireOptions({ recordPath, lockPath, maxRecordBytes, unavailableError, invalidError }) {
  if (typeof recordPath !== "string" || !path.isAbsolute(recordPath)) {
    throw new TypeError("recordPath must be an absolute path");
  }
  if (typeof lockPath !== "string" || !path.isAbsolute(lockPath)) {
    throw new TypeError("lockPath must be an absolute path");
  }
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0) {
    throw new TypeError("maxRecordBytes must be a positive safe integer");
  }
  if (typeof unavailableError !== "function" || typeof invalidError !== "function") {
    throw new TypeError("state error factories must be functions");
  }
}


function mapStateError(error, { invalidError, unavailableError }) {
  if (error instanceof StableFileSnapshotError && error.kind === "invalid") return invalidError();
  return unavailableError();
}


function releasedError() {
  return Object.assign(new Error("lock ownership changed before release"), { code: "ERELEASED" });
}


function plainObject(value) {
  return Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
}


function samePath(left, right) {
  const normalizedLeft = path.resolve(left).replaceAll("\\", "/");
  const normalizedRight = path.resolve(right).replaceAll("\\", "/");
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}


function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
