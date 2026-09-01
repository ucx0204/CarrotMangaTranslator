import type { MangaPage } from "../../../shared/libraryTypes";
import {
  resolvePendingSoundEffectReviewRegions,
  reviewRegionConflictsWithBlock,
  type SoundEffectReviewRegion,
} from "../../../shared/soundEffectReview";

/**
 * Ordinary/translated blocks take priority over the noisy effect detector.
 * This removes the common case where an effect proposal crosses a balloon and
 * covers text that already has a real translation block.
 */
export function resolveVisibleSoundEffectReviewRegions(
  page: MangaPage | null | undefined,
): SoundEffectReviewRegion[] {
  return page
    ? resolvePendingSoundEffectReviewRegions(
        page.soundEffectReview,
        page.blocks,
      )
    : [];
}

function hasSoundEffectReviewHistory(
  page: MangaPage | null | undefined,
): boolean {
  const review = page?.soundEffectReview;
  return Boolean(
    review &&
    (review.regions.length > 0 ||
      review.manualRegions.length > 0 ||
      review.resolvedRegions.length > 0 ||
      (review.dismissedRegionIds?.length ?? 0) > 0),
  );
}

export function summarizeSoundEffectReviewChapter(
  pages: readonly MangaPage[],
): { available: boolean; pendingCount: number } {
  return {
    available: pages.some(hasSoundEffectReviewHistory),
    pendingCount: pages.reduce(
      (count, page) =>
        count + resolveVisibleSoundEffectReviewRegions(page).length,
      0,
    ),
  };
}

export { reviewRegionConflictsWithBlock };
