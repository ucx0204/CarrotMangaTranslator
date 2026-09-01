import { hashStableValue } from "./blockFingerprint";
import type { MangaPage } from "./libraryTypes";
import type { PageRevision } from "./pageRevisionTypes";

export type PageVisualRevision = `page-visual-v1:${string}`;

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
    | "inpaintMaskPath"
    | "maskProvenance"
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
    inpaintMaskPath: page.inpaintMaskPath,
    maskProvenance: page.maskProvenance,
    width: page.width,
    height: page.height,
    blocks: page.blocks,
    translationCompletion: page.translationCompletion,
  })}`;
}

/**
 * Only values that can change page pixels belong in this revision. Source OCR,
 * review metadata and other workflow-only fields are intentionally removed.
 */
export function createPageVisualRevision(
  page: Pick<
    MangaPage,
    | "id"
    | "imagePath"
    | "inpaintedImagePath"
    | "width"
    | "height"
    | "blocks"
    | "blockOrder"
  >,
): PageVisualRevision {
  const blocks = page.blocks.map(
    ({
      sourceText: _sourceText,
      confidence: _confidence,
      reviewStatus: _reviewStatus,
      reviewNote: _reviewNote,
      speakerId: _speakerId,
      glossaryEntryIds: _glossaryEntryIds,
      ...visual
    }) => visual,
  );
  return `page-visual-v1:${hashStableValue({
    id: page.id,
    imagePath: page.imagePath,
    inpaintedImagePath: page.inpaintedImagePath,
    width: page.width,
    height: page.height,
    blocks,
    blockOrder: page.blockOrder,
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

/**
 * SFX jobs also consume persisted detector candidates and their resolution
 * ledger. Keep this separate from the normal translation revision so review
 * metadata does not invalidate unrelated translation checkpoints.
 */
export function createSoundEffectReviewPageRevision(
  page: Parameters<typeof createPageRevision>[0] &
    Pick<MangaPage, "soundEffectReview">,
): PageRevision {
  return `page-v1:${hashStableValue({
    base: createPageRevision(page),
    soundEffectReview: page.soundEffectReview,
  })}`;
}
