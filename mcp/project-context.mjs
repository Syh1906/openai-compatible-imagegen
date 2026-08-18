import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import path from "node:path";

import { pathContainsSymbolicLink } from "./filesystem-path-safety.mjs";
import {
  assertImageConfigBindingCurrent,
  resolveImageConfigBinding,
  userConfigPath,
} from "./config-resolution.mjs";
import {
  createProjectBindingStore,
  ProjectBindingStoreError,
} from "./project-binding-store.mjs";
import { ensureLocalIgnore, LocalIgnoreGuardError } from "./local-ignore-guard.mjs";


const PROJECT_BINDING_KEY_SEED = "openai-compatible-imagegen:project-binding:v1";
const PROJECT_BINDING_ID_PATTERN = /^pbind_[0-9a-f]{64}$/;


export class ProjectContextError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProjectContextError";
    this.code = code;
  }
}


export function createProjectContext({
  pluginRoot,
  stateRoot = path.join(path.dirname(userConfigPath()), "state"),
  resolveConfigBinding = resolveImageConfigBinding,
  verifyConfigBinding = assertImageConfigBindingCurrent,
  prepareArtifactRoot = ensureLocalIgnore,
}) {
  if (typeof pluginRoot !== "string" || !path.isAbsolute(pluginRoot)) {
    throw new Error("pluginRoot must be an absolute path");
  }
  const resolvedPluginRoot = path.resolve(pluginRoot);
  const bindingStore = createProjectBindingStore({ stateRoot });
  const pendingBindingOperations = new Map();

  async function serializeBinding(bindingKey, operation) {
    const previous = pendingBindingOperations.get(bindingKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    pendingBindingOperations.set(bindingKey, current);
    try {
      return await current;
    } finally {
      if (pendingBindingOperations.get(bindingKey) === current) {
        pendingBindingOperations.delete(bindingKey);
      }
    }
  }

  return Object.freeze({
    async bind({ projectRoot, projectBindingId = null }) {
      const requestedBindingId = projectBindingId === null
        ? newProjectBindingId()
        : requireProjectBindingId(projectBindingId);
      const bindingKey = projectBindingKey(requestedBindingId);
      return await serializeBinding(bindingKey, async () => {
        let existing = null;
        try {
          existing = await bindingStore.require(bindingKey);
        } catch (error) {
          if (!(error instanceof ProjectBindingStoreError) || error.code !== "project_binding_missing") {
            throw mapBindingStoreError(error);
          }
          if (projectBindingId !== null) {
            throw new ProjectContextError("project_binding_required");
          }
        }
        if (
          existing
          && (
            typeof projectRoot !== "string"
            || !path.isAbsolute(projectRoot)
            || !samePath(existing.projectRoot, projectRoot)
          )
        ) {
          throw new ProjectContextError("project_binding_conflict");
        }
        const resolvedProjectRoot = await validateProjectRoot(projectRoot, resolvedPluginRoot);
        const configBinding = await resolveConfigBinding({ projectRoot: resolvedProjectRoot });
        try {
          await prepareArtifactRoot(configBinding.artifactRoot);
        } catch (error) {
          if (error instanceof LocalIgnoreGuardError || error?.code === "local_ignore_guard_failed") {
            throw new ProjectContextError("artifact_ignore_write_failed");
          }
          throw error;
        }
        let stored;
        try {
          stored = await bindingStore.bind({
            schemaVersion: "project-binding.v1",
            bindingHash: bindingKey,
            projectRoot: resolvedProjectRoot,
            userConfigSha256: configBinding.userConfigSha256,
            projectConfigSha256: configBinding.projectConfigSha256,
          });
        } catch (error) {
          throw mapBindingStoreError(error);
        }
        return {
          status: stored.status === "created"
            ? "bound"
            : stored.status === "rebound" ? "rebound" : "already_bound",
          projectBindingId: requestedBindingId,
        };
      });
    },

    async require(projectBindingId) {
      const bindingKey = projectBindingKey(requireProjectBindingId(projectBindingId));
      let record;
      try {
        record = await bindingStore.require(bindingKey);
      } catch (error) {
        throw mapBindingStoreError(error);
      }
      const resolvedProjectRoot = await validateProjectRoot(record.projectRoot, resolvedPluginRoot);
      let configBinding;
      try {
        configBinding = await resolveConfigBinding({ projectRoot: resolvedProjectRoot });
      } catch {
        throw new ProjectContextError("image_config_changed");
      }
      if (
        configBinding.userConfigSha256 !== record.userConfigSha256
        || configBinding.projectConfigSha256 !== record.projectConfigSha256
      ) {
        throw new ProjectContextError("image_config_changed");
      }
      const binding = Object.freeze({
          bindingKey,
          projectRoot: resolvedProjectRoot,
          ...configBinding,
        });
      await verifyConfigBinding(binding);
      return binding;
    },
  });
}


function projectBindingKey(projectBindingId) {
  return createHash("sha256")
    .update(`${PROJECT_BINDING_KEY_SEED}\0${projectBindingId}`, "utf8")
    .digest("hex");
}


function newProjectBindingId() {
  return `pbind_${randomBytes(32).toString("hex")}`;
}


function requireProjectBindingId(value) {
  if (typeof value !== "string" || !PROJECT_BINDING_ID_PATTERN.test(value)) {
    throw new ProjectContextError("project_binding_invalid");
  }
  return value;
}


function mapBindingStoreError(error) {
  if (!(error instanceof ProjectBindingStoreError)) return error;
  if (error.code === "project_binding_missing") {
    return new ProjectContextError("project_binding_required");
  }
  if (error.code === "project_binding_conflict") {
    return new ProjectContextError("project_binding_conflict");
  }
  if (error.code === "project_binding_state_invalid") {
    return new ProjectContextError("project_binding_state_invalid");
  }
  return new ProjectContextError("project_binding_unavailable");
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
    if (await pathContainsSymbolicLink(resolvedProjectRoot)) {
      throw new ProjectContextError("project_root_invalid");
    }
    const metadata = await lstat(resolvedProjectRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ProjectContextError("project_root_invalid");
    }
    await access(resolvedProjectRoot, constants.R_OK);
  } catch (error) {
    if (error instanceof ProjectContextError) throw error;
    throw new ProjectContextError("project_root_invalid");
  }
  return resolvedProjectRoot;
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
