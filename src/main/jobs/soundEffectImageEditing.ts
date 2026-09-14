import type { TranslationBlock } from "../../shared/textTypes";
import { applyReviewedRegions } from "../codexImageEditing";
import type { DeferredSoundEffectPage } from "./soundEffectTranslationReview";

type Entry = {
  regionId: string;
  block: TranslationBlock;
  additionalBlocks?: TranslationBlock[];
};
/** Persist approved text and geometry before the independently checkpointed image phase. */
export function prepareSoundEffectPageEntries(
  page: DeferredSoundEffectPage,
  entries: Entry[],
): Entry[] {
  if (!page.reading) return entries;
  const reviewed = applyReviewedRegions(
    { ...page.target.page, blocks: entries.map((entry) => entry.block) },
    page.reading,
  );
  return editedEntries(entries, reviewed.blocks, page.reading);
}

function editedEntries(
  entries: Entry[],
  blocks: TranslationBlock[],
  reading: DeferredSoundEffectPage["reading"],
): Entry[] {
  const parents = new Map(
    reading?.regions.map((region) => [
      region.id,
      region.parentRegionId ?? region.id,
    ]),
  );
  return entries.flatMap((entry) => {
    const edited = blocks.filter(
      (block) => (parents.get(block.id) ?? block.id) === entry.block.id,
    );
    if (!edited.length) return reading ? [] : [entry];
    return [
      {
        regionId: entry.regionId,
        block: edited[0],
        ...(edited.length > 1 ? { additionalBlocks: edited.slice(1) } : {}),
      },
    ];
  });
}
