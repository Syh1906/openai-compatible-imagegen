import { lstat, readFile } from "node:fs/promises";
import path from "node:path";


const ARTIFACT_ID_PATTERN = /^img_[0-9A-HJKMNP-TV-Z]{26}$/;

export async function readImageArtifact(imageId, { projectRoot } = {}) {
  if (!ARTIFACT_ID_PATTERN.test(imageId)) {
    throw new Error(`invalid artifact ID: ${imageId}`);
  }
  const resolvedProjectRoot = requireProjectRoot(projectRoot);
  try {
    const dataRoot = path.join(resolvedProjectRoot, "output", "imagegen");
    const indexPath = path.join(dataRoot, "index.json");
    await rejectLinksBetween(resolvedProjectRoot, indexPath);
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    const entry = index?.version === 1 ? index.artifacts?.[imageId] : undefined;
    if (!entry || typeof entry !== "object") {
      throw new Error(`artifact not found: ${imageId}`);
    }
    const imageName = entry.imageFile;
    if (typeof imageName !== "string" || path.basename(imageName) !== imageName) {
      throw new Error(`artifact has invalid image file: ${imageId}`);
    }
    const imagePath = path.join(dataRoot, "artifacts", imageId, imageName);
    await rejectLinksBetween(dataRoot, imagePath);
    const image = await readFile(imagePath);
    const metadata = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "imageFile"));
    metadata.childIds = Object.entries(index.artifacts)
      .filter(([, candidate]) => candidate?.parentIds?.includes(imageId))
      .map(([candidateId]) => candidateId)
      .sort();
    return { metadata, data: image.toString("base64") };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`artifact not found: ${imageId}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error("artifact index is not valid JSON");
    }
    throw error;
  }
}


function requireProjectRoot(projectRoot) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw new Error("project root is required");
  }
  return path.resolve(projectRoot);
}

async function rejectLinksBetween(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("artifact path escapes the project data root");
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`artifact path contains a reparse point: ${path.basename(current)}`);
    }
  }
}
