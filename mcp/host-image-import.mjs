import { fileURLToPath } from "node:url";

import { runRepositoryFsOperation } from "./repository-fs-client.mjs";


const runtimeRelativePath = import.meta.url.replaceAll("\\", "/").includes("/dist/server.mjs")
  ? "./scripts/host_image_import.py"
  : "../scripts/host_image_import.py";
const defaultRuntimePath = fileURLToPath(new URL(runtimeRelativePath, import.meta.url));
const HOST_IMPORT_ERROR_CODES = new Set([
  "host_image_request_invalid",
  "host_image_output_invalid",
  "host_image_handoff_not_found",
  "host_image_handoff_state_invalid",
  "host_image_import_failed",
]);


export function createHostImageImporter({ runOperation = runHostImageImportOperation } = {}) {
  return Object.freeze({
    async prepare(input, context) {
      return await stableOperation(runOperation, { operation: "prepare", ...runtimeContext(context), ...input });
    },
    async stage(input, context) {
      return await stableOperation(runOperation, { operation: "stage", ...runtimeContext(context), ...input });
    },
    async finalize(input, context) {
      return await stableOperation(runOperation, { operation: "finalize", ...runtimeContext(context), ...input });
    },
  });
}


export async function runHostImageImportOperation(request, options = {}) {
  return await runRepositoryFsOperation(request, {
    runtimePath: defaultRuntimePath,
    ...options,
  });
}


function runtimeContext(context) {
  if (!context || typeof context.projectRoot !== "string" || typeof context.artifactRoot !== "string") {
    throw new Error("host image import requires a bound project");
  }
  return { projectRoot: context.projectRoot, artifactRoot: context.artifactRoot };
}


async function stableOperation(runOperation, request) {
  try {
    return await runOperation(request);
  } catch (error) {
    const code = HOST_IMPORT_ERROR_CODES.has(error?.message) ? error.message : "host_image_import_failed";
    const stableError = new Error(code);
    stableError.code = code;
    throw stableError;
  }
}
