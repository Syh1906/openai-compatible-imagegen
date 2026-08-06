import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";


const SESSION_META_KEY = "openai/session";


export class ProjectContextError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProjectContextError";
    this.code = code;
  }
}


export function createProjectContext({ pluginRoot }) {
  if (typeof pluginRoot !== "string" || !path.isAbsolute(pluginRoot)) {
    throw new Error("pluginRoot must be an absolute path");
  }
  const resolvedPluginRoot = path.resolve(pluginRoot);
  const bindings = new Map();
  const pendingOperations = new Map();

  return Object.freeze({
    async bind(extra, { projectRoot }) {
      const bindingKey = requireBindingKey(extra);
      return await serializeBinding(pendingOperations, bindingKey, async () => {
        const existing = bindings.get(bindingKey);
        if (existing) {
          if (
            typeof projectRoot === "string"
            && path.isAbsolute(projectRoot)
            && samePath(existing.projectRoot, projectRoot)
          ) {
            return { status: "already_bound" };
          }
          throw new ProjectContextError("project_binding_conflict");
        }
        const resolvedProjectRoot = await validateProjectRoot(projectRoot, resolvedPluginRoot);
        bindings.set(bindingKey, Object.freeze({
          bindingKey,
          projectRoot: resolvedProjectRoot,
          artifactRoot: path.join(resolvedProjectRoot, "output", "imagegen"),
        }));
        return { status: "bound" };
      });
    },

    async require(extra) {
      const bindingKey = requireBindingKey(extra);
      const binding = bindings.get(bindingKey);
      if (!binding) throw new ProjectContextError("project_binding_required");
      await validateProjectRoot(binding.projectRoot, resolvedPluginRoot);
      return binding;
    },
  });
}


function requireBindingKey(extra) {
  const sessionId = extra?._meta?.[SESSION_META_KEY];
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new ProjectContextError("session_identity_unavailable");
  }
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}


async function validateProjectRoot(projectRoot, pluginRoot) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw new ProjectContextError("project_root_invalid");
  }
  const resolvedProjectRoot = path.resolve(projectRoot);
  if (isSameOrDescendant(resolvedProjectRoot, pluginRoot)) {
    throw new ProjectContextError("project_root_is_plugin_root");
  }
  try {
    await rejectLinkedSegments(resolvedProjectRoot);
    const metadata = await lstat(resolvedProjectRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ProjectContextError("project_root_invalid");
    }
    await access(resolvedProjectRoot, constants.R_OK);
    const canonicalRoot = await realpath(resolvedProjectRoot);
    if (!samePath(canonicalRoot, resolvedProjectRoot)) {
      throw new ProjectContextError("project_root_invalid");
    }
  } catch (error) {
    if (error instanceof ProjectContextError) throw error;
    throw new ProjectContextError("project_root_invalid");
  }
  return resolvedProjectRoot;
}


async function rejectLinkedSegments(target) {
  const parsed = path.parse(target);
  let current = parsed.root;
  const relative = target.slice(parsed.root.length);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new ProjectContextError("project_root_invalid");
    }
  }
}


function isSameOrDescendant(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}


function samePath(left, right) {
  return normalizePath(left) === normalizePath(right);
}


function normalizePath(value) {
  const normalized = path.resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}


async function serializeBinding(pendingOperations, bindingKey, operation) {
  const previous = pendingOperations.get(bindingKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  pendingOperations.set(bindingKey, current);
  try {
    return await current;
  } finally {
    if (pendingOperations.get(bindingKey) === current) pendingOperations.delete(bindingKey);
  }
}
