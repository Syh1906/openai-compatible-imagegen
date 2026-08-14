export const runtimeFileNames = Object.freeze([
  "artifact_repository.py",
  "image_alpha.py",
  "image_batch.py",
  "image_cli.py",
  "image_download.py",
  "image_emissive_alpha.py",
  "image_mask_alpha.py",
  "image_png.py",
  "image_postprocess.py",
  "image_preview.py",
  "image_qa.py",
  "image_reference.py",
  "image_resize.py",
  "image_response.py",
  "image_transaction.py",
  "image_transparency.py",
  "image_transparency_runtime.py",
  "image_transport.py",
  "image_webp.py",
  "imagegen.py",
  "imagegen_cli.py",
  "mask_policy.py",
  "image_runtime.py",
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
