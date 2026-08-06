import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";


const CONFIG_DIRECTORY = "openai-compatible-imagegen-v2";

export class V2ConfigResolutionError extends Error {
  constructor() {
    super(
      "V2 配置缺失。请创建用户配置 ~/.codex/openai-compatible-imagegen-v2/config.json，"
      + "或项目配置 <项目根>/.codex/openai-compatible-imagegen-v2/config.json。",
    );
    this.name = "V2ConfigResolutionError";
    this.code = "v2_config_missing";
  }
}

export function userConfigPath(userHome = os.homedir()) {
  return path.resolve(userHome, ".codex", CONFIG_DIRECTORY, "config.json");
}

export function projectConfigPath(projectRoot) {
  return path.resolve(projectRoot, ".codex", CONFIG_DIRECTORY, "config.json");
}

export async function resolveV2ConfigPath({ projectRoot, userHome = os.homedir() }) {
  const candidates = [userConfigPath(userHome), projectConfigPath(projectRoot)];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new V2ConfigResolutionError();
}
