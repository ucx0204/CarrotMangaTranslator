import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { hasUsableBbox } from "./maskGeometry";

export function isPatternInpaintingBlockEligible(
  block: TranslationBlock,
  blockId?: string,
): boolean {
  return (
    (!blockId || block.id === blockId) &&
    hasUsableBbox(block.bbox) &&
    (!block.inpaintExcluded || block.id === blockId)
  );
}

export function countEligiblePatternBlocks(
  page: Pick<MangaPage, "blocks">,
  blockId?: string,
): number {
  return page.blocks.reduce(
    (count, block) =>
      count + (isPatternInpaintingBlockEligible(block, blockId) ? 1 : 0),
    0,
  );
}

export function hasInvalidRequiredPatternBlock(
  page: Pick<MangaPage, "blocks">,
): boolean {
  return page.blocks.some(
    (block) => !block.inpaintExcluded && !hasUsableBbox(block.bbox),
  );
}
