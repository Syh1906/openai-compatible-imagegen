import { access, lstat, readFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { extractImageResultEnvelopeIds } from "../mcp/result-envelope.mjs";
import { containsAbsolutePath, fingerprintPath, pathRelation } from "../mcp/runtime-diagnostics.mjs";
import {
  distributionFiles as DISTRIBUTION_FILES,
  releaseEntriesFor,
} from "./plugin-file-set.mjs";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_ID = "openai-compatible-imagegen-v2";
const APP_ONLY_TOOLS = [
  "finalize_image_editor_session",
  "get_image_editor_session",
  "open_image_editor",
  "prepare_image_edit_submission",
  "read_image_artifact_data",
  "report_imagegen_host_observation",
  "reveal_image_artifact",
  "save_image_annotations",
];
const REMOTE_SMOKE_GENERATE_PROMPT = "A single solid red circle centered on a plain white background, no text.";
const REMOTE_SMOKE_EDIT_PROMPT = "Change the circle from red to blue. Keep the plain white background and add no text.";
const RELEASE_ENTRIES = releaseEntriesFor(PLUGIN_ID);

function parseOptions(args) {
  const options = {
    pluginRoot: defaultRoot,
    projectRoot: null,
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

function requireSafeToolResults(results, ...roots) {
  const safeResult = results.map((result) => ({
    content: result.content?.filter((item) => item.type !== "image"),
    structuredContent: result.structuredContent,
    meta: result._meta,
  }));
  const stringValues = collectStringValues(safeResult);
  const text = JSON.stringify(safeResult);
  for (const root of roots) {
    const normalizedRoot = normalizePathForComparison(path.resolve(root));
    requireValue(
      !stringValues.some((value) => (
        normalizePathForComparison(value).includes(normalizedRoot)
      )),
      "tool result exposed a local root",
    );
  }
  requireValue(!stringValues.some(containsAbsolutePath), "tool result exposed an absolute local path");
  requireValue(!/authorization|api[_-]?key|config\.json/i.test(text), "remote smoke result exposed configuration or auth fields");
}

function collectStringValues(value, result = []) {
  if (typeof value === "string") {
    result.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, result);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      result.push(key);
      collectStringValues(item, result);
    }
  }
  return result;
}

function normalizePathForComparison(value) {
  const normalized = String(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
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
  const [installedFiles, sourceFiles] = await Promise.all([
    listReleaseFiles(pluginRoot),
    listReleaseFiles(sourceRoot),
  ]);
  const installedFileSet = new Set(installedFiles);
  const sourceFileSet = new Set(sourceFiles);
  const releaseFiles = [...new Set([...installedFiles, ...sourceFiles])].sort();
  const comparisons = await Promise.all(releaseFiles.map(async (relativePath) => {
    if (!installedFileSet.has(relativePath) || !sourceFileSet.has(relativePath)) {
      return relativePath;
    }
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

async function listReleaseFiles(root) {
  const files = [];
  for (const relativePath of RELEASE_ENTRIES) {
    await collectReleaseFiles(root, relativePath, files);
  }
  return files.sort();
}

async function collectReleaseFiles(root, relativePath, files) {
  const absolutePath = path.resolve(root, relativePath);
  const metadata = await lstat(absolutePath);
  requireValue(!metadata.isSymbolicLink(), `release path is a symbolic link: ${relativePath}`);
  if (metadata.isFile()) {
    files.push(relativePath.replaceAll("\\", "/"));
    return;
  }
  requireValue(metadata.isDirectory(), `release path has unsupported type: ${relativePath}`);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    await collectReleaseFiles(root, path.join(relativePath, entry.name), files);
  }
}

async function requireCleanDistribution() {
  const files = await listFiles(resolvePath("dist"));
  requireValue(
    JSON.stringify(files) === JSON.stringify(DISTRIBUTION_FILES),
    `distribution file set differs: ${files.join(", ")}`,
  );
}

async function listFiles(root, relativeDirectory = "") {
  const files = [];
  const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    requireValue(entry.isDirectory() || entry.isFile(), `distribution contains unsupported entry: ${relativePath}`);
    if (entry.isDirectory()) files.push(...await listFiles(root, relativePath));
    else files.push(relativePath.replaceAll("\\", "/"));
  }
  return files.sort();
}

async function main() {
  requireValue(projectRoot, "--project-root is required; the probe never infers a project root");
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

  requireValue(manifest.skills === "./skills/", "manifest skills path is invalid");
  requireValue(manifest.mcpServers === "./.mcp.json", "manifest MCP path is invalid");
  requireValue(server?.cwd === ".", "MCP server cwd must be the plugin root");
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
    cwd: pluginRoot,
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const serverVersion = client.getServerVersion();
    requireValue(serverVersion?.name === manifest.name, "running server name differs from plugin name");
    requireValue(serverVersion?.version === manifest.version, "running server version differs from plugin version");
    const [toolResult, resourceResult, resourceTemplateResult] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listResourceTemplates(),
    ]);
    const tools = toolResult.tools.map((tool) => tool.name).sort();
    const appOnlyTools = toolResult.tools
      .filter((tool) => tool._meta?.ui?.visibility?.includes("app"))
      .map((tool) => tool.name)
      .sort();
    const resources = resourceResult.resources.map((resource) => resource.uri).sort();
    const resourceTemplates = resourceTemplateResult.resourceTemplates.map((resource) => resource.uriTemplate).sort();
    const resultTool = toolResult.tools.find((tool) => tool.name === "render_image_results");
    const editorTool = toolResult.tools.find((tool) => tool.name === "open_image_editor");
    const releaseIdentity = resultTool?._meta?.releaseIdentity;

    requireValue(tools.includes("open_image_editor"), "MCP server does not expose open_image_editor");
    requireValue(tools.includes("generate_image"), "MCP server does not expose generate_image");
    requireValue(tools.includes("edit_image"), "MCP server does not expose edit_image");
    requireValue(tools.includes("batch_images"), "MCP server does not expose batch_images");
    requireValue(tools.includes("deliver_image"), "MCP server does not expose deliver_image");
    requireValue(tools.includes("get_image_artifact"), "MCP server does not expose get_image_artifact");
    requireValue(tools.includes("inspect_imagegen_runtime"), "MCP server does not expose inspect_imagegen_runtime");
    requireValue(tools.includes("read_image_artifact_data"), "MCP server does not expose read_image_artifact_data");
    requireValue(tools.includes("destroy_image_editor"), "MCP server does not expose destroy_image_editor");
    requireValue(tools.includes("get_image_editor_session"), "MCP server does not expose get_image_editor_session");
    requireValue(tools.includes("finalize_image_editor_session"), "MCP server does not expose finalize_image_editor_session");
    requireValue(tools.includes("prepare_image_edit_submission"), "MCP server does not expose prepare_image_edit_submission");
    requireValue(tools.includes("save_image_annotations"), "MCP server does not expose save_image_annotations");
    requireValue(tools.includes("list_image_models"), "MCP server does not expose list_image_models");
    requireValue(tools.includes("bind_imagegen_project"), "MCP server does not expose bind_imagegen_project");
    requireValue(
      JSON.stringify(appOnlyTools) === JSON.stringify(APP_ONLY_TOOLS),
      `unexpected app-only tool visibility: ${appOnlyTools.join(", ")}`,
    );
    requireValue(releaseIdentity?.pluginId === manifest.name, "release identity plugin differs from manifest");
    requireValue(releaseIdentity?.pluginVersion === manifest.version, "release identity version differs from manifest");
    requireValue(/^[a-f0-9]{20}$/.test(releaseIdentity?.fingerprint ?? ""), "release identity fingerprint is invalid");
    requireValue(/^[a-f0-9]{64}$/.test(releaseIdentity?.serverBuildDigest ?? ""), "server build digest is invalid");
    requireValue(/^[a-f0-9]{64}$/.test(releaseIdentity?.widgetAssetDigest ?? ""), "widget asset digest is invalid");
    requireValue(
      JSON.stringify(editorTool?._meta?.releaseIdentity) === JSON.stringify(releaseIdentity),
      "result and editor tools expose different release identities",
    );
    requireValue(
      resultTool?._meta?.ui?.resourceUri === releaseIdentity.resourceUris.result
        && editorTool?._meta?.ui?.resourceUri === releaseIdentity.resourceUris.editor,
      "tool resource URIs differ from release identity",
    );
    requireValue(
      JSON.stringify(resources) === JSON.stringify(Object.values(releaseIdentity.resourceUris).sort()),
      "MCP resources differ from release identity",
    );
    requireValue(
      widget.includes(`<meta name="openai-compatible-imagegen-release" content="${releaseIdentity.fingerprint}">`),
      "widget release marker differs from running server",
    );
    const resourceReads = await Promise.all(resources.map((uri) => client.readResource({ uri })));
    requireValue(
      resourceReads.every((result) => (
        JSON.stringify(result.contents?.[0]?._meta?.releaseIdentity) === JSON.stringify(releaseIdentity)
      )),
      "widget resources expose a different release identity",
    );

    const unboundResult = await client.callTool({
      name: "list_image_models",
      arguments: {},
    });
    requireValue(
      unboundResult.isError === true
        && !unboundResult.structuredContent
        && unboundResult.content?.[0]?.text?.startsWith("project_binding_required:"),
      "unbound project calls did not return a stable error",
    );
    const bindingResult = await client.callTool({
      name: "bind_imagegen_project",
      arguments: { projectRoot },
    });
    requireValue(
      bindingResult.isError !== true
        && ["bound", "already_bound"].includes(bindingResult.structuredContent?.status),
      "explicit project binding failed",
    );
    const runtimeDiagnosticResult = await client.callTool({
      name: "inspect_imagegen_runtime",
      arguments: {},
    });
    const runtimeDiagnostic = runtimeDiagnosticResult.structuredContent?.runtime;
    requireValue(runtimeDiagnosticResult.isError !== true && runtimeDiagnostic, "runtime diagnostic failed");
    requireValue(
      JSON.stringify(runtimeDiagnosticResult.structuredContent?.releaseIdentity) === JSON.stringify(releaseIdentity),
      "runtime diagnostic release identity differs",
    );
    requireValue(
      runtimeDiagnostic.pluginRootFingerprint === fingerprintPath(pluginRoot)
        && runtimeDiagnostic.projectRootFingerprint === fingerprintPath(projectRoot)
        && runtimeDiagnostic.cwdFingerprint === fingerprintPath(pluginRoot)
        && runtimeDiagnostic.projectRootSource === "explicit_tool",
      "runtime diagnostic root identity differs",
    );
    requireSafeToolResults([runtimeDiagnosticResult], pluginRoot, projectRoot);
    requireValue(
      !resourceTemplates.includes("imagegen://artifact/{imageId}"),
      "MCP server still exposes the unsupported widget image resource template",
    );
    const invalidCall = await client.callTool({ name: "open_image_editor", arguments: {} });
    const missingImageIdRejected = invalidCall.isError === true;
    requireValue(missingImageIdRejected, "open_image_editor accepted a missing image ID");
    let artifactRead = null;
    let artifactReads = [];
    let modelCatalog = null;
    let resultRender = null;
    let remoteSmokeResult = null;
    let annotationSmokeResult = null;
    let editorLifecycle = null;
    if (remoteSmoke) {
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
      requireResultEnvelope(renderResult, imageIds);
      const renderedArtifacts = renderResult.structuredContent?.artifacts ?? [];
      requireValue(renderResult.isError !== true, `render_image_results failed for ${imageIds.join(", ")}`);
      requireValue(
        JSON.stringify(renderResult.structuredContent?.imageIds) === JSON.stringify(imageIds)
          && JSON.stringify(renderedArtifacts.map((artifact) => artifact.id)) === JSON.stringify(imageIds),
        "render_image_results did not preserve the requested image order",
      );
      const renderedResources = await readArtifactData(client, renderedArtifacts);
      resultRender = {
        imageIds: renderResult.structuredContent.imageIds,
        artifactCount: renderedArtifacts.length,
        imageDataCount: renderedResources.length,
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

      const generatedRender = await client.callTool({
        name: "render_image_results",
        arguments: { imageIds: [generated.id] },
      });
      requireResultEnvelope(generatedRender, [generated.id]);
      requireValue(
        generatedRender.isError !== true
          && generatedRender.structuredContent?.artifacts?.length === 1,
        "remote smoke generated result did not render",
      );
      const generatedResources = await readArtifactData(
        client,
        generatedRender.structuredContent?.artifacts ?? [],
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
        JSON.stringify(edited.parentIds) === JSON.stringify([generated.id]),
        "remote smoke edit did not preserve the parent image ID",
      );

      const editedRender = await client.callTool({
        name: "render_image_results",
        arguments: { imageIds: [edited.id] },
      });
      requireResultEnvelope(editedRender, [edited.id]);
      requireValue(
        editedRender.isError !== true
          && editedRender.structuredContent?.artifacts?.length === 1,
        "remote smoke edited result did not render",
      );
      const editedResources = await readArtifactData(
        client,
        editedRender.structuredContent?.artifacts ?? [],
      );
      requireSafeToolResults([generateResult, generatedRender, editResult, editedRender], projectRoot);
      remoteSmokeResult = {
        generatedImageId: generated.id,
        editedImageId: edited.id,
        editedParentIds: edited.parentIds,
        generatedImageDataCount: generatedResources.length,
        editedImageDataCount: editedResources.length,
      };
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      plugin: manifest.name,
      version: manifest.version,
      releaseIdentity,
      runtimeDiagnostic,
      packageIdentityChecked: Boolean(packageManifest || packageLock),
      pluginRootFingerprint: fingerprintPath(pluginRoot),
      projectRootFingerprint: fingerprintPath(projectRoot),
      sourceRootFingerprint: sourceRoot ? fingerprintPath(sourceRoot) : null,
      projectRootRelationToPlugin: pathRelation(projectRoot, pluginRoot),
      marketplace: marketplace
        ? {
          marketplaceRootFingerprint: fingerprintPath(marketplace.marketplaceRoot),
          marketplacePluginRootFingerprint: fingerprintPath(marketplace.marketplacePluginRoot),
        }
        : null,
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

async function readArtifactData(client, artifacts) {
  return await Promise.all(artifacts.map(async (artifact) => {
    const result = await client.callTool({
      name: "read_image_artifact_data",
      arguments: { imageId: artifact.id },
    });
    const payload = result.structuredContent;
    const widgetData = result._meta?.widgetData;
    requireValue(result.isError !== true && widgetData?.dataBase64, `image data tool returned no bytes for ${artifact.id}`);
    requireValue(
      payload.id === artifact.id
        && payload.mimeType === artifact.mimeType
        && widgetData.id === artifact.id
        && widgetData.mimeType === artifact.mimeType
        && Buffer.from(widgetData.dataBase64, "base64").byteLength > 0,
      `image data tool content differs for ${artifact.id}`,
    );
    return { imageId: artifact.id, mimeType: payload.mimeType };
  }));
}

function requireResultEnvelope(result, expectedImageIds) {
  const envelopeImageIds = extractImageResultEnvelopeIds(result);
  requireValue(
    JSON.stringify(envelopeImageIds) === JSON.stringify(expectedImageIds),
    "render_image_results returned an invalid or mismatched result envelope",
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
