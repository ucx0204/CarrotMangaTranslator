import { bboxOverlapRatio, normalizeBboxTo1000 } from "../../shared/geometry";
import type { MangaPage } from "../../shared/libraryTypes";
import type { PreviousOverlayBlockForPrompt } from "../appSettings";
import type { FontMatchingPageInferenceBlock } from "./fontMatchingPagePixelInferenceTypes";
import type { OverlayItem } from "./types";

const FALLBACK_MATCH_MIN_OVERLAP = 0.3;

export type IndexedOverlayItem = Readonly<{
  item: OverlayItem;
  itemIndex: number;
}>;

/** Bind keep-mode pixel crops to the persistent block ids used by locks/audit. */
export function buildKeepBlocksFontInferenceBlocks({
  page,
  items,
  previousBlocks,
}: {
  page: MangaPage;
  items: readonly OverlayItem[];
  previousBlocks: PreviousOverlayBlockForPrompt[];
}): FontMatchingPageInferenceBlock[] {
  const assigned = assignItemsToExistingBlocks({
    items,
    page,
    previousBlocks,
  });
  return [...assigned.entries()]
    .map(([blockIndex, indexed]) => ({
      blockId: page.blocks[blockIndex]?.id,
      indexed,
    }))
    .filter(
      (entry): entry is { blockId: string; indexed: IndexedOverlayItem } =>
        Boolean(entry.blockId),
    )
    .sort((left, right) => left.indexed.itemIndex - right.indexed.itemIndex)
    .map(({ blockId, indexed }) => ({ blockId, item: indexed.item }));
}

export function assignItemsToExistingBlocks({
  items,
  page,
  previousBlocks,
}: {
  items: readonly OverlayItem[];
  page: MangaPage;
  previousBlocks: PreviousOverlayBlockForPrompt[];
}): Map<number, IndexedOverlayItem> {
  const blockIndexByCandidateId = buildBlockIndexByCandidateId(
    page,
    previousBlocks,
  );
  const itemByBlockIndex = new Map<number, IndexedOverlayItem>();
  const unmatchedItems: IndexedOverlayItem[] = [];
  items.forEach((item, itemIndex) => {
    const blockIndex = blockIndexByCandidateId.get(item.id);
    const indexed = { item, itemIndex };
    if (blockIndex !== undefined && !itemByBlockIndex.has(blockIndex)) {
      itemByBlockIndex.set(blockIndex, indexed);
    } else {
      unmatchedItems.push(indexed);
    }
  });
  matchRemainingItemsByOverlap(page, unmatchedItems, itemByBlockIndex);
  return itemByBlockIndex;
}

function buildBlockIndexByCandidateId(
  page: MangaPage,
  previousBlocks: PreviousOverlayBlockForPrompt[],
): Map<number, number> {
  const blockIndexById = new Map(
    page.blocks.map((block, index) => [block.id, index]),
  );
  const mapping = new Map<number, number>();
  for (const previous of previousBlocks) {
    const blockIndex = blockIndexById.get(previous.previousId);
    if (
      previous.candidateId !== undefined &&
      blockIndex !== undefined &&
      !mapping.has(previous.candidateId)
    ) {
      mapping.set(previous.candidateId, blockIndex);
    }
  }
  return mapping;
}

function matchRemainingItemsByOverlap(
  page: MangaPage,
  unmatchedItems: IndexedOverlayItem[],
  itemByBlockIndex: Map<number, IndexedOverlayItem>,
): void {
  for (const indexed of unmatchedItems) {
    const { item } = indexed;
    let bestIndex = -1;
    let bestScore = FALLBACK_MATCH_MIN_OVERLAP;
    for (const [index, block] of page.blocks.entries()) {
      if (itemByBlockIndex.has(index)) continue;
      const blockBbox = normalizeBboxTo1000(
        block.bbox,
        { width: page.width, height: page.height },
        block.bboxSpace,
      );
      const score = bboxOverlapRatio(item.bbox, blockBbox);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) itemByBlockIndex.set(bestIndex, indexed);
  }
}
