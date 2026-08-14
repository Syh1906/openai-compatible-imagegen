import path from "node:path";

import { runRepositoryFsOperation } from "./repository-fs-client.mjs";


const ARTIFACT_ID_PATTERN = /^img_[0-9A-HJKMNP-TV-Z]{26}$/;


export async function readImageArtifact(imageId, {
  artifactRoot,
  runRepositoryOperation = runRepositoryFsOperation,
} = {}) {
  validateImageId(imageId);
  const dataRoot = requireArtifactRoot(artifactRoot);
  const result = await runRepositoryOperation({
    operation: "read-artifact",
    artifactRoot: dataRoot,
    imageId,
  });
  if (!result?.metadata || typeof result.dataBase64 !== "string") {
    throw new Error("artifact repository response is invalid");
  }
  return { metadata: result.metadata, data: result.dataBase64 };
}


function validateImageId(imageId) {
  if (!ARTIFACT_ID_PATTERN.test(imageId)) {
    throw new Error(`invalid artifact ID: ${imageId}`);
  }
}


function requireArtifactRoot(artifactRoot) {
  if (typeof artifactRoot !== "string" || !path.isAbsolute(artifactRoot)) {
    throw new Error("artifact root is required");
  }
  return path.resolve(artifactRoot);
}
