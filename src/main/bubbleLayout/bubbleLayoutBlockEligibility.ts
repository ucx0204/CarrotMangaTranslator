import type { TranslationBlock } from "../../shared/textTypes";

export function isBubbleLayoutBlockEligible(
  block: TranslationBlock,
  blockId?: string,
): boolean {
  return (
    (!blockId || block.id === blockId) &&
    !block.inpaintExcluded &&
    !block.curveLayout &&
    Boolean(block.translatedText.trim()) &&
    block.bbox.w > 0 &&
    block.bbox.h > 0
  );
}
