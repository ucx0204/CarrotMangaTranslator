import { resolve, join } from "node:path";
import { isLibraryArtifactRetained } from "./libraryArtifactRetention";
import { isPathInside, isSupportedImagePath } from "./storage";
import {
  isRecoveredImageArtifact,
  removeManagedImageCandidate,
} from "./recoveredImageArtifacts";

type ImageReferences = {
  imagePath?: string;
  inpaintedImagePath?: string;
  inpaintMaskPath?: string;
};
const referencedPaths = (pages: readonly ImageReferences[]) =>
  pages.flatMap((page) => [
    page.imagePath,
    page.inpaintedImagePath,
    page.inpaintMaskPath,
  ]);

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

export function isUnreferencedPageMask(
  chapterDir: string,
  maskPath: string,
  pages: readonly ImageReferences[],
): boolean {
  return (
    isManagedArtifact(chapterDir, "mask", maskPath) &&
    !referencedPaths(pages).some(
      (path) => path && !inpaintedPathChanged(maskPath, path),
    )
  );
}

export async function removeUnreferencedInpaintedArtifacts(
  chapterDir: string,
  candidatePaths: string[],
  pages: ImageReferences[],
  retainedArtifactPaths: string[] = [],
): Promise<void> {
  if (candidatePaths.length === 0) {
    return;
  }

  const retainedPaths = new Set(
    referencedPaths(pages)
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
      retainedPaths.has(normalizedCandidate) ||
      isLibraryArtifactRetained(candidatePath)
    ) {
      continue;
    }
    seenCandidates.add(normalizedCandidate);
    if (!isManagedInpaintedArtifact(chapterDir, candidatePath)) {
      continue;
    }
    await removeManagedImageCandidate(chapterDir, candidatePath);
  }
}

export async function removeUnreferencedInpaintMaskArtifacts(
  chapterDir: string,
  candidatePaths: string[],
  pages: ImageReferences[],
  retainedArtifactPaths: string[] = [],
): Promise<void> {
  await removeUnreferencedManagedArtifacts({
    chapterDir,
    directoryName: "mask",
    candidatePaths,
    pagePaths: referencedPaths(pages),
    retainedArtifactPaths,
  });
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
      retainedPaths.has(normalizedCandidate) ||
      isLibraryArtifactRetained(candidatePath)
    ) {
      continue;
    }
    seenCandidates.add(normalizedCandidate);
    if (!isManagedArtifact(chapterDir, directoryName, candidatePath)) continue;
    await removeManagedImageCandidate(chapterDir, candidatePath);
  }
}

function isManagedInpaintedArtifact(
  chapterDir: string,
  imagePath: string,
): boolean {
  return isManagedArtifact(chapterDir, "inpainted", imagePath);
}

function isManagedArtifact(
  chapterDir: string,
  directoryName: "inpainted" | "mask",
  imagePath: string,
): boolean {
  const artifactDir = resolve(join(chapterDir, directoryName));
  const resolvedImagePath = resolve(imagePath);
  return (
    (resolvedImagePath !== artifactDir &&
      isPathInside(artifactDir, resolvedImagePath) &&
      isSupportedImagePath(resolvedImagePath)) ||
    isRecoveredImageArtifact(chapterDir, directoryName, imagePath)
  );
}

function normalizePathForReference(filePath: string): string {
  const resolvedPath = resolve(filePath);
  return process.platform === "win32"
    ? resolvedPath.toLowerCase()
    : resolvedPath;
}
