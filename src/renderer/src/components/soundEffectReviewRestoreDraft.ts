import type { RestoreSoundEffectReviewRequest } from "../../../shared/analysisTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import { createSoundEffectReviewPageRevision } from "../../../shared/pageRevision";
import { normalizeSoundEffectReview } from "../../../shared/soundEffectReview";
import { createSoundEffectDraftPages } from "./soundEffectTranslationDraft";
import type { SoundEffectDraftPage } from "./soundEffectTranslationDraftModel";

export function buildRestoreSoundEffectReviewRequest(
  chapterId: string,
  drafts: SoundEffectDraftPage[],
): RestoreSoundEffectReviewRequest {
  return {
    chapterId,
    pages: drafts.flatMap(({ page }) => {
      if (!page.soundEffectReview) return [];
      const review = normalizeSoundEffectReview(page.soundEffectReview);
      const known = new Set(
        [...review.regions, ...review.manualRegions].map((region) => region.id),
      );
      const resolved = new Set(
        review.resolvedRegions.map((region) => region.regionId),
      );
      const regionIds = (review.dismissedRegionIds ?? []).filter(
        (id) => known.has(id) && !resolved.has(id),
      );
      return regionIds.length
        ? [
            {
              pageId: page.id,
              pageRevision: createSoundEffectReviewPageRevision(page),
              regionIds,
            },
          ]
        : [];
    }),
  };
}

export function restoreSoundEffectDraftPages(
  current: SoundEffectDraftPage[],
  chapter: ChapterSnapshot,
): SoundEffectDraftPage[] {
  const previous = new Map(current.map((item) => [item.page.id, item.regions]));
  return createSoundEffectDraftPages(chapter).map((item) => {
    const old = previous.get(item.page.id) ?? [];
    const oldById = new Map(old.map((region) => [region.id, region]));
    const restored = item.regions.map((region) => ({
      ...region,
      ...oldById.get(region.id),
      included: true,
      deleted: false,
    }));
    return {
      ...item,
      regions: [
        ...restored,
        ...old
          .filter((region) => region.newlyAdded)
          .map((region) => ({ ...region, included: true, deleted: false })),
      ],
    };
  });
}
