import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";

import {
  assertV2StorageBindingCurrent,
  resolveV2StorageBinding,
} from "./config-resolution.mjs";


const PROCESS_BINDING_KEY_SEED = "openai-compatible-imagegen-v2:process-binding";


export class ProjectContextError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProjectContextError";
    this.code = code;
  }
}


export function createProjectContext({
  pluginRoot,
  resolveStorageBinding = resolveV2StorageBinding,
  verifyStorageBinding = assertV2StorageBindingCurrent,
}) {
  if (typeof pluginRoot !== "string" || !path.isAbsolute(pluginRoot)) {
    throw new Error("pluginRoot must be an absolute path");
  }
  const resolvedPluginRoot = path.resolve(pluginRoot);
  let binding = null;
  let pendingBindingOperation = null;
  // MCP tool calls do not include a documented conversation identity; bind once per server process.
  const bindingKey = createHash("sha256")
    .update(`${PROCESS_BINDING_KEY_SEED}:${resolvedPluginRoot}`, "utf8")
    .digest("hex");

  async function serializeBinding(operation) {
    const previous = pendingBindingOperation ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    pendingBindingOperation = current;
    try {
      return await current;
    } finally {
      if (pendingBindingOperation === current) pendingBindingOperation = null;
    }
  }

  return Object.freeze({
    async bind(_extra, { projectRoot }) {
      return await serializeBinding(async () => {
        if (binding) {
          if (
            typeof projectRoot === "string"
            && path.isAbsolute(projectRoot)
            && samePath(binding.projectRoot, projectRoot)
          ) {
            return { status: "already_bound" };
          }
          throw new ProjectContextError("project_binding_conflict");
        }
        const resolvedProjectRoot = await validateProjectRoot(projectRoot, resolvedPluginRoot);
        const storageBinding = await resolveStorageBinding({ projectRoot: resolvedProjectRoot });
        binding = Object.freeze({
          bindingKey,
          projectRoot: resolvedProjectRoot,
          ...storageBinding,
        });
        return { status: "bound" };
      });
    },

    async require(_extra) {
      if (!binding) throw new ProjectContextError("project_binding_required");
      await validateProjectRoot(binding.projectRoot, resolvedPluginRoot);
      await verifyStorageBinding(binding);
      return binding;
    },
  });
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
