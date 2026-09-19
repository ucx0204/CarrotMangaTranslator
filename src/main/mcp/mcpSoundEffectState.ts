import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type {
  McpSoundEffectItem,
  McpSoundEffectChange,
} from "../../shared/mcpSoundEffects";
import { normalizeBboxTo1000 } from "../../shared/bboxNormalization";
import { normalizedRegionToPixelRect } from "../../shared/region";
import {
  normalizeSoundEffectReview,
  resolveEffectiveSoundEffectReviewRegions,
  resolvePendingSoundEffectReviewRegions,
} from "../../shared/soundEffectReview";
import { getActiveGeneratedLettering } from "../../shared/generatedLettering";
import { hashStableValue } from "../../shared/blockFingerprint";

export function soundEffectItems(page: MangaPage): McpSoundEffectItem[] {
  const blocks = page.blocks.map((block) => ({
    ...block,
    bbox: normalizeBboxTo1000(block.bbox, page, block.bboxSpace),
  }));
  const review = page.soundEffectReview
    ? normalizeSoundEffectReview(page.soundEffectReview)
    : undefined;
  const pending = new Set(
    resolvePendingSoundEffectReviewRegions(review, blocks).map(
      (region) => region.id,
    ),
  );
  const candidates: McpSoundEffectItem[] = review
    ? resolveEffectiveSoundEffectReviewRegions(review).map((region) => ({
        id: region.id,
        kind: "candidate",
        blockId:
          review.resolvedRegions.find((item) => item.regionId === region.id)
            ?.blockId ?? null,
        sourceText: region.recognizedText ?? "",
        translatedText: "",
        sourceRect: normalizedRegionToPixelRect(region.bbox, page, 1),
        state: review.resolvedRegions.some(
          (item) => item.regionId === region.id,
        )
          ? "resolved"
          : review.dismissedRegionIds?.includes(region.id)
            ? "excluded"
            : pending.has(region.id)
              ? "pending"
              : "overlap_hidden",
        imageState: "none",
        generationBlocked: false,
      }))
    : [];
  return [
    ...candidates,
    ...page.blocks
      .filter((block) => block.textRole === "sound")
      .map((block) => soundEffectBlockState(page, block)),
  ];
}
export function soundEffectBlockState(
  page: MangaPage,
  block: TranslationBlock,
): McpSoundEffectItem {
  return {
    id: block.id,
    kind: "block",
    blockId: block.id,
    sourceText: block.sourceText,
    translatedText: block.translatedText,
    state: "saved",
    generationBlocked: Boolean(block.imageGenerationBlocked),
    imageState: !block.generatedLettering
      ? "none"
      : getActiveGeneratedLettering(block)
        ? "active"
        : block.generatedLettering.enabled === false
          ? "disabled"
          : "stale",
    sourceRect: normalizedRegionToPixelRect(
      normalizeBboxTo1000(block.bbox, page, block.bboxSpace),
      page,
      1,
    ),
    renderRect: normalizedRegionToPixelRect(
      normalizeBboxTo1000(
        block.renderBbox ?? block.bbox,
        page,
        block.renderBbox
          ? (block.renderBboxSpace ?? block.bboxSpace)
          : block.bboxSpace,
      ),
      page,
      1,
    ),
  };
}
export function soundEffectChanges(
  before: MangaPage,
  after: MangaPage,
  action: string,
): McpSoundEffectChange[] {
  const a = soundEffectItems(before),
    b = soundEffectItems(after);
  const keys = [
    ...new Set([...a, ...b].map((item) => `${item.kind}:${item.id}`)),
  ];
  return keys.flatMap((key) => {
    const left = a.find((item) => `${item.kind}:${item.id}` === key);
    const right = b.find((item) => `${item.kind}:${item.id}` === key);
    const id = right?.id ?? left?.id ?? key;
    const imageChanged = layerHash(before, id) !== layerHash(after, id);
    if (
      hashStableValue(left ?? null) === hashStableValue(right ?? null) &&
      !imageChanged
    )
      return [];
    return [
      {
        pageId: before.id,
        id,
        action,
        before: project(left),
        after: project(right),
        changed: true,
        excludedReason: null,
        warnings: [
          "no_implicit_erasure_or_translation",
          "image_text_not_visually_verified",
        ],
      },
    ];
  });
}
function project(item: McpSoundEffectItem | undefined) {
  if (!item) return null;
  const { id: _id, kind: _kind, blockId: _blockId, ...state } = item;
  return state;
}

function layerHash(page: MangaPage, id: string) {
  return hashStableValue(
    page.blocks.find((block) => block.id === id)?.generatedLettering ?? null,
  );
}
