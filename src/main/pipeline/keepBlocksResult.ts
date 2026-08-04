import { bboxToPixels, clamp } from "../../shared/geometry";
import type { TranslationBlock } from "../../shared/textTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { applyNaturalTextLayout } from "../../shared/naturalTextLayout";
import type { PreviousOverlayBlockForPrompt } from "../appSettings";
import { tMain } from "./localization";
import { buildPageWarnings } from "./overlayItems";
import { resolveAutomaticFontDecisionV2 } from "./automaticFontMatchingV2";
import { applyAutomaticFontDecisionV2 } from "./automaticFontMatchingV2Apply";
import {
  createAutomaticFontPageCoordinatorV2,
  orderAutomaticFontMatchingPageItemIndexes,
} from "./automaticFontMatchingV2PageCoordinator";
import { resolveVerifiedPixelInferenceForBlockId } from "./automaticFontMatchingV2RuntimeGate";
import { assignItemsToExistingBlocks } from "./keepBlocksAssignment";
import type { KeepBlocksAutomaticFontOptions } from "./keepBlocksAutomaticFont";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "./fontMatchingPagePixelInferenceTypes";
import type { OcrBboxResult, OverlayItem } from "./types";

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
  automaticFont?: KeepBlocksAutomaticFontOptions;
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
  automaticFont?: KeepBlocksAutomaticFontOptions;
}): KeepBlocksMappingResult {
  const itemByBlockIndex = assignItemsToExistingBlocks({
    items,
    page,
    previousBlocks,
  });
  const textRoleByBlockId = new Map(
    previousBlocks.map((block) => [block.previousId, block.textRole] as const),
  );
  const assignments = [...itemByBlockIndex.entries()]
    .map(([blockIndex, indexed]) => ({ blockIndex, ...indexed }))
    .sort((left, right) => left.itemIndex - right.itemIndex);
  const verifiedPixelInferences = collectVerifiedKeepBlocksPixelInferences({
    assignments,
    automaticFont,
    page,
  });
  const pageAutomaticFont = resolveKeepBlocksPageAutomaticFont({
    automaticFont,
    items: assignments.map(({ item }) => item),
    verifiedPixelInferences,
  });
  const processingOrder = automaticFont?.enabled
    ? orderAutomaticFontMatchingPageItemIndexes(
        assignments.map(({ item }) => item),
        verifiedPixelInferences,
      )
    : assignments.map((_assignment, index) => index);
  const blocks = [...page.blocks];
  for (const assignmentIndex of processingOrder) {
    const { blockIndex, item } = assignments[assignmentIndex];
    const block = page.blocks[blockIndex];
    if (!block) continue;
    const previousTextRole = block.textRole ?? textRoleByBlockId.get(block.id);
    const effectiveTextRole =
      normalizePersistentTextRole(item.textRole) ??
      normalizePersistentTextRole(previousTextRole);
    blocks[blockIndex] = applyOverlayItemToExistingBlock({
      automaticFont: pageAutomaticFont,
      block,
      item,
      naturalLayout,
      page,
      effectiveTextRole,
      skipNaturalLayout:
        Boolean(block.curveLayout) || effectiveTextRole === "sound",
    });
  }

  return {
    blocks,
    updatedCount: itemByBlockIndex.size,
    keptCount: page.blocks.length - itemByBlockIndex.size,
    droppedItemCount: items.length - itemByBlockIndex.size,
  };
}

type KeepBlocksAssignment = Readonly<{
  blockIndex: number;
  item: OverlayItem;
  itemIndex: number;
}>;

function collectVerifiedKeepBlocksPixelInferences({
  assignments,
  automaticFont,
  page,
}: {
  assignments: readonly KeepBlocksAssignment[];
  automaticFont?: KeepBlocksAutomaticFontOptions;
  page: MangaPage;
}): Array<VerifiedAutomaticFontPixelInferenceV2 | undefined> {
  if (!automaticFont?.enabled) return [];
  const candidates = automaticFont.candidates ?? [];
  return assignments.map(({ blockIndex }) => {
    const blockId = page.blocks[blockIndex]?.id;
    if (!blockId) return undefined;
    return (
      resolveVerifiedPixelInferenceForBlockId({
        blockId,
        candidates,
        inference:
          automaticFont.pageInference?.pixelInferenceByBlockId.get(blockId),
        page,
        status: automaticFont.pageInference?.runtimeArtifactStatus,
      }) ?? undefined
    );
  });
}

function resolveKeepBlocksPageAutomaticFont({
  automaticFont,
  items,
  verifiedPixelInferences,
}: {
  automaticFont?: KeepBlocksAutomaticFontOptions;
  items: readonly OverlayItem[];
  verifiedPixelInferences: readonly (
    | VerifiedAutomaticFontPixelInferenceV2
    | undefined
  )[];
}): KeepBlocksAutomaticFontOptions | undefined {
  if (!automaticFont?.enabled) return automaticFont;
  const verifiedByBlockId = new Map(
    verifiedPixelInferences.flatMap((inference) =>
      inference ? [[inference.blockId, inference] as const] : [],
    ),
  );
  return {
    ...automaticFont,
    pageCoordinator: createAutomaticFontPageCoordinatorV2({
      ...(automaticFont.pageCoordinator
        ? { chapterCoordinator: automaticFont.pageCoordinator }
        : {}),
      items,
      pixelInferences: verifiedPixelInferences,
    }),
    pageInference: {
      runtimeArtifactStatus: automaticFont.pageInference?.runtimeArtifactStatus,
      pixelInferenceByBlockId: verifiedByBlockId,
    },
  };
}

function applyOverlayItemToExistingBlock({
  automaticFont,
  block,
  item,
  naturalLayout,
  page,
  effectiveTextRole,
  skipNaturalLayout,
}: {
  automaticFont?: KeepBlocksAutomaticFontOptions;
  block: TranslationBlock;
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
    ...(item.fontRole
      ? {
          fontRole: item.fontRole,
          fontRoleConfidence: normalizeItemConfidence(
            item.fontRoleConfidence,
            0,
          ),
        }
      : {}),
    ...(item.visualClusterId ? { visualClusterId: item.visualClusterId } : {}),
    confidence: normalizeItemConfidence(item.confidence, block.confidence),
  };
  const itemWithPersistedIntent =
    item.fontRole || !block.fontRole
      ? item
      : {
          ...item,
          fontRole: block.fontRole,
          fontRoleConfidence: block.fontRoleConfidence,
        };
  const fontDecision = resolveKeepBlocksFontDecision({
    automaticFont,
    block: textUpdated,
    item: effectiveTextRole
      ? { ...itemWithPersistedIntent, textRole: effectiveTextRole }
      : itemWithPersistedIntent,
    page,
  });
  const updated = applyAutomaticFontDecisionV2(textUpdated, fontDecision);
  if (!naturalLayout?.enabled || skipNaturalLayout) {
    return updated;
  }
  const layout = applyNaturalTextLayout(updated, {
    enabled: true,
    pageSize: { width: page.width, height: page.height },
    locale: naturalLayout.locale,
    allowAutoVertical: false,
    directionPreference: block.renderDirection,
    fontMetricWidthScale:
      fontDecision?.result.decision.mode === "apply"
        ? fontDecision.fontMetricWidthScale
        : undefined,
  });
  return { ...updated, translatedText: layout.translatedText };
}

function resolveKeepBlocksFontDecision({
  automaticFont,
  block,
  item,
  page,
}: {
  automaticFont?: KeepBlocksAutomaticFontOptions;
  block: TranslationBlock;
  item: OverlayItem;
  page: MangaPage;
}) {
  return automaticFont?.enabled
    ? resolveAutomaticFontDecisionV2({
        block,
        item,
        page,
        options: {
          ...automaticFont,
          pageCoordinator: automaticFont.pageCoordinator,
          runtimeArtifactStatus:
            automaticFont.pageInference?.runtimeArtifactStatus,
          pixelInference:
            automaticFont.pageInference?.pixelInferenceByBlockId.get(block.id),
        },
      })
    : undefined;
}

function normalizePersistentTextRole(
  value: unknown,
): TranslationBlock["textRole"] {
  if (value === "ordinary" || value === "sound") return value;
  return undefined;
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
