import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";


export function createRuntimeObservation({
  cwd,
  pluginRoot,
  projectRoot,
  projectRootSource,
  clientVersion,
  clientCapabilities,
  rootsSupported,
  roots = [],
  rootsErrorCode = null,
}) {
  const rootStatus = !rootsSupported
    ? "unsupported"
    : rootsErrorCode
      ? "error"
      : "available";
  return {
    cwdFingerprint: fingerprintPath(cwd),
    pluginRootFingerprint: fingerprintPath(pluginRoot),
    projectRootFingerprint: fingerprintPath(projectRoot),
    cwdRelationToPlugin: pathRelation(cwd, pluginRoot),
    projectRootRelationToPlugin: pathRelation(projectRoot, pluginRoot),
    projectRootSource,
    client: summarizeClient(clientVersion, clientCapabilities, rootsSupported),
    roots: {
      status: rootStatus,
      count: rootStatus === "available" ? roots.length : 0,
      entries: rootStatus === "available"
        ? roots.map((root) => summarizeRoot(root, { cwd, pluginRoot, projectRoot }))
        : [],
      errorCode: rootsErrorCode,
    },
  };
}


export function fingerprintPath(value) {
  return createHash("sha256")
    .update(normalizePath(value), "utf8")
    .digest("hex")
    .slice(0, 20);
}


export function pathRelation(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (!relative) return "same";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return "outside";
  return "descendant";
}


export function containsAbsolutePath(value) {
  const text = String(value);
  return /(?:^|[\s"'`([{])[A-Za-z]:[\\/]/.test(text)
    || /(?:^|[\s"'`([{])(?:\\\\|\/\/)[^\\/\s]+[\\/][^\s"'`]+/.test(text)
    || /(?:^|[\s"'`([{])\/(?!\/)[^\s"'`]+/.test(text)
    || /\bfile:\/\//i.test(text);
}


function summarizeRoot(root, paths) {
  const uri = typeof root?.uri === "string" ? root.uri : "";
  const scheme = uriScheme(uri);
  const summary = {
    scheme,
    fingerprint: fingerprintValue(uri),
    hasName: typeof root?.name === "string" && root.name.length > 0,
    comparable: false,
    relationToCwd: null,
    relationToPlugin: null,
    relationToProject: null,
  };
  if (scheme !== "file") return summary;
  try {
    const rootPath = fileURLToPath(uri);
    return {
      ...summary,
      fingerprint: fingerprintPath(rootPath),
      comparable: true,
      relationToCwd: pathRelation(rootPath, paths.cwd),
      relationToPlugin: pathRelation(rootPath, paths.pluginRoot),
      relationToProject: pathRelation(rootPath, paths.projectRoot),
    };
  } catch {
    return summary;
  }
}


function summarizeClient(clientVersion, clientCapabilities, rootsSupported) {
  const name = opaqueStringSummary(clientVersion?.name);
  const version = opaqueStringSummary(clientVersion?.version);
  return {
    reported: Boolean(clientVersion),
    nameFingerprint: name.fingerprint,
    nameLength: name.length,
    versionFingerprint: version.fingerprint,
    versionLength: version.length,
    capabilityCount: Object.keys(clientCapabilities ?? {}).length,
    rootsDeclared: Boolean(rootsSupported),
  };
}


function normalizePath(value) {
  const normalized = path.resolve(String(value)).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}


function fingerprintValue(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 20);
}


function opaqueStringSummary(value) {
  if (typeof value !== "string") return { fingerprint: null, length: 0 };
  return { fingerprint: fingerprintValue(value), length: value.length };
}


function uriScheme(uri) {
  return /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri)?.[1]?.toLowerCase() ?? "invalid";
}
