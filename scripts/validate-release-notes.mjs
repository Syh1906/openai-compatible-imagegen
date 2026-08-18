import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";


const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const requiredSections = ["Highlights", "Install", "Known limitations"];


export async function validateReleaseNotes({ projectRoot: root, releaseTag }) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("projectRoot must be a non-empty string");
  }
  const match = /^v(\d+\.\d+\.\d+)$/.exec(releaseTag ?? "");
  if (!match) {
    throw new Error("release tag must use v<major>.<minor>.<patch>");
  }
  const version = match[1];
  const notesPath = `.github/release-notes/${releaseTag}.md`;
  const [notes, changelog] = await Promise.all([
    readFile(path.join(root, ...notesPath.split("/")), "utf8").catch((error) => {
      if (error?.code === "ENOENT") {
        throw new Error(`release notes are missing: ${notesPath}`);
      }
      throw error;
    }),
    readFile(path.join(root, "CHANGELOG.md"), "utf8"),
  ]);

  validateNotesBody(notes, releaseTag);
  validateChangelog(changelog, version, releaseTag);
  return { ok: true, releaseTag, version, notesPath };
}


function validateNotesBody(notes, releaseTag) {
  const normalized = notes.replaceAll("\r\n", "\n").trim();
  if (normalized.length === 0 || normalized.startsWith("# ")) {
    throw new Error("release notes must start with a summary paragraph and must not repeat the Release title");
  }
  const sections = new Map();
  const headingPattern = /^## ([^\n]+)$/gm;
  const headings = [...normalized.matchAll(headingPattern)];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const bodyStart = heading.index + heading[0].length;
    const bodyEnd = headings[index + 1]?.index ?? normalized.length;
    sections.set(heading[1], normalized.slice(bodyStart, bodyEnd).trim());
  }
  if (requiredSections.some((name) => !sections.get(name))) {
    throw new Error("release notes must contain non-empty ## Highlights, ## Install, and ## Known limitations sections");
  }
  const firstSection = normalized.indexOf("\n## ");
  if (firstSection <= 0 || normalized.slice(0, firstSection).trim().length === 0) {
    throw new Error("release notes must start with a summary paragraph");
  }
  if (!sections.get("Install").includes(`/blob/${releaseTag}/docs/guides/installation.md`)) {
    throw new Error(`the Install section must link to the ${releaseTag} installation guide`);
  }
  if (!sections.get("Install").includes("SHA256SUMS")) {
    throw new Error("the Install section must require SHA256SUMS verification");
  }
  if (/(?:^|[\s("'])[A-Za-z]:[\\/]|(?:^|[\s("'])\/(?:home|Users)\//m.test(normalized)) {
    throw new Error("release notes must not contain local absolute paths");
  }
}


function validateChangelog(changelog, version, releaseTag) {
  const escapedVersion = escapeRegExp(version);
  const versionHeading = new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m");
  const versionLink = new RegExp(`^\\[${escapedVersion}\\]: .*\\.\\.\\.${escapeRegExp(releaseTag)}$`, "m");
  if (!versionHeading.test(changelog) || !versionLink.test(changelog)) {
    throw new Error(`CHANGELOG.md must contain a dated ${version} section and ${releaseTag} comparison link`);
  }
}


function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}


const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    const result = await validateReleaseNotes({
      projectRoot,
      releaseTag: readOption("--tag"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
