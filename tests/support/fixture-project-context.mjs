import { createHash } from "node:crypto";
import path from "node:path";


const EFFECTIVE_CONFIG = Object.freeze({
  config_version: 1,
  active_profile: "primary/gpt-image-2",
  providers: {
    primary: {
      protocol: "openai-compatible",
      base_url: "https://example.test/v1",
      api_key_env: "IMAGEGEN_TEST_API_KEY",
    },
  },
  models: {
    "primary/gpt-image-2": {
      provider: "primary",
      model: "gpt-image-2",
      capabilities: { generate: true, edit: true, mask: true, multi_reference: true },
    },
  },
  defaults: { size: "1024x1024", quality: "low", output_format: "png" },
});
export const FIXTURE_PROJECT_BINDING_ID = `pbind_${"b".repeat(64)}`;


export function createFixtureProjectContext({
  projectRoot,
  artifactRoot = path.join(projectRoot, "output", "imagegen"),
  bindingKey = "f".repeat(64),
} = {}) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw new Error("fixture projectRoot must be absolute");
  }
  const expectedProjectRoot = path.resolve(projectRoot);
  const effectiveConfigJson = JSON.stringify(EFFECTIVE_CONFIG);
  const context = Object.freeze({
    bindingKey,
    projectRoot: expectedProjectRoot,
    artifactRoot: path.resolve(artifactRoot),
    userConfigPath: path.join(expectedProjectRoot, ".fixture-user-config.json"),
    userConfigSha256: "1".repeat(64),
    projectConfigPath: path.join(expectedProjectRoot, ".fixture-project-config.json"),
    projectConfigSha256: null,
    effectiveConfigJson,
    effectiveConfigSha256: sha256(effectiveConfigJson),
    activeProfile: "primary/gpt-image-2",
    runtimeDefaults: Object.freeze({ timeout_seconds: 600, concurrency: 3 }),
  });
  let bound = false;

  return Object.freeze({
    async bind({ projectRoot: candidateRoot, projectBindingId = null }) {
      if (path.resolve(candidateRoot) !== expectedProjectRoot) throw contextError("project_root_invalid");
      if (projectBindingId !== null && projectBindingId !== FIXTURE_PROJECT_BINDING_ID) {
        throw contextError("project_binding_required");
      }
      if (bound) return { status: "already_bound", projectBindingId: FIXTURE_PROJECT_BINDING_ID };
      bound = true;
      return { status: "bound", projectBindingId: FIXTURE_PROJECT_BINDING_ID };
    },
    async require(projectBindingId) {
      if (!bound || projectBindingId !== FIXTURE_PROJECT_BINDING_ID) {
        throw contextError("project_binding_required");
      }
      return context;
    },
  });
}


function contextError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}


function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
