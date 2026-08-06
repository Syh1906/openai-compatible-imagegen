import { access, readFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_ID = "openai-compatible-imagegen-v2";
const APP_ONLY_TOOLS = [
  "finalize_image_editor_session",
  "get_image_editor_session",
  "open_image_editor",
  "read_image_artifact_data",
  "save_image_annotations",
];
const REMOTE_SMOKE_GENERATE_PROMPT = "A single solid red circle centered on a plain white background, no text.";
const REMOTE_SMOKE_EDIT_PROMPT = "Change the circle from red to blue. Keep the plain white background and add no text.";
const CONSISTENCY_PATHS = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  `skills/${PLUGIN_ID}/SKILL.md`,
  "dist/server.mjs",
  "dist/widget/index.html",
  "dist/scripts/imagegen.py",
  "dist/scripts/artifact_repository.py",
  "dist/scripts/image_download.py",
  "dist/scripts/provider_config.py",
];

function parseOptions(args) {
  const options = {
    pluginRoot: defaultRoot,
    projectRoot: process.cwd(),
    sourceRoot: null,
    marketplacePath: null,
    imageIds: [],
    remoteSmoke: false,
    annotationSmoke: false,
  };
  const valueOptions = new Map([
    ["--plugin-root", "pluginRoot"],
    ["--project-root", "projectRoot"],
    ["--source-root", "sourceRoot"],
    ["--marketplace-path", "marketplacePath"],
    ["--image-id", "imageIds"],
  ]);
  for (let index = 0; index < args.length;) {
    const option = args[index];
    if (option === "--remote-smoke") {
      options.remoteSmoke = true;
      index += 1;
      continue;
    }
    if (option === "--annotation-smoke") {
      options.annotationSmoke = true;
      index += 1;
      continue;
    }
    const key = valueOptions.get(option);
    const value = args[index + 1];
    if (!key || !value) {
      throw new Error(
        "usage: node scripts/probe-plugin.mjs "
        + "[--plugin-root <path>] [--project-root <path>] "
        + "[--source-root <path>] [--marketplace-path <path>] "
        + "[--image-id <id>]... [--remote-smoke] [--annotation-smoke]",
      );
    }
    if (key === "imageIds") options.imageIds.push(value);
    else options[key] = path.resolve(value);
    index += 2;
  }
  return options;
}

const {
  pluginRoot,
  projectRoot,
  sourceRoot,
  marketplacePath,
  imageIds,
  remoteSmoke,
  annotationSmoke,
} = parseOptions(process.argv.slice(2));
const resolvePath = (...parts) => path.resolve(pluginRoot, ...parts);

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function requireRemoteSmokeRoot(root) {
  const absoluteRoot = path.resolve(root);
  requireValue(
    path.basename(absoluteRoot) === "smoke"
      && path.basename(path.dirname(absoluteRoot)) === ".local",
    "--remote-smoke requires a project root ending in .local/smoke",
  );
}

function requireSafeToolResults(results, root) {
  const safeResult = results.map((result) => ({
    content: result.content?.filter((item) => item.type !== "image"),
    structuredContent: result.structuredContent,
    meta: result._meta,
  }));
  const text = JSON.stringify(safeResult);
  requireValue(!text.includes(path.resolve(root)), "remote smoke result exposed the project root");
  requireValue(!/authorization|api[_-]?key|config\.json/i.test(text), "remote smoke result exposed configuration or auth fields");
}

async function readJson(path) {
  return JSON.parse(await readFile(resolvePath(path), "utf8"));
}

async function readOptionalJson(relativePath) {
  try {
    return await readJson(relativePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function resolveMarketplaceSource(catalogPath) {
  const absoluteCatalogPath = path.resolve(catalogPath);
  const catalogDirectory = path.dirname(absoluteCatalogPath);
  requireValue(
    path.basename(catalogDirectory) === "plugins"
      && path.basename(path.dirname(catalogDirectory)) === ".agents",
    "marketplace path must be under <root>/.agents/plugins/marketplace.json",
  );
  const catalog = JSON.parse(await readFile(absoluteCatalogPath, "utf8"));
  const entries = catalog.plugins?.filter((entry) => entry.name === PLUGIN_ID) ?? [];
  requireValue(entries.length === 1, `marketplace must contain exactly one ${PLUGIN_ID} entry`);
  const entry = entries[0];
  requireValue(entry.source?.source === "local", "marketplace plugin source must be local");
  requireValue(typeof entry.source.path === "string", "marketplace plugin source path is missing");

  const marketplaceRoot = path.resolve(catalogDirectory, "..", "..");
  const marketplacePluginRoot = path.resolve(marketplaceRoot, entry.source.path);
  const metadata = await stat(marketplacePluginRoot).catch(() => null);
  requireValue(metadata?.isDirectory() === true, "marketplace plugin source path does not exist or is not a directory");
  requireValue(
    path.resolve(pluginRoot) === marketplacePluginRoot,
    `plugin root does not match marketplace source: ${marketplacePluginRoot}`,
  );
  return {
    marketplacePath: absoluteCatalogPath,
    marketplaceRoot,
    marketplacePluginRoot,
  };
}

async function hashFile(root, relativePath) {
  const content = await readFile(path.resolve(root, relativePath));
  return createHash("sha256").update(content).digest("hex");
}

async function compareSource() {
  if (!sourceRoot) {
    return { sourceConsistent: null, sourceMismatches: [] };
  }
  const comparisons = await Promise.all(CONSISTENCY_PATHS.map(async (relativePath) => {
    try {
      const [installedHash, sourceHash] = await Promise.all([
        hashFile(pluginRoot, relativePath),
        hashFile(sourceRoot, relativePath),
      ]);
      return installedHash === sourceHash ? null : relativePath;
    } catch {
      return relativePath;
    }
  }));
  const sourceMismatches = comparisons.filter(Boolean);
  return { sourceConsistent: sourceMismatches.length === 0, sourceMismatches };
}

async function requireCleanDistribution() {
  const entries = await readdir(resolvePath("dist/scripts"), { recursive: true, withFileTypes: true });
  const forbidden = entries
    .filter((entry) => entry.name === "__pycache__" || entry.name.endsWith(".pyc"))
    .map((entry) => entry.name);
  requireValue(forbidden.length === 0, `distribution contains Python bytecode cache: ${forbidden.join(", ")}`);
}

async function main() {
  if (remoteSmoke) requireRemoteSmokeRoot(projectRoot);
  if (annotationSmoke) {
    requireRemoteSmokeRoot(projectRoot);
    requireValue(imageIds.length > 0, "--annotation-smoke requires at least one --image-id");
  }
  const manifest = await readJson(".codex-plugin/plugin.json");
  const marketplace = marketplacePath ? await resolveMarketplaceSource(marketplacePath) : null;
  requireValue(manifest.name === PLUGIN_ID, "unexpected plugin name");
  const packageManifest = await readOptionalJson("package.json");
  const packageLock = await readOptionalJson("package-lock.json");
  if (packageManifest) {
    requireValue(packageManifest.name === manifest.name, "package name differs from plugin name");
    requireValue(packageManifest.version === manifest.version, "package version differs from plugin version");
  }
  if (packageLock) {
    requireValue(packageLock.name === manifest.name, "package lock name differs from plugin name");
    requireValue(packageLock.version === manifest.version, "package lock version differs from plugin version");
    requireValue(packageLock.packages?.[""]?.name === manifest.name, "package lock root name differs from plugin name");
    requireValue(packageLock.packages?.[""]?.version === manifest.version, "package lock root version differs from plugin version");
  }
  await requireCleanDistribution();
  const sourceComparison = await compareSource();
  requireValue(sourceComparison.sourceConsistent !== false, `installed plugin differs from source: ${sourceComparison.sourceMismatches.join(", ")}`);

  const mcp = await readJson(".mcp.json");
  const server = mcp.mcpServers?.[manifest.name];
  const serverText = await readFile(resolvePath("dist/server.mjs"), "utf8");

  requireValue(serverText.includes(`version: \"${manifest.version}\"`), "prebuilt server version differs");
  requireValue(manifest.skills === "./skills/", "manifest skills path is invalid");
  requireValue(manifest.mcpServers === "./.mcp.json", "manifest MCP path is invalid");
  requireValue(server?.command === "node", "MCP server command must be node");
  requireValue(server?.args?.[0] === "dist/server.mjs", "MCP server must use the prebuilt entry");

  await Promise.all([
    access(resolvePath("dist/server.mjs"), constants.R_OK),
    access(resolvePath("dist/widget/index.html"), constants.R_OK),
    access(resolvePath(`skills/${PLUGIN_ID}/SKILL.md`), constants.R_OK),
  ]);

  const widget = await readFile(resolvePath("dist/widget/index.html"), "utf8");
  requireValue(widget.includes("open_image_editor"), "widget is not bound to open_image_editor");
  requireValue(!widget.includes("open_image_workspace"), "widget still exposes the removed workspace entry");

  const client = new Client({ name: "plugin-probe", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolvePath(server.args[0])],
    cwd: projectRoot,
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const [toolResult, resourceResult, resourceTemplateResult, invalidCall] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listResourceTemplates(),
      client.callTool({ name: "open_image_editor", arguments: {} }),
    ]);
    const tools = toolResult.tools.map((tool) => tool.name).sort();
    const appOnlyTools = toolResult.tools
      .filter((tool) => tool._meta?.ui?.visibility?.includes("app"))
      .map((tool) => tool.name)
      .sort();
    const resources = resourceResult.resources.map((resource) => resource.uri).sort();
    const resourceTemplates = resourceTemplateResult.resourceTemplates.map((resource) => resource.uriTemplate).sort();

    requireValue(tools.includes("open_image_editor"), "MCP server does not expose open_image_editor");
    requireValue(tools.includes("generate_image"), "MCP server does not expose generate_image");
    requireValue(tools.includes("edit_image"), "MCP server does not expose edit_image");
    requireValue(tools.includes("get_image_artifact"), "MCP server does not expose get_image_artifact");
    requireValue(tools.includes("read_image_artifact_data"), "MCP server does not expose read_image_artifact_data");
    requireValue(tools.includes("destroy_image_editor"), "MCP server does not expose destroy_image_editor");
    requireValue(tools.includes("get_image_editor_session"), "MCP server does not expose get_image_editor_session");
    requireValue(tools.includes("finalize_image_editor_session"), "MCP server does not expose finalize_image_editor_session");
    requireValue(tools.includes("save_image_annotations"), "MCP server does not expose save_image_annotations");
    requireValue(tools.includes("list_image_models"), "MCP server does not expose list_image_models");
    requireValue(
      JSON.stringify(appOnlyTools) === JSON.stringify(APP_ONLY_TOOLS),
      `unexpected app-only tool visibility: ${appOnlyTools.join(", ")}`,
    );
    requireValue(resources.includes(`ui://${PLUGIN_ID}/editor.html`), "MCP server does not expose the image editor resource");
    requireValue(
      !resourceTemplates.includes("imagegen://artifact/{imageId}"),
      "MCP server still exposes the unsupported widget image resource template",
    );
    const missingImageIdRejected = invalidCall.isError === true;
    requireValue(missingImageIdRejected, "open_image_editor accepted a missing image ID");
    let artifactRead = null;
    let artifactReads = [];
    let modelCatalog = null;
    let resultRender = null;
    let remoteSmokeResult = null;
    let annotationSmokeResult = null;
    let editorLifecycle = null;
    if (imageIds.length || remoteSmoke) {
      const modelResult = await client.callTool({ name: "list_image_models", arguments: {} });
      const modelIds = (modelResult.structuredContent?.models ?? []).map((model) => model.id);
      requireValue(modelResult.isError !== true, "list_image_models failed");
      requireValue(
        JSON.stringify(modelIds) === JSON.stringify(["primary/gpt-image-2"]),
        `unexpected image model catalog: ${modelIds.join(", ")}`,
      );
      modelCatalog = modelIds;
    }

    if (imageIds.length) {
      for (const currentImageId of imageIds) {
        const artifactResult = await client.callTool({
          name: "get_image_artifact",
          arguments: { imageId: currentImageId },
        });
        requireValue(artifactResult.isError !== true, `get_image_artifact failed for ${currentImageId}`);
        requireValue(
          artifactResult.content.some((item) => item.type === "image"),
          `get_image_artifact returned no image for ${currentImageId}`,
        );
      }
      artifactReads = [...imageIds];
      artifactRead = imageIds[0];

      const renderResult = await client.callTool({
        name: "render_image_results",
        arguments: { imageIds },
      });
      const renderedImages = renderResult.content.filter((item) => item.type === "image");
      const renderedArtifacts = renderResult.structuredContent?.artifacts ?? [];
      requireValue(renderResult.isError !== true, `render_image_results failed for ${imageIds.join(", ")}`);
      requireValue(
        renderedImages.length === imageIds.length,
        `render_image_results returned ${renderedImages.length} images for ${imageIds.length} IDs`,
      );
      requireValue(
        JSON.stringify(renderResult.structuredContent?.imageIds) === JSON.stringify(imageIds)
          && JSON.stringify(renderedArtifacts.map((artifact) => artifact.id)) === JSON.stringify(imageIds),
        "render_image_results did not preserve the requested image order",
      );
      const renderedResources = await readArtifactData(client, renderedArtifacts, renderedImages);
      resultRender = {
        imageIds: renderResult.structuredContent.imageIds,
        imageCount: renderedImages.length,
        artifactCount: renderedArtifacts.length,
        resourceCount: renderedResources.length,
      };

      if (annotationSmoke) {
        const annotationResult = await client.callTool({
          name: "save_image_annotations",
          arguments: {
            imageId: imageIds[0],
            items: [{
              id: "smoke-rectangle",
              type: "rectangle",
              x: 0.15,
              y: 0.15,
              width: 0.7,
              height: 0.7,
              text: "Change the marked area while preserving the surrounding background.",
              color: "#ef4444",
              strokeWidth: 3,
            }],
          },
        });
        const annotation = annotationResult.structuredContent?.annotation;
        requireValue(annotationResult.isError !== true && annotation?.id, "annotation smoke save failed");
        requireValue(
          annotation.imageId === imageIds[0] && annotation.itemCount === 1,
          "annotation smoke returned invalid metadata",
        );
        requireSafeToolResults([annotationResult], projectRoot);
        annotationSmokeResult = {
          annotationId: annotation.id,
          imageId: annotation.imageId,
          itemCount: annotation.itemCount,
        };
      }

      const imageId = imageIds[0];
      const openResult = await client.callTool({ name: "open_image_editor", arguments: { imageId } });
      const session = openResult.structuredContent?.editorSession;
      requireValue(openResult.isError !== true && session?.id, `open_image_editor failed for ${imageId}`);
      requireValue(session.imageId === imageId && session.status === "active", "open_image_editor returned an invalid session");
      const activeResult = await client.callTool({ name: "get_image_editor_session", arguments: { editorSessionId: session.id } });
      requireValue(activeResult.structuredContent?.editorSession?.status === "active", "editor session was not active after open");
      const destroyResult = await client.callTool({ name: "destroy_image_editor", arguments: { editorSessionId: session.id } });
      requireValue(destroyResult.structuredContent?.editorSession?.status === "destroyed", "editor session was not destroyed");
      const destroyedResult = await client.callTool({ name: "get_image_editor_session", arguments: { editorSessionId: session.id } });
      requireValue(destroyedResult.structuredContent?.editorSession?.status === "destroyed", "destroyed editor session was not observable");
      const finalizeResult = await client.callTool({ name: "finalize_image_editor_session", arguments: { editorSessionId: session.id } });
      requireValue(finalizeResult.structuredContent?.editorSession?.status === "released", "editor session was not released");
      const repeatedFinalize = await client.callTool({ name: "finalize_image_editor_session", arguments: { editorSessionId: session.id } });
      requireValue(repeatedFinalize.structuredContent?.editorSession?.status === "released", "editor session release was not idempotent");
      editorLifecycle = "released";
    }

    if (remoteSmoke) {
      const generateResult = await client.callTool({
        name: "generate_image",
        arguments: {
          prompt: REMOTE_SMOKE_GENERATE_PROMPT,
          count: 1,
          quality: "low",
          size: "1024x1024",
          format: "png",
        },
      });
      const generated = generateResult.structuredContent?.artifacts?.[0];
      requireValue(generateResult.isError !== true && generated?.id, "remote smoke generation failed");
      requireValue(
        generateResult.content.filter((item) => item.type === "image").length === 1,
        "remote smoke generation returned no image content",
      );

      const generatedRender = await client.callTool({
        name: "render_image_results",
        arguments: { imageIds: [generated.id] },
      });
      const generatedImages = generatedRender.content.filter((item) => item.type === "image");
      requireValue(
        generatedRender.isError !== true
          && generatedImages.length === 1,
        "remote smoke generated result did not render",
      );
      const generatedResources = await readArtifactData(
        client,
        generatedRender.structuredContent?.artifacts ?? [],
        generatedImages,
      );

      const editResult = await client.callTool({
        name: "edit_image",
        arguments: {
          parentImageId: generated.id,
          prompt: REMOTE_SMOKE_EDIT_PROMPT,
          quality: "low",
          size: "1024x1024",
          format: "png",
        },
      });
      const edited = editResult.structuredContent?.artifacts?.[0];
      requireValue(editResult.isError !== true && edited?.id, "remote smoke edit failed");
      requireValue(
        editResult.content.filter((item) => item.type === "image").length === 1,
        "remote smoke edit returned no image content",
      );
      requireValue(
        JSON.stringify(edited.parentIds) === JSON.stringify([generated.id]),
        "remote smoke edit did not preserve the parent image ID",
      );

      const editedRender = await client.callTool({
        name: "render_image_results",
        arguments: { imageIds: [edited.id] },
      });
      const editedImages = editedRender.content.filter((item) => item.type === "image");
      requireValue(
        editedRender.isError !== true
          && editedImages.length === 1,
        "remote smoke edited result did not render",
      );
      const editedResources = await readArtifactData(
        client,
        editedRender.structuredContent?.artifacts ?? [],
        editedImages,
      );
      requireSafeToolResults([generateResult, generatedRender, editResult, editedRender], projectRoot);
      remoteSmokeResult = {
        generatedImageId: generated.id,
        editedImageId: edited.id,
        editedParentIds: edited.parentIds,
        generatedRenderImageCount: generatedImages.length,
        editedRenderImageCount: editedImages.length,
        generatedResourceCount: generatedResources.length,
        editedResourceCount: editedResources.length,
      };
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      plugin: manifest.name,
      version: manifest.version,
      packageIdentityChecked: Boolean(packageManifest || packageLock),
      pluginRoot,
      projectRoot,
      sourceRoot,
      ...marketplace,
      ...sourceComparison,
      tools,
      appOnlyTools,
      resources,
      resourceTemplates,
      missingImageIdRejected,
      artifactRead,
      artifactReads,
      modelCatalog,
      resultRender,
      remoteSmoke: remoteSmokeResult,
      annotationSmoke: annotationSmokeResult,
      editorLifecycle,
    })}\n`);
  } finally {
    await client.close();
  }
}

async function readArtifactData(client, artifacts, imageContents) {
  requireValue(artifacts.length === imageContents.length, "image metadata and content counts differ");
  return await Promise.all(artifacts.map(async (artifact, index) => {
    const result = await client.callTool({
      name: "read_image_artifact_data",
      arguments: { imageId: artifact.id },
    });
    const payload = result.structuredContent;
    const widgetData = result._meta?.widgetData;
    requireValue(result.isError !== true && widgetData?.dataBase64, `image data tool returned no bytes for ${artifact.id}`);
    requireValue(
      payload.id === artifact.id
        && payload.mimeType === imageContents[index].mimeType
        && widgetData.id === artifact.id
        && widgetData.mimeType === imageContents[index].mimeType
        && widgetData.dataBase64 === imageContents[index].data,
      `image data tool content differs for ${artifact.id}`,
    );
    return { imageId: artifact.id, mimeType: payload.mimeType };
  }));
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
