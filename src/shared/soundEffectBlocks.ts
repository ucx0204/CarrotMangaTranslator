import type { SoundEffectReview } from "./soundEffectReview";
import type { TranslationBlock } from "./textTypes";

export const LEGACY_REVIEWED_SOUND_EFFECT_NOTE =
  "저장된 효과음 검토 후보와 고정 영역을 사용한 전용 번역으로 생성됨.";

export function toPlainSoundEffectBlock(
  block: TranslationBlock,
): TranslationBlock {
  const plain = { ...block };
  delete plain.fontRole;
  delete plain.fontRoleConfidence;
  delete plain.inpaintExcluded;
  delete plain.reviewStatus;
  delete plain.reviewNote;
  return {
    ...plain,
    textRole: "sound",
    // SFX typography may choose a face/weight, but it must never opt back into
    // the editor's box-fitting shrink pass.
    autoFitText: false,
  };
}

function normalizeLegacyReviewedSoundEffectBlock(
  block: TranslationBlock,
  resolvedBlockIds: ReadonlySet<string>,
): TranslationBlock {
  if (
    !resolvedBlockIds.has(block.id) ||
    block.textRole !== "sound" ||
    block.inpaintExcluded !== true ||
    block.reviewStatus !== "needs_review" ||
    block.reviewNote !== LEGACY_REVIEWED_SOUND_EFFECT_NOTE
  ) {
    return block;
  }
  return toPlainSoundEffectBlock(block);
}

export function normalizeResolvedSoundEffectBlocksOnPage<
  TPage extends {
    blocks: TranslationBlock[];
    soundEffectReview?: SoundEffectReview;
  },
>(page: TPage): TPage {
  const resolvedBlockIds = new Set(
    page.soundEffectReview?.resolvedRegions.map((entry) => entry.blockId) ?? [],
  );
  if (resolvedBlockIds.size === 0) return page;
  return {
    ...page,
    blocks: page.blocks.map((block) =>
      normalizeLegacyReviewedSoundEffectBlock(block, resolvedBlockIds),
    ),
  };
}
