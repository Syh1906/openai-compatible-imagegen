import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { deleteImageAnnotation, readImageAnnotation, saveImageAnnotations } from "./annotation-repository.mjs";
import { readImageArtifact } from "./artifact-repository.mjs";
import { revealImageArtifact } from "./artifact-revealer.mjs";
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
  runTask: async (task, context) => await runImageTask(task, context),
  readArtifact: async (imageId, { artifactRoot }) => await readImageArtifact(imageId, { artifactRoot }),
  revealArtifact: async (imageId, { artifactRoot }) => await revealImageArtifact(imageId, { artifactRoot }),
  readAnnotation: async (annotationId, { artifactRoot }) => await readImageAnnotation(annotationId, { artifactRoot }),
  saveAnnotations: async (request, { artifactRoot }) => await saveImageAnnotations(request, { artifactRoot }),
  deleteAnnotation: async (annotationId, { artifactRoot }) => await deleteImageAnnotation(annotationId, { artifactRoot }),
});

server.server.oninitialized = () => {
  // Refresh host catalogs after a plugin upgrade before any widget-bearing tool runs.
  server.sendToolListChanged();
  server.sendResourceListChanged();
};

await server.connect(new StdioServerTransport());
