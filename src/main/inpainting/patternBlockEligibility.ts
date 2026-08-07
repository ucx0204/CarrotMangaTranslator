import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { normalizeTranslationCompletionReferences } from "../translationCompletionReferences";
import { hasUsableBbox } from "./maskGeometry";

export function isPatternInpaintingBlockEligible(
  block: TranslationBlock,
  blockId?: string,
  excludedBlockIds?: readonly string[],
): boolean {
  return (
    (!blockId || block.id === blockId) &&
    (blockId !== undefined || !excludedBlockIds?.includes(block.id)) &&
    hasUsableBbox(block.bbox) &&
    (!block.inpaintExcluded || block.id === blockId)
  );
}

export function resolveEligiblePatternBlocks(
  page: Pick<MangaPage, "blocks">,
  blockId?: string,
  excludedBlockIds?: readonly string[],
): TranslationBlock[] {
  return page.blocks.filter((block) =>
    isPatternInpaintingBlockEligible(block, blockId, excludedBlockIds),
  );
}

export function countEligiblePatternBlocks(
  page: Pick<MangaPage, "blocks">,
  blockId?: string,
  excludedBlockIds?: readonly string[],
): number {
  return resolveEligiblePatternBlocks(page, blockId, excludedBlockIds).length;
}

export function hasInvalidRequiredPatternBlock(
  page: Pick<MangaPage, "blocks">,
): boolean {
  return page.blocks.some(
    (block) => !block.inpaintExcluded && !hasUsableBbox(block.bbox),
  );
}

export function shouldUseOriginalPatternImage(
  page: Pick<
    MangaPage,
    "blocks" | "inpaintedImagePath" | "translationCompletion"
  >,
): boolean {
  const completion = normalizeTranslationCompletionReferences(
    page.translationCompletion,
    page.blocks,
  );
  return Boolean(
    page.inpaintedImagePath &&
    completion?.status === "pending" &&
    !completion.erasedBlockIds?.length,
  );
}
