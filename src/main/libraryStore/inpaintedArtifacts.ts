import { resolve, join } from "node:path";
import { readdir } from "node:fs/promises";
import { isPathInside, isSupportedImagePath, unlinkIfExists } from "./storage";

export function inpaintedPathChanged(
  previousPath: string,
  nextPath?: string,
): boolean {
  return (
    !nextPath ||
    normalizePathForReference(previousPath) !==
      normalizePathForReference(nextPath)
  );
}

export async function removeUnreferencedInpaintedArtifacts(
  chapterDir: string,
  candidatePaths: string[],
  pages: Array<{ inpaintedImagePath?: string }>,
  retainedArtifactPaths: string[] = [],
): Promise<void> {
  if (candidatePaths.length === 0) {
    return;
  }

  const retainedPaths = new Set(
    pages
      .map((page) => page.inpaintedImagePath)
      .filter((path): path is string => Boolean(path))
      .map(normalizePathForReference),
  );
  for (const retainedPath of retainedArtifactPaths) {
    if (isManagedInpaintedArtifact(chapterDir, retainedPath)) {
      retainedPaths.add(normalizePathForReference(retainedPath));
    }
  }
  const seenCandidates = new Set<string>();
  for (const candidatePath of candidatePaths) {
    const normalizedCandidate = normalizePathForReference(candidatePath);
    if (
      seenCandidates.has(normalizedCandidate) ||
      retainedPaths.has(normalizedCandidate)
    ) {
      continue;
    }
    seenCandidates.add(normalizedCandidate);
    if (!isManagedInpaintedArtifact(chapterDir, candidatePath)) {
      continue;
    }
    await unlinkIfExists(resolve(candidatePath));
  }
}

export async function removeUnreferencedInpaintMaskArtifacts(
  chapterDir: string,
  candidatePaths: string[],
  pages: Array<{ inpaintMaskPath?: string }>,
  retainedArtifactPaths: string[] = [],
): Promise<void> {
  await removeUnreferencedManagedArtifacts({
    chapterDir,
    directoryName: "mask",
    candidatePaths,
    pagePaths: pages.map((page) => page.inpaintMaskPath),
    retainedArtifactPaths,
  });
}

export async function collectManagedInpaintedArtifacts(
  chapterDir: string,
): Promise<string[]> {
  const inpaintedDir = resolve(join(chapterDir, "inpainted"));
  let entries: Array<{ isFile: () => boolean; name: string }>;
  try {
    entries = await readdir(inpaintedDir, { withFileTypes: true });
  } catch (_error) {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(join(inpaintedDir, entry.name)))
    .filter((filePath) => isManagedInpaintedArtifact(chapterDir, filePath));
}

export async function collectManagedInpaintMaskArtifacts(
  chapterDir: string,
): Promise<string[]> {
  return collectManagedArtifacts(chapterDir, "mask");
}

async function collectManagedArtifacts(
  chapterDir: string,
  directoryName: "inpainted" | "mask",
): Promise<string[]> {
  const artifactDir = resolve(join(chapterDir, directoryName));
  let entries: Array<{ isFile: () => boolean; name: string }>;
  try {
    entries = await readdir(artifactDir, { withFileTypes: true });
  } catch (_error) {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(join(artifactDir, entry.name)))
    .filter((filePath) =>
      isManagedArtifact(chapterDir, directoryName, filePath),
    );
}

async function removeUnreferencedManagedArtifacts({
  chapterDir,
  directoryName,
  candidatePaths,
  pagePaths,
  retainedArtifactPaths,
}: {
  chapterDir: string;
  directoryName: "inpainted" | "mask";
  candidatePaths: string[];
  pagePaths: Array<string | undefined>;
  retainedArtifactPaths: string[];
}): Promise<void> {
  if (candidatePaths.length === 0) return;
  const retainedPaths = new Set(
    pagePaths
      .filter((path): path is string => Boolean(path))
      .map(normalizePathForReference),
  );
  for (const retainedPath of retainedArtifactPaths) {
    if (isManagedArtifact(chapterDir, directoryName, retainedPath)) {
      retainedPaths.add(normalizePathForReference(retainedPath));
    }
  }
  const seenCandidates = new Set<string>();
  for (const candidatePath of candidatePaths) {
    const normalizedCandidate = normalizePathForReference(candidatePath);
    if (
      seenCandidates.has(normalizedCandidate) ||
      retainedPaths.has(normalizedCandidate)
    ) {
      continue;
    }
    seenCandidates.add(normalizedCandidate);
    if (!isManagedArtifact(chapterDir, directoryName, candidatePath)) continue;
    await unlinkIfExists(resolve(candidatePath));
  }
}

function isManagedInpaintedArtifact(
  chapterDir: string,
  imagePath: string,
): boolean {
  const inpaintedDir = resolve(join(chapterDir, "inpainted"));
  const resolvedImagePath = resolve(imagePath);
  return (
    resolvedImagePath !== inpaintedDir &&
    isPathInside(inpaintedDir, resolvedImagePath) &&
    isSupportedImagePath(resolvedImagePath)
  );
}

function isManagedArtifact(
  chapterDir: string,
  directoryName: "inpainted" | "mask",
  imagePath: string,
): boolean {
  const artifactDir = resolve(join(chapterDir, directoryName));
  const resolvedImagePath = resolve(imagePath);
  return (
    resolvedImagePath !== artifactDir &&
    isPathInside(artifactDir, resolvedImagePath) &&
    isSupportedImagePath(resolvedImagePath)
  );
}

function normalizePathForReference(filePath: string): string {
  const resolvedPath = resolve(filePath);
  return process.platform === "win32"
    ? resolvedPath.toLowerCase()
    : resolvedPath;
}
