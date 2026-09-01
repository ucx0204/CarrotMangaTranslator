import type { TranslationBlock } from "../../shared/textTypes";
import { toPlainSoundEffectBlock } from "../../shared/soundEffectBlocks";

export function toReviewedSoundEffectBlock(
  block: TranslationBlock,
): TranslationBlock {
  return toPlainSoundEffectBlock(block);
}
