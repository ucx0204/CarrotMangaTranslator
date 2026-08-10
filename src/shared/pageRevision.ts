import { hashStableValue } from "./blockFingerprint";
import type { MangaPage } from "./libraryTypes";

export type PageRevision = `page-v1:${string}`;

export type PageJobTargetSnapshot = {
  chapterId: string;
  pageId: string;
  revision: PageRevision;
};

/**
 * Content consumed by translation and inpainting jobs. Runtime status, errors
 * and timestamps are deliberately excluded, so acquiring a job lock does not
 * invalidate the job that just acquired it.
 */
export function createPageRevision(
  page: Pick<
    MangaPage,
    | "id"
    | "imagePath"
    | "inpaintedImagePath"
    | "width"
    | "height"
    | "blocks"
    | "translationCompletion"
  >,
): PageRevision {
  return `page-v1:${hashStableValue({
    id: page.id,
    imagePath: page.imagePath,
    inpaintedImagePath: page.inpaintedImagePath,
    width: page.width,
    height: page.height,
    blocks: page.blocks,
    translationCompletion: page.translationCompletion,
  })}`;
}

export function createPageJobTargetSnapshot(
  chapterId: string,
  page: Parameters<typeof createPageRevision>[0],
): PageJobTargetSnapshot {
  return {
    chapterId,
    pageId: page.id,
    revision: createPageRevision(page),
  };
}
