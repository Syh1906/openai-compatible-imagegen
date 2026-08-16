import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";


const CONFIG_DIRECTORY = "openai-compatible-imagegen";
const DEFAULT_OUTPUT_DIRECTORY = path.join("output", "imagegen");
const ACTIVE_PROFILE = "primary/gpt-image-2";
const USER_TOP_LEVEL_KEYS = new Set([
  "config_version",
  "active_profile",
  "providers",
  "models",
  "defaults",
  "postprocess",
  "transparency",
  "storage",
]);
const PROJECT_TOP_LEVEL_KEYS = new Set(["config_version", "defaults", "storage"]);
const USER_DEFAULT_KEYS = new Set([
  "size",
  "quality",
  "output_format",
  "timeout_seconds",
  "concurrency",
]);
const PROJECT_DEFAULT_KEYS = new Set(["size", "quality", "output_format"]);
const STORAGE_KEYS = new Set(["output_directory"]);
const PROVIDER_KEYS = new Set([
  "protocol",
  "base_url",
  "api_key",
  "api_key_env",
  "user_agent",
  "url_download",
]);
const MODEL_KEYS = new Set(["provider", "model", "capabilities"]);
const CAPABILITY_KEYS = new Set(["generate", "edit", "mask", "multi_reference"]);
const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_CONCURRENCY = 3;


export class ImageConfigResolutionError extends Error {
  constructor(
    code = "image_config_missing",
    message = "图片配置缺失。请创建用户配置 ~/.codex/openai-compatible-imagegen/config.json。",
  ) {
    super(message);
    this.name = "ImageConfigResolutionError";
    this.code = code;
  }
}


export function userConfigPath(userHome = os.homedir()) {
  return path.resolve(userHome, ".codex", CONFIG_DIRECTORY, "config.json");
}


export function projectConfigPath(projectRoot) {
  return path.resolve(projectRoot, ".codex", CONFIG_DIRECTORY, "config.json");
}


export async function resolveImageConfigBinding({
  projectRoot,
  userHome = os.homedir(),
  readConfigFile = readConfigSnapshot,
}) {
  const resolvedProjectRoot = requireAbsoluteProjectRoot(projectRoot);
  const resolvedProjectConfigPath = projectConfigPath(resolvedProjectRoot);
  const resolvedUserConfigPath = userConfigPath(userHome);

  const projectBytes = await readConfigFile(resolvedProjectConfigPath, {
    required: false,
    invalidCode: "project_config_invalid",
  });
  const projectConfig = projectBytes === null
    ? null
    : parseConfigSnapshot(projectBytes, "project_config_invalid");
  if (projectConfig !== null) validateProjectConfig(projectConfig);

  const userBytes = await readConfigFile(resolvedUserConfigPath, {
    required: true,
    missingCode: "image_config_missing",
    invalidCode: "image_config_invalid",
  });
  const userConfig = parseConfigSnapshot(userBytes, "image_config_invalid");
  validateUserConfig(userConfig);

  const effectiveConfig = mergeEffectiveConfig(userConfig, projectConfig);
  const effectiveConfigJson = JSON.stringify(effectiveConfig);
  const artifactRoot = resolveArtifactRoot(effectiveConfig, resolvedProjectRoot);
  await validateArtifactRoot(artifactRoot, resolvedProjectRoot);
  const defaults = effectiveConfig.defaults || {};

  return Object.freeze({
    userConfigPath: resolvedUserConfigPath,
    userConfigSha256: sha256(userBytes),
    projectConfigPath: resolvedProjectConfigPath,
    projectConfigSha256: projectBytes === null ? null : sha256(projectBytes),
    effectiveConfigJson,
    effectiveConfigSha256: sha256(Buffer.from(effectiveConfigJson, "utf8")),
    activeProfile: ACTIVE_PROFILE,
    runtimeDefaults: Object.freeze({
      timeout_seconds: defaults.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
      concurrency: defaults.concurrency ?? DEFAULT_CONCURRENCY,
    }),
    artifactRoot,
  });
}


export async function assertImageConfigBindingCurrent({
  projectRoot,
  userConfigPath: boundUserConfigPath,
  userConfigSha256,
  projectConfigPath: boundProjectConfigPath,
  projectConfigSha256,
  artifactRoot,
  readConfigFile = readConfigSnapshot,
}) {
  try {
    const resolvedProjectRoot = requireAbsoluteProjectRoot(projectRoot);
    if (!samePath(boundProjectConfigPath, projectConfigPath(resolvedProjectRoot))) {
      throw configChangedError();
    }
    const projectBytes = await readConfigFile(boundProjectConfigPath, {
      required: false,
      invalidCode: "project_config_invalid",
    });
    const currentProjectSha256 = projectBytes === null ? null : sha256(projectBytes);
    if (currentProjectSha256 !== projectConfigSha256) throw configChangedError();

    const userBytes = await readConfigFile(boundUserConfigPath, {
      required: true,
      missingCode: "image_config_missing",
      invalidCode: "image_config_invalid",
    });
    if (sha256(userBytes) !== userConfigSha256) throw configChangedError();
    await validateArtifactRoot(artifactRoot, resolvedProjectRoot);
  } catch (error) {
    if (error?.code === "output_directory_invalid") throw error;
    if (error?.code === "image_config_changed") throw error;
    throw configChangedError();
  }
}


async function readConfigSnapshot(configPath, {
  required,
  missingCode = "image_config_missing",
  invalidCode = "image_config_invalid",
}) {
  try {
    const metadata = await lstat(configPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("unsafe config file");
    const canonicalPath = await realpath(configPath);
    if (!samePath(canonicalPath, configPath)) throw new Error("unsafe config file");
    return await readFile(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (!required) return null;
      throw new ImageConfigResolutionError(missingCode);
    }
    if (error instanceof ImageConfigResolutionError) throw error;
    throw new ImageConfigResolutionError(invalidCode, "图片配置文件无效或不可安全读取。");
  }
}


function parseConfigSnapshot(configBytes, errorCode) {
  try {
    if (!Buffer.isBuffer(configBytes)) throw new Error("config snapshot must be bytes");
    const bomLength = configBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(configBytes.subarray(bomLength));
    const parsed = JSON.parse(decoded);
    if (!isRecord(parsed)) throw new Error("invalid config root");
    return parsed;
  } catch {
    throw new ImageConfigResolutionError(errorCode, "图片配置文件不是有效的 UTF-8 JSON 对象。");
  }
}


function validateUserConfig(config) {
  requireExactKeys(config, USER_TOP_LEVEL_KEYS, "image_config_invalid");
  if (config.config_version !== 1 || config.active_profile !== ACTIVE_PROFILE) {
    throw invalidImageConfigError();
  }
  if (!isRecord(config.providers) || !isRecord(config.models)) throw invalidImageConfigError();

  const model = config.models[ACTIVE_PROFILE];
  if (!isRecord(model)) throw invalidImageConfigError();
  requireExactKeys(model, MODEL_KEYS, "image_config_invalid");
  if (model.model !== "gpt-image-2" || typeof model.provider !== "string") {
    throw invalidImageConfigError();
  }
  const providerId = stripPythonWhitespace(model.provider);
  if (!providerId || providerId !== model.provider) throw invalidImageConfigError();
  const provider = config.providers[providerId];
  validateProvider(provider);
  validateCapabilities(model.capabilities);
  validateDefaults(config.defaults, USER_DEFAULT_KEYS, "image_config_invalid");
  validatePostprocess(config.postprocess);
  validateTransparency(config.transparency);
  validateStorageShape(config.storage, "image_config_invalid");
}


function validateProjectConfig(config) {
  const unknownTopLevel = unknownKeys(config, PROJECT_TOP_LEVEL_KEYS);
  if (unknownTopLevel.length) throw forbiddenProjectConfigError();
  if (config.config_version !== 1) throw invalidProjectConfigError();
  if (config.defaults !== undefined) {
    if (!isRecord(config.defaults)) throw invalidProjectConfigError();
    if (unknownKeys(config.defaults, PROJECT_DEFAULT_KEYS).length) throw forbiddenProjectConfigError();
    validateDefaults(config.defaults, PROJECT_DEFAULT_KEYS, "project_config_invalid");
  }
  if (config.storage !== undefined) {
    if (!isRecord(config.storage)) throw invalidProjectConfigError();
    if (unknownKeys(config.storage, STORAGE_KEYS).length) throw forbiddenProjectConfigError();
    validateStorageShape(config.storage, "project_config_invalid");
  }
}


function validateProvider(provider) {
  if (!isRecord(provider)) throw invalidImageConfigError();
  requireExactKeys(provider, PROVIDER_KEYS, "image_config_invalid");
  if (provider.protocol !== "openai-compatible") throw invalidImageConfigError();
  if (
    typeof provider.base_url !== "string"
    || !isValidBaseUrl(stripPythonWhitespace(provider.base_url).replace(/\/+$/, ""))
  ) {
    throw invalidImageConfigError();
  }
  for (const key of ["api_key", "api_key_env"]) {
    if (provider[key] !== undefined && typeof provider[key] !== "string") throw invalidImageConfigError();
  }
  if (provider.api_key_env !== undefined && provider.api_key_env !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.api_key_env)) {
    throw invalidImageConfigError();
  }
  if (!stripPythonWhitespace(provider.api_key || "") && !stripPythonWhitespace(provider.api_key_env || "")) {
    throw invalidImageConfigError();
  }
  const userAgent = stripPythonWhitespace(String(provider.user_agent || ""));
  if (/[\x00-\x1f\x7f]/.test(userAgent)) throw invalidImageConfigError();
  if (provider.url_download !== undefined) {
    if (!isRecord(provider.url_download)) throw invalidImageConfigError();
    requireExactKeys(provider.url_download, new Set(["proxy_mode"]), "image_config_invalid");
    if (!new Set(["environment", "direct"]).has(provider.url_download.proxy_mode ?? "environment")) {
      throw invalidImageConfigError();
    }
  }
}


function validateCapabilities(value) {
  if (value === undefined) return;
  if (!isRecord(value)) throw invalidImageConfigError();
  requireExactKeys(value, CAPABILITY_KEYS, "image_config_invalid");
  if (Object.values(value).some((declared) => typeof declared !== "boolean")) {
    throw invalidImageConfigError();
  }
}


function validateDefaults(value, allowedKeys, errorCode) {
  if (value === undefined) return;
  if (!isRecord(value) || unknownKeys(value, allowedKeys).length) throw configError(errorCode);
  if (value.size !== undefined && (typeof value.size !== "string" || !/^\d+x\d+$/.test(value.size))) {
    throw configError(errorCode);
  }
  if (value.quality !== undefined && !new Set(["auto", "low", "medium", "high"]).has(value.quality)) {
    throw configError(errorCode);
  }
  if (value.output_format !== undefined && !new Set(["png", "jpeg", "webp"]).has(value.output_format)) {
    throw configError(errorCode);
  }
  if (value.timeout_seconds !== undefined && !integerInRange(value.timeout_seconds, 1, 600)) {
    throw configError(errorCode);
  }
  if (value.concurrency !== undefined && !integerInRange(value.concurrency, 1, 8)) {
    throw configError(errorCode);
  }
}


function validatePostprocess(value) {
  if (value === undefined) return;
  if (!isRecord(value) || unknownKeys(value, new Set(["enabled"])).length) throw invalidImageConfigError();
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw invalidImageConfigError();
}


function validateTransparency(value) {
  if (value === undefined) return;
  if (!isRecord(value)) throw invalidImageConfigError();
  const allowed = new Set(["default_route", "prompt_only_allow", "llm_assisted"]);
  if (unknownKeys(value, allowed).length) throw invalidImageConfigError();
  if (value.default_route !== undefined) {
    const route = String(value.default_route || "chroma-matting").trim().toLowerCase();
    if (!new Set(["chroma-matting", "emissive-alpha", "mask-alpha"]).has(route)) throw invalidImageConfigError();
  }
  if (value.prompt_only_allow !== undefined) {
    if (!Array.isArray(value.prompt_only_allow)) throw invalidImageConfigError();
    const seen = new Set();
    for (const item of value.prompt_only_allow) {
      if (!isRecord(item) || unknownKeys(item, new Set(["model", "mode", "size"])).length) throw invalidImageConfigError();
      const model = typeof item.model === "string" ? item.model.trim() : "";
      const mode = typeof item.mode === "string" ? item.mode.trim().toLowerCase() : "";
      const size = typeof item.size === "string" ? item.size.trim().toLowerCase().replace("*", "x") : "";
      if (!model || !new Set(["generate", "edit"]).has(mode) || !/^\d+x\d+$/.test(size)) throw invalidImageConfigError();
      const key = `${model}\0${mode}\0${size}`;
      if (seen.has(key)) throw invalidImageConfigError();
      seen.add(key);
    }
  }
  if (value.llm_assisted !== undefined) {
    if (!isRecord(value.llm_assisted)) throw invalidImageConfigError();
    const allowedLlm = new Set(["enabled", "max_attempts", "allow_parameter_tuning", "allow_route_change", "allow_api_retry"]);
    if (unknownKeys(value.llm_assisted, allowedLlm).length) throw invalidImageConfigError();
    if (value.llm_assisted.enabled !== undefined && typeof value.llm_assisted.enabled !== "boolean") throw invalidImageConfigError();
    if (value.llm_assisted.max_attempts !== undefined && !integerInRange(value.llm_assisted.max_attempts, 1, 3)) throw invalidImageConfigError();
    for (const key of ["allow_parameter_tuning", "allow_route_change", "allow_api_retry"]) {
      if (value.llm_assisted[key] !== undefined && typeof value.llm_assisted[key] !== "boolean") throw invalidImageConfigError();
    }
  }
}


function validateStorageShape(value, errorCode) {
  if (value === undefined) return;
  if (!isRecord(value) || unknownKeys(value, STORAGE_KEYS).length) throw configError(errorCode);
  if (
    value.output_directory !== undefined
    && (
      typeof value.output_directory !== "string"
      || value.output_directory.trim() !== value.output_directory
      || !value.output_directory
    )
  ) {
    throw outputDirectoryError();
  }
}


function mergeEffectiveConfig(userConfig, projectConfig) {
  const effective = structuredClone(userConfig);
  if (projectConfig?.defaults) {
    effective.defaults = { ...(effective.defaults || {}), ...projectConfig.defaults };
  }
  if (projectConfig?.storage) {
    effective.storage = { ...(effective.storage || {}), ...projectConfig.storage };
  }
  return effective;
}


function resolveArtifactRoot(config, projectRoot) {
  const configured = config.storage?.output_directory ?? DEFAULT_OUTPUT_DIRECTORY;
  if (typeof configured !== "string" || path.isAbsolute(configured)) throw outputDirectoryError();
  try {
    return path.resolve(projectRoot, configured);
  } catch {
    throw outputDirectoryError();
  }
}


async function validateArtifactRoot(artifactRoot, projectRoot) {
  const relative = path.relative(projectRoot, artifactRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw outputDirectoryError();
  let current = projectRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw outputDirectoryError();
      const canonicalPath = await realpath(current);
      if (!samePath(canonicalPath, current)) throw outputDirectoryError();
    } catch (error) {
      if (error?.code === "ENOENT") break;
      if (error instanceof ImageConfigResolutionError) throw error;
      throw outputDirectoryError();
    }
  }
}


function requireAbsoluteProjectRoot(projectRoot) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) throw outputDirectoryError();
  return path.resolve(projectRoot);
}


function requireExactKeys(value, allowed, errorCode) {
  if (unknownKeys(value, allowed).length) throw configError(errorCode);
}


function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.has(key));
}


function configError(code) {
  if (code === "project_config_invalid") return invalidProjectConfigError();
  return invalidImageConfigError();
}


function outputDirectoryError() {
  return new ImageConfigResolutionError(
    "output_directory_invalid",
    "输出目录必须是图片项目内的安全相对目录。",
  );
}


function invalidImageConfigError() {
  return new ImageConfigResolutionError(
    "image_config_invalid",
    "用户图片配置缺少有效的版本、活动档案、provider 或 model 声明。",
  );
}


function invalidProjectConfigError() {
  return new ImageConfigResolutionError(
    "project_config_invalid",
    "项目图片配置不是有效的安全覆盖。",
  );
}


function forbiddenProjectConfigError() {
  return new ImageConfigResolutionError(
    "project_config_forbidden",
    "项目图片配置只能覆盖 size、quality、output_format 和 storage.output_directory。",
  );
}


function configChangedError() {
  return new ImageConfigResolutionError(
    "image_config_changed",
    "图片配置在项目绑定后发生变化，请重新显式绑定当前图片项目。",
  );
}


function isValidBaseUrl(value) {
  if (!/^https?:\/\/[^/]/i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return new Set(["http:", "https:"]).has(parsed.protocol) && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}


function stripPythonWhitespace(value) {
  return String(value)
    .replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u, "")
    .replace(/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/u, "");
}


function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}


function integerInRange(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}


function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}


function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const normalize = (value) => path.resolve(value).replaceAll("\\", "/");
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
