import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isPathInside, isSupportedImagePath } from "./storage";

export function relocateCopiedChapterImagePath({
  worksRoot,
  workId,
  chapterId,
  imagePath,
}: {
  worksRoot: string;
  workId: string;
  chapterId: string;
  imagePath: string;
}): string | null {
  if (typeof imagePath !== "string" || imagePath.length === 0) {
    return null;
  }

  const chapterDir = resolve(join(worksRoot, workId, "chapters", chapterId));
  const normalized = normalizePathSeparators(resolve(imagePath));
  const marker = `/works/${workId}/chapters/${chapterId}/`;
  const markerIndex = normalized.lastIndexOf(marker);

  if (markerIndex >= 0) {
    const relativeToChapter = normalized.slice(markerIndex + marker.length);
    const candidate = resolve(
      chapterDir,
      ...relativeToChapter.split("/").filter(Boolean),
    );
    if (
      isPathInside(chapterDir, candidate) &&
      isSupportedImagePath(candidate)
    ) {
      return candidate;
    }
  }

  const pageCandidate = resolve(join(chapterDir, "pages", basename(imagePath)));
  if (
    existsSync(pageCandidate) &&
    isPathInside(chapterDir, pageCandidate) &&
    isSupportedImagePath(pageCandidate)
  ) {
    return pageCandidate;
  }

  const inpaintedCandidate = resolve(
    join(chapterDir, "inpainted", basename(imagePath)),
  );
  if (
    existsSync(inpaintedCandidate) &&
    isPathInside(chapterDir, inpaintedCandidate) &&
    isSupportedImagePath(inpaintedCandidate)
  ) {
    return inpaintedCandidate;
  }

  return null;
}

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}
