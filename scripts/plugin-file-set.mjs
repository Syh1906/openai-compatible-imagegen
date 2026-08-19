export const sharedCoreFileNames = Object.freeze([
  "image_alpha.py",
  "image_download.py",
  "image_emissive_alpha.py",
  "image_mask_alpha.py",
  "image_png.py",
  "image_preview.py",
  "image_qa.py",
  "image_resize.py",
  "image_response.py",
  "image_transaction.py",
  "image_transparency.py",
  "image_transport.py",
  "image_webp.py",
  "provider_config.py",
]);

export const standaloneAdapterFileNames = Object.freeze([
  "image_batch.py",
  "image_cli.py",
  "image_postprocess.py",
  "image_reference.py",
  "image_transparency_runtime.py",
  "imagegen.py",
]);

export const standaloneRuntimeFileNames = Object.freeze([
  ...sharedCoreFileNames,
  ...standaloneAdapterFileNames,
].sort());

export const pluginAdapterFileNames = Object.freeze([
  "artifact_repository.py",
  "image_delivery.py",
  "image_delivery_ops.py",
  "image_runtime.py",
  "image_transparency_contract.py",
  "imagegen_cli.py",
  "mask_policy.py",
  "migrate_image_config.py",
  "posix_repository_fs.py",
  "repository_fs.py",
  "repository_fs_helper.py",
  "reveal_in_explorer.py",
  "windows_repository_fs.py",
]);

export const runtimeFileNames = Object.freeze([
  "artifact_repository.py",
  "image_alpha.py",
  "image_batch.py",
  "image_cli.py",
  "image_delivery.py",
  "image_delivery_ops.py",
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
  "image_transparency_contract.py",
  "image_transparency_runtime.py",
  "image_transport.py",
  "image_webp.py",
  "imagegen.py",
  "imagegen_cli.py",
  "mask_policy.py",
  "image_runtime.py",
  "migrate_image_config.py",
  "posix_repository_fs.py",
  "provider_config.py",
  "repository_fs.py",
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

export const standaloneReleaseFiles = Object.freeze([
  ".gitignore",
  "LICENSE",
  "SKILL.md",
  "agents/openai.yaml",
  "examples/auth.example.json",
  "examples/batch.example.jsonl",
  "references/parameters.md",
  "references/postprocess.md",
  "references/prompting.md",
  "references/qa.md",
  ...standaloneRuntimeFileNames.map((name) => `scripts/${name}`),
  "scripts/quick-init.py",
].sort());

export const pluginReleaseFiles = Object.freeze([
  ".agents/plugins/marketplace.json",
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "LICENSE",
  "assets/icon.png",
  ...distributionFiles.map((name) => `dist/${name}`),
  "skills/openai-compatible-imagegen/SKILL.md",
  "skills/openai-compatible-imagegen/references/config.example.json",
].sort());

export const releaseTopLevelEntries = Object.freeze([
  ".codex-plugin",
  ".mcp.json",
  "LICENSE",
  "assets",
  "dist",
  "skills",
].sort());

export function releaseEntriesFor(pluginId) {
  return Object.freeze([
    ".codex-plugin",
    ".mcp.json",
    "LICENSE",
    "assets",
    "dist",
    `skills/${pluginId}`,
  ]);
}
