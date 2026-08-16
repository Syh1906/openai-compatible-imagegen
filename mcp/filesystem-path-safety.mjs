import { lstat } from "node:fs/promises";
import path from "node:path";


export async function pathContainsSymbolicLink(targetPath) {
  const absolutePath = path.resolve(targetPath);
  const root = path.parse(absolutePath).root;
  let currentPath = root;
  const relativePath = path.relative(root, absolutePath);

  for (const component of relativePath.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, component);
    if ((await lstat(currentPath)).isSymbolicLink()) return true;
  }
  return false;
}
