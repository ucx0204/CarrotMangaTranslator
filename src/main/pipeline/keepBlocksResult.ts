import {
  bboxOverlapRatio,
  bboxToPixels,
  clamp,
  normalizeBboxTo1000,
} from "../../shared/geometry";
import type { TranslationBlock } from "../../shared/textTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { applyNaturalTextLayout } from "../../shared/naturalTextLayout";
import type { PreviousOverlayBlockForPrompt } from "../appSettings";
import { tMain } from "./localization";
import {
  buildPageWarnings,
  type OverlayAutomaticFontOptions,
} from "./overlayItems";
import {
  buildAutomaticBodyTextCorpus,
  resolveAutomaticFontDecision,
} from "./automaticFontMatching";
import type { OcrBboxResult, OverlayItem } from "./types";

const FALLBACK_MATCH_MIN_OVERLAP = 0.3;

export type KeepBlocksMappingResult = {
  blocks: TranslationBlock[];
  updatedCount: number;
  keptCount: number;
  droppedItemCount: number;
};

type KeepBlocksNaturalLayoutOptions = {
  enabled?: boolean;
  locale?: string;
};

export function shouldKeepExistingBlocks(
  blockMode: "auto" | "keep" | undefined,
  page: MangaPage,
): boolean {
  return blockMode === "keep" && page.blocks.length > 0;
}

/**
 * Synthetic OCR prepass result built from the page's existing blocks so the
 * model anchors to exactly those regions. Hint id i+1 maps to page.blocks[i].
 * `ocrTexts[i]`(블록별 크롭 OCR 텍스트)가 있으면 읽기 증거로 함께 부착한다.
 */
export function buildKeepBlocksOcrResult(
  page: MangaPage,
  ocrTexts?: (string | undefined)[],
): OcrBboxResult {
  const hints = page.blocks.map((block, index) => {
    const rect =
      block.bboxSpace === "pixels"
        ? block.bbox
        : bboxToPixels(block.bbox, page.width, page.height);
    const ocrText = ocrTexts?.[index];
    return {
      id: index + 1,
      label: "block",
      x1: Math.round(rect.x),
      y1: Math.round(rect.y),
      x2: Math.round(rect.x + rect.w),
      y2: Math.round(rect.y + rect.h),
      score: 1,
      ...(ocrText ? { ocrText } : {}),
    };
  });
  return {
    hints,
    diagnostics: [{ provider: "keep-blocks", reason: "existing-page-blocks" }],
    noTextDetected: false,
    textEvidenceCount: hints.length,
  };
}

/**
 * keep 모드의 완료 페이지 결과: 기존 블록에 텍스트만 갱신된 page와
 * 상태 로그용 detail을 만든다.
 */
export function buildKeepBlocksCompletedPage({
  page,
  items,
  previousBlocks,
  soundDroppedCount,
  naturalLayout,
  automaticFont,
}: {
  page: MangaPage;
  items: OverlayItem[];
  previousBlocks: PreviousOverlayBlockForPrompt[];
  soundDroppedCount: number;
  naturalLayout?: KeepBlocksNaturalLayoutOptions;
  automaticFont?: OverlayAutomaticFontOptions;
}): { page: MangaPage; warnings: string[]; detail: string } {
  const mapping = applyOverlayItemsToExistingBlocks({
    page,
    items,
    previousBlocks,
    naturalLayout,
    automaticFont,
  });
  return {
    page: {
      ...page,
      blocks: mapping.blocks,
      analysisStatus: "completed",
      lastError: undefined,
      updatedAt: new Date().toISOString(),
    },
    warnings: buildPageWarnings(page.name, items),
    detail: buildKeepBlocksResultDetail(mapping, soundDroppedCount),
  };
}

function buildKeepBlocksResultDetail(
  mapping: KeepBlocksMappingResult,
  soundDroppedCount: number,
): string {
  const details = [
    tMain("translation.result.existingUpdated", {
      count: mapping.updatedCount,
    }),
  ];
  if (mapping.keptCount > 0) {
    details.push(
      tMain("translation.result.kept", { count: mapping.keptCount }),
    );
  }
  if (mapping.droppedItemCount > 0) {
    details.push(
      tMain("translation.result.outsideDropped", {
        count: mapping.droppedItemCount,
      }),
    );
  }
  if (soundDroppedCount > 0) {
    details.push(
      tMain("translation.result.soundDropped", { count: soundDroppedCount }),
    );
  }
  return details.join(", ");
}

/**
 * Maps model output items back onto the page's existing blocks: matched
 * blocks get fresh text, unmatched blocks stay untouched, and items without
 * a block are dropped so no new blocks are ever created.
 */
export function applyOverlayItemsToExistingBlocks({
  page,
  items,
  previousBlocks,
  naturalLayout,
  automaticFont,
}: {
  page: MangaPage;
  items: OverlayItem[];
  previousBlocks: PreviousOverlayBlockForPrompt[];
  naturalLayout?: KeepBlocksNaturalLayoutOptions;
  automaticFont?: OverlayAutomaticFontOptions;
}): KeepBlocksMappingResult {
  const blockIndexByCandidateId = buildBlockIndexByCandidateId(
    page,
    previousBlocks,
  );
  const itemByBlockIndex = new Map<number, OverlayItem>();
  const unmatchedItems: OverlayItem[] = [];
  const textRoleByBlockId = new Map(
    previousBlocks.map((block) => [block.previousId, block.textRole] as const),
  );

  for (const item of items) {
    const blockIndex = blockIndexByCandidateId.get(item.id);
    if (blockIndex !== undefined && !itemByBlockIndex.has(blockIndex)) {
      itemByBlockIndex.set(blockIndex, item);
    } else {
      unmatchedItems.push(item);
    }
  }
  matchRemainingItemsByOverlap(page, unmatchedItems, itemByBlockIndex);
  const bodyTextCorpus = buildKeepBlocksBodyTextCorpus(
    page,
    itemByBlockIndex,
    textRoleByBlockId,
  );

  const blocks = page.blocks.map((block, index) => {
    const item = itemByBlockIndex.get(index);
    const previousTextRole = block.textRole ?? textRoleByBlockId.get(block.id);
    const effectiveTextRole =
      normalizePersistentTextRole(item?.textRole) ??
      normalizePersistentTextRole(previousTextRole);
    return item
      ? applyOverlayItemToExistingBlock({
          automaticFont,
          block,
          bodyTextCorpus,
          item,
          naturalLayout,
          page,
          effectiveTextRole,
          skipNaturalLayout:
            Boolean(block.curveLayout) || effectiveTextRole === "sound",
        })
      : block;
  });

  return {
    blocks,
    updatedCount: itemByBlockIndex.size,
    keptCount: page.blocks.length - itemByBlockIndex.size,
    droppedItemCount: items.length - itemByBlockIndex.size,
  };
}

function applyOverlayItemToExistingBlock({
  automaticFont,
  block,
  bodyTextCorpus,
  item,
  naturalLayout,
  page,
  effectiveTextRole,
  skipNaturalLayout,
}: {
  automaticFont?: OverlayAutomaticFontOptions;
  block: TranslationBlock;
  bodyTextCorpus: string;
  item: OverlayItem;
  naturalLayout?: KeepBlocksNaturalLayoutOptions;
  page: MangaPage;
  effectiveTextRole?: TranslationBlock["textRole"];
  skipNaturalLayout: boolean;
}): TranslationBlock {
  const textUpdated = {
    ...block,
    sourceText: item.jp.trim(),
    translatedText: item.ko.trim(),
    ...(effectiveTextRole ? { textRole: effectiveTextRole } : {}),
    confidence: normalizeItemConfidence(item.confidence, block.confidence),
  };
  const fontDecision = automaticFont?.enabled
    ? resolveAutomaticFontDecision({
        item: effectiveTextRole
          ? { ...item, textRole: effectiveTextRole }
          : item,
        page,
        bodyTextCorpus,
        workTitle: automaticFont.workTitle,
        targetLanguage: automaticFont.targetLanguage,
        candidates: automaticFont.candidates,
      })
    : undefined;
  const updated = fontDecision
    ? { ...textUpdated, fontFamily: fontDecision.fontId }
    : textUpdated;
  if (!naturalLayout?.enabled || skipNaturalLayout) {
    return updated;
  }
  const layout = applyNaturalTextLayout(updated, {
    enabled: true,
    pageSize: { width: page.width, height: page.height },
    locale: naturalLayout.locale,
    allowAutoVertical: false,
    directionPreference: block.renderDirection,
    fontMetricWidthScale: fontDecision?.fontMetricWidthScale,
  });
  return { ...updated, translatedText: layout.translatedText };
}

function buildKeepBlocksBodyTextCorpus(
  page: MangaPage,
  itemByBlockIndex: ReadonlyMap<number, OverlayItem>,
  textRoleByBlockId: ReadonlyMap<
    string,
    PreviousOverlayBlockForPrompt["textRole"]
  >,
): string {
  const matchedItems = [...itemByBlockIndex].map(([index, item]) => {
    const textRole =
      normalizePersistentTextRole(item.textRole) ??
      page.blocks[index]?.textRole ??
      normalizePersistentTextRole(
        textRoleByBlockId.get(page.blocks[index]?.id),
      );
    return textRole ? { ...item, textRole } : item;
  });
  return buildAutomaticBodyTextCorpus(matchedItems);
}

function normalizePersistentTextRole(
  value: unknown,
): TranslationBlock["textRole"] {
  if (value === "ordinary" || value === "sound") return value;
  return undefined;
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
  unmatchedItems: OverlayItem[],
  itemByBlockIndex: Map<number, OverlayItem>,
): void {
  for (const item of unmatchedItems) {
    let bestIndex = -1;
    let bestScore = FALLBACK_MATCH_MIN_OVERLAP;
    for (const [index, block] of page.blocks.entries()) {
      if (itemByBlockIndex.has(index)) {
        continue;
      }
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
    if (bestIndex >= 0) {
      itemByBlockIndex.set(bestIndex, item);
    }
  }
}

function normalizeItemConfidence(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const normalized = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
  return clamp(normalized, 0, 1);
}
