export const runtimeFileNames = Object.freeze([
  "imagegen.py",
  "imagegen_cli.py",
  "artifact_repository.py",
  "image_download.py",
  "mask_policy.py",
  "provider_config.py",
  "repository_fs_helper.py",
  "reveal_in_explorer.py",
  "windows_repository_fs.py",
]);

export const distributionFiles = Object.freeze([
  ...runtimeFileNames.map((name) => `scripts/${name}`),
  "server.mjs",
  "widget/index.html",
].sort());

export const runtimeDistributionPaths = Object.freeze(
  runtimeFileNames.map((name) => `dist/scripts/${name}`),
);

export const releaseTopLevelEntries = Object.freeze([
  ".codex-plugin",
  ".mcp.json",
  "LICENSE",
  "dist",
  "skills",
].sort());

export function releaseEntriesFor(pluginId) {
  return Object.freeze([
    ".codex-plugin",
    ".mcp.json",
    "LICENSE",
    "dist",
    `skills/${pluginId}`,
  ]);
}
