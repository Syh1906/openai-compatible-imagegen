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
  "network_proxy.py",
  "model-profile-contract.json",
  "model_profiles.py",
  "image_parameters.py",
  "image_provider_requests.py",
  "image_request_options.py",
  "native_image_protocols.py",
  "protocol_contract.py",
  "protocol_xai_images.py",
  "protocol_gemini_interactions.py",
  "protocol_gemini_content.py",
  "protocol_openai_images.py",
  "protocol_atlas_images.py",
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
  "local_image_transfer.py",
  "artifact_repository.py",
  "host_image_import.py",
  "image_delivery.py",
  "image_delivery_ops.py",
  "image_runtime.py",
  "image_transparency_contract.py",
  "mask_policy.py",
  "migrate_image_config.py",
  "posix_repository_fs.py",
  "repository_fs.py",
  "repository_fs_helper.py",
  "reveal_in_explorer.py",
  "windows_repository_fs.py",
]);

export const runtimeFileNames = Object.freeze([
  ...sharedCoreFileNames,
  ...pluginAdapterFileNames,
].sort());

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
  "references/models.md",
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
