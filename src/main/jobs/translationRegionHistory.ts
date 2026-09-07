import type { MangaPage } from "../../shared/libraryTypes";
import { createPageRevision } from "../../shared/pageRevision";
import type { InpaintingRevisionStore } from "../inpainting/inpaintingRevisionStore";

export function recordRegionTranslationHistory(
  store: InpaintingRevisionStore | undefined,
  chapterId: string,
  before: MangaPage,
  after: MangaPage,
) {
  if (!store || createPageRevision(before) === createPageRevision(after))
    return undefined;
  const transaction = store.beginTransaction();
  store.addChange(transaction, {
    chapterId,
    pageId: before.id,
    beforeRevision: createPageRevision(before),
    afterRevision: createPageRevision(after),
    beforePath: before.inpaintedImagePath,
    afterPath: after.inpaintedImagePath,
    beforeMaskPath: before.inpaintMaskPath,
    afterMaskPath: after.inpaintMaskPath,
    beforeMaskProvenance: before.maskProvenance,
    afterMaskProvenance: after.maskProvenance,
    beforeBlocks: before.blocks,
    afterBlocks: after.blocks,
    beforeTranslationCompletion: before.translationCompletion,
    afterTranslationCompletion: after.translationCompletion,
  });
  return store.getReference(transaction);
}
