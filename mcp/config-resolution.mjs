import { createHash } from "node:crypto";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";


const CONFIG_DIRECTORY = "openai-compatible-imagegen-v2";
const DEFAULT_OUTPUT_DIRECTORY = path.join("output", "imagegen");

export class V2ConfigResolutionError extends Error {
  constructor(
    code = "v2_config_missing",
    message = "V2 配置缺失。请创建用户配置 ~/.codex/openai-compatible-imagegen-v2/config.json，"
      + "或项目配置 <项目根>/.codex/openai-compatible-imagegen-v2/config.json。",
  ) {
    super(message);
    this.name = "V2ConfigResolutionError";
    this.code = code;
  }
}

export function userConfigPath(userHome = os.homedir()) {
  return path.resolve(userHome, ".codex", CONFIG_DIRECTORY, "config.json");
}

export function projectConfigPath(projectRoot) {
  return path.resolve(projectRoot, ".codex", CONFIG_DIRECTORY, "config.json");
}

export async function resolveV2ConfigPath({ projectRoot, userHome = os.homedir(), accessFile = access }) {
  const candidates = [userConfigPath(userHome), projectConfigPath(projectRoot)];
  for (const candidate of candidates) {
    try {
      await accessFile(candidate);
      return candidate;
    } catch (error) {
      if (error?.code === "EACCES" || error?.code === "EPERM") {
        throw new V2ConfigResolutionError(
          "v2_config_invalid",
          "V2 配置文件存在，但无法安全读取。",
        );
      }
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new V2ConfigResolutionError();
}


export async function resolveV2StorageBinding({ projectRoot, userHome = os.homedir() }) {
  const resolvedProjectRoot = requireAbsoluteProjectRoot(projectRoot);
  const configPath = await resolveV2ConfigPath({ projectRoot: resolvedProjectRoot, userHome });
  const configBytes = await readConfigSnapshot(configPath);
  const config = parseConfigSnapshot(configBytes);
  validateV2RuntimeConfig(config);
  const artifactRoot = resolveArtifactRoot(config, resolvedProjectRoot);
  await validateArtifactRoot(artifactRoot, resolvedProjectRoot);
  return Object.freeze({
    configPath,
    configSha256: createHash("sha256").update(configBytes).digest("hex"),
    artifactRoot,
  });
}


export async function assertV2StorageBindingCurrent({
  projectRoot,
  configPath,
  configSha256,
  artifactRoot,
}) {
  try {
    const configBytes = await readConfigSnapshot(configPath);
    const currentSha256 = createHash("sha256").update(configBytes).digest("hex");
    if (currentSha256 !== configSha256) throw configChangedError();
    await validateArtifactRoot(artifactRoot, requireAbsoluteProjectRoot(projectRoot));
  } catch (error) {
    if (error?.code === "output_directory_invalid") throw error;
    if (error?.code === "v2_config_changed") throw error;
    throw configChangedError();
  }
}


async function readConfigSnapshot(configPath) {
  try {
    const metadata = await lstat(configPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("unsafe config file");
    const canonicalPath = await realpath(configPath);
    if (!samePath(canonicalPath, configPath)) throw new Error("unsafe config file");
    return await readFile(configPath);
  } catch (error) {
    if (error instanceof V2ConfigResolutionError) throw error;
    throw new V2ConfigResolutionError("v2_config_invalid", "V2 配置文件无效或不可安全读取。");
  }
}


function parseConfigSnapshot(configBytes) {
  try {
    const bomLength = configBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(configBytes.subarray(bomLength));
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid config root");
    return parsed;
  } catch {
    throw new V2ConfigResolutionError("v2_config_invalid", "V2 配置文件不是有效的 JSON 对象。");
  }
}


function validateV2RuntimeConfig(config) {
  const providers = config.providers;
  const models = config.models;
  if (!isRecord(providers) || !isRecord(models)) throw invalidV2ConfigError();

  const profile = models["primary/gpt-image-2"];
  if (!isRecord(profile) || profile.model !== "gpt-image-2") throw invalidV2ConfigError();
  if (typeof profile.provider !== "string" || !profile.provider) throw invalidV2ConfigError();

  const providerId = stripPythonWhitespace(profile.provider);
  if (!providerId) throw invalidV2ConfigError();
  const provider = providers[providerId];
  if (!isRecord(provider) || provider.protocol !== "openai-compatible") throw invalidV2ConfigError();
  if (
    typeof provider.base_url !== "string"
    || !isValidBaseUrl(stripPythonWhitespace(provider.base_url).replace(/\/+$/, ""))
  ) throw invalidV2ConfigError();

  const urlDownload = provider.url_download;
  if (urlDownload !== undefined) {
    if (!isRecord(urlDownload)) throw invalidV2ConfigError();
    const proxyMode = Object.hasOwn(urlDownload, "proxy_mode")
      ? urlDownload.proxy_mode
      : "environment";
    if (proxyMode !== "environment" && proxyMode !== "direct") throw invalidV2ConfigError();
  }

  const userAgent = stripPythonWhitespace(String(provider.user_agent || ""));
  if (/[\x00-\x1f\x7f]/.test(userAgent)) throw invalidV2ConfigError();
}


function isValidBaseUrl(value) {
  if (!/^https?:\/\/[^/]/i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}


function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}


function stripPythonWhitespace(value) {
  return value
    .replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u, "")
    .replace(/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/u, "");
}


function resolveArtifactRoot(config, projectRoot) {
  const storage = config.storage;
  if (storage !== undefined && (!storage || typeof storage !== "object" || Array.isArray(storage))) {
    throw outputDirectoryError();
  }
  const configured = storage?.output_directory;
  if (configured === undefined) return path.join(projectRoot, DEFAULT_OUTPUT_DIRECTORY);
  if (typeof configured !== "string" || configured.trim() !== configured || !configured) {
    throw outputDirectoryError();
  }
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
      if (error instanceof V2ConfigResolutionError) throw error;
      throw outputDirectoryError();
    }
  }
}


function requireAbsoluteProjectRoot(projectRoot) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw outputDirectoryError();
  }
  return path.resolve(projectRoot);
}


function outputDirectoryError() {
  return new V2ConfigResolutionError(
    "output_directory_invalid",
    "V2 输出目录必须是图片项目内的安全目录。",
  );
}


function invalidV2ConfigError() {
  return new V2ConfigResolutionError(
    "v2_config_invalid",
    "V2 配置缺少有效的 primary/gpt-image-2 provider 或 model 声明。",
  );
}


function configChangedError() {
  return new V2ConfigResolutionError(
    "v2_config_changed",
    "V2 配置在项目绑定后发生变化，请重启 MCP server 并重新绑定项目。",
  );
}


function samePath(left, right) {
  const normalize = (value) => path.resolve(value).replaceAll("\\", "/");
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
