import { fileURLToPath } from "node:url";
import { z } from "zod";

import { imageArtifactOutputSchema, imageIdSchema, projectBindingIdSchema } from "./image-tool-schemas.mjs";
import { runRepositoryFsOperation } from "./repository-fs-client.mjs";
import { isStableToolErrorCode } from "./tool-errors.mjs";


const runtimePath = fileURLToPath(new URL(
  import.meta.url.replaceAll("\\", "/").includes("/dist/server.mjs")
    ? "./scripts/local_image_transfer.py" : "../scripts/local_image_transfer.py",
  import.meta.url,
));
const errorCodes = new Set([
  "local_image_request_invalid", "local_image_source_invalid", "local_image_import_failed",
  "local_image_destination_exists", "local_image_export_failed", "local_image_transfer_failed",
]);
const relativePathSchema = z.string().min(1).max(4096).describe("Project-relative file path using forward slashes");
const localWriteAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };


export function createLocalImageTransfer({
  runOperation = (request) => runRepositoryFsOperation(request, { runtimePath }),
} = {}) {
  async function execute(operation, input, context) {
    try {
      return await runOperation({
        operation, ...input, projectRoot: context.projectRoot, artifactRoot: context.artifactRoot,
      });
    } catch (error) {
      const code = errorCodes.has(error?.message) ? error.message : "local_image_transfer_failed";
      throw Object.assign(new Error(code), { code });
    }
  }
  return Object.freeze({
    importImage: (input, context) => execute("import", input, context),
    exportImage: (input, context) => execute("export", input, context),
  });
}


export function registerLocalImageTransferTools(server, { projectContext, transfer, toolError }) {
  async function withProject(projectBindingId, operation) {
    try {
      return await operation(await projectContext.require(projectBindingId));
    } catch (error) {
      return toolError(error, isStableToolErrorCode(error?.code) ? error.code : "local_image_transfer_failed");
    }
  }
  server.registerTool("import_local_image", {
    title: "Import local image",
    description: "Import an existing PNG, JPEG, or WebP from a project-relative sourcePath as an immutable image artifact. Use the returned artifact.id as edit_image.parentImageId or referenceImageIds. Does not call an image service or change the authentication route. Never use host image handoff tools for existing local files.",
    inputSchema: { projectBindingId: projectBindingIdSchema, sourcePath: relativePathSchema },
    outputSchema: z.object({ artifact: imageArtifactOutputSchema }).strict(),
    annotations: localWriteAnnotations,
  }, async ({ projectBindingId, sourcePath }) => await withProject(projectBindingId, async (context) => {
    const result = await transfer.importImage({ sourcePath }, context);
    return { content: [{ type: "text", text: `已导入图片 ${result.artifact.id}，可使用此 ID 继续编辑。` }], structuredContent: result };
  }));
  server.registerTool("export_image_artifact", {
    title: "Export image artifact",
    description: "Copy an image artifact's exact original bytes to a new project-relative destinationPath for downstream tools. Creates missing directories, never overwrites an existing file, and requires a matching PNG, JPEG, or WebP extension. Returns the relative destination, byte count, and SHA-256; the artifact remains immutable.",
    inputSchema: { projectBindingId: projectBindingIdSchema, imageId: imageIdSchema, destinationPath: relativePathSchema },
    outputSchema: z.object({
      imageId: imageIdSchema,
      destinationPath: relativePathSchema,
      mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
      byteLength: z.number().int().positive(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict(),
    annotations: localWriteAnnotations,
  }, async ({ projectBindingId, imageId, destinationPath }) => await withProject(projectBindingId, async (context) => {
    const result = await transfer.exportImage({ imageId, destinationPath }, context);
    return { content: [{ type: "text", text: "已导出图片文件，原始 artifact 保持不变。" }], structuredContent: result };
  }));
}
