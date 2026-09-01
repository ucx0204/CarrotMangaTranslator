import type { PrepareSoundEffectTranslationRequest } from "../../../shared/analysisTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import { createSoundEffectReviewPageRevision } from "../../../shared/pageRevision";
import { resolvePendingSoundEffectReviewRegions } from "../../../shared/soundEffectReview";
import type { BBox } from "../../../shared/textTypes";
import type { SoundEffectDraftPage } from "./soundEffectTranslationDraftModel";

export function createSoundEffectDraftPages(
  chapter: ChapterSnapshot,
): SoundEffectDraftPage[] {
  return chapter.pages.map((page, index) => {
    const pending = resolvePendingSoundEffectReviewRegions(
      page.soundEffectReview,
      page.blocks,
    );
    const manualIds = new Set(
      page.soundEffectReview?.manualRegions.map((region) => region.id) ?? [],
    );
    return {
      page,
      index,
      regions: pending.map((region) => ({
        ...region,
        bbox: { ...region.bbox },
        originalBbox: { ...region.bbox },
        manual: manualIds.has(region.id),
        newlyAdded: false,
        included: true,
        deleted: false,
      })),
    };
  });
}

export function buildPrepareRequest(
  chapterId: string,
  draftPages: SoundEffectDraftPage[],
): PrepareSoundEffectTranslationRequest {
  return {
    chapterId,
    pages: draftPages.flatMap(buildPreparePage),
  };
}

function buildPreparePage(
  item: SoundEffectDraftPage,
): PrepareSoundEffectTranslationRequest["pages"] {
  const persisted = item.regions.filter((region) => !region.newlyAdded);
  const additions = item.regions.filter(
    (region) => region.newlyAdded && !region.deleted && region.included,
  );
  if (persisted.length === 0 && additions.length === 0) return [];
  return [
    {
      pageId: item.page.id,
      pageRevision: createSoundEffectReviewPageRevision(item.page),
      includedRegionIds: [
        ...persisted
          .filter((region) => !region.deleted && region.included)
          .map((region) => region.id),
        ...additions.map((region) => region.id),
      ],
      editedRegions: persisted.flatMap((region) =>
        isEditedIncludedRegion(region)
          ? [{ regionId: region.id, bbox: region.bbox }]
          : [],
      ),
      addedRegions: additions.map((region) => ({
        regionId: region.id,
        bbox: region.bbox,
      })),
      dismissedRegionIds: persisted
        .filter((region) => region.deleted || !region.included)
        .map((region) => region.id),
    },
  ];
}

function isEditedIncludedRegion(
  region: SoundEffectDraftPage["regions"][number],
): boolean {
  return Boolean(
    !region.deleted &&
    region.included &&
    region.originalBbox &&
    !sameBbox(region.originalBbox, region.bbox),
  );
}

function sameBbox(left: BBox, right: BBox): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.w === right.w &&
    left.h === right.h
  );
}
