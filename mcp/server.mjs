import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { readImageAnnotation, saveImageAnnotations } from "./annotation-repository.mjs";
import { readImageArtifact } from "./artifact-repository.mjs";
import { resolveV2ConfigPath } from "./config-resolution.mjs";
import { createImagegenServer } from "./create-server.mjs";
import { runImageTask } from "./image-runtime.mjs";


const widgetPath = fileURLToPath(new URL("../dist/widget/index.html", import.meta.url));
const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const server = createImagegenServer({
  releaseIdentity: __RELEASE_IDENTITY__,
  launchContext: {
    cwd: process.cwd(),
    pluginRoot,
  },
  readWidgetHtml: async () => await readFile(widgetPath, "utf8"),
  runTask: async (task, { projectRoot }) => {
    const configPath = await resolveV2ConfigPath({ projectRoot });
    return await runImageTask(task, { projectRoot, configPath });
  },
  readArtifact: async (imageId, { projectRoot }) => await readImageArtifact(imageId, { projectRoot }),
  readAnnotation: async (annotationId, { projectRoot }) => await readImageAnnotation(annotationId, { projectRoot }),
  saveAnnotations: async (request, { projectRoot }) => await saveImageAnnotations(request, { projectRoot }),
});

await server.connect(new StdioServerTransport());
