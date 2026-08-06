import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type { TranslationOptions } from "../appSettings";
import {
  createAutomaticFontPageCoordinatorV2,
  orderAutomaticFontMatchingPageItemIndexes,
  type AutomaticFontPageCoordinatorV2,
} from "./automaticFontMatchingV2PageCoordinator";
import { tMain } from "./localization";
import {
  buildOverlayBlockId,
  buildPageWarnings,
  overlayItemToBlock,
} from "./overlayItems";
import type {
  FontMatchingPageInferenceResult,
  VerifiedAutomaticFontPixelInferenceV2,
} from "./fontMatchingPagePixelInferenceTypes";
import { resolveVerifiedPixelInferenceForBlockId } from "./automaticFontMatchingV2RuntimeGate";
import type {
  CompletedPageBuildResult,
  OverlayItem,
  PageContextPayload,
} from "./types";

export function buildTranslatedPageResult({
  jobId,
  page,
  pageOptions,
  items,
  soundDroppedCount,
  validationDroppedCount,
  validationReasons,
  omittedCandidateIds,
  remappedCount,
  contextWarnings,
  pageContext,
  fontMatchingPageInference,
  fontMatchingChapterCoordinator,
}: {
  jobId: string;
  page: MangaPage;
  pageOptions: TranslationOptions;
  items: OverlayItem[];
  soundDroppedCount: number;
  validationDroppedCount: number;
  validationReasons: Record<string, number>;
  omittedCandidateIds?: number[];
  remappedCount?: number;
  contextWarnings: string[];
  pageContext?: PageContextPayload;
  fontMatchingPageInference?: FontMatchingPageInferenceResult;
  fontMatchingChapterCoordinator?: AutomaticFontPageCoordinatorV2;
}): CompletedPageBuildResult {
  const pixelInferences = collectPagePixelInferences({
    candidates: pageOptions.fontMatchingCandidates ?? [],
    enabled: pageOptions.autoFontMatching,
    fontMatchingPageInference,
    itemCount: items.length,
    jobId,
    page,
  });
  const pageCoordinator = resolvePageFontCoordinator(
    pageOptions.autoFontMatching,
    fontMatchingChapterCoordinator,
    items,
    pixelInferences,
  );
  const processingOrder = pageOptions.autoFontMatching
    ? orderAutomaticFontMatchingPageItemIndexes(items, pixelInferences)
    : items.map((_item, index) => index);
  const blocks = buildTranslatedBlocks({
    fontMatchingPageInference,
    items,
    jobId,
    page,
    pageCoordinator,
    pageOptions,
    pixelInferences,
    processingOrder,
  });
  return {
    kind: "completed",
    page: {
      ...page,
      blocks,
      analysisStatus: "completed",
      lastError: undefined,
      updatedAt: new Date().toISOString(),
    },
    warnings: [...buildPageWarnings(page.name, items), ...contextWarnings],
    detail: buildPageResultDetail(
      items.length,
      validationDroppedCount,
      soundDroppedCount,
      validationReasons,
      omittedCandidateIds ?? [],
      remappedCount ?? 0,
    ),
    pageContext,
  };
}

function buildTranslatedBlocks({
  fontMatchingPageInference,
  items,
  jobId,
  page,
  pageCoordinator,
  pageOptions,
  pixelInferences,
  processingOrder,
}: {
  fontMatchingPageInference?: FontMatchingPageInferenceResult;
  items: readonly OverlayItem[];
  jobId: string;
  page: MangaPage;
  pageCoordinator?: AutomaticFontPageCoordinatorV2;
  pageOptions: TranslationOptions;
  pixelInferences: readonly (
    | VerifiedAutomaticFontPixelInferenceV2
    | undefined
  )[];
  processingOrder: readonly number[];
}): TranslationBlock[] {
  const blocks = new Array<TranslationBlock>(items.length);
  for (const itemIndex of processingOrder) {
    blocks[itemIndex] = overlayItemToBlock(
      items[itemIndex],
      page,
      itemIndex,
      jobId,
      pageOptions.blockFormatDefaults,
      {
        enabled: pageOptions.naturalTextLayout,
        locale: pageOptions.targetLanguage,
      },
      {
        enabled: pageOptions.autoFontMatching,
        targetLanguage: pageOptions.targetLanguage,
        workId: pageOptions.fontMatchingWorkId,
        chapterId: pageOptions.fontMatchingChapterId,
        profile: pageOptions.fontMatchingProfile,
        candidates: pageOptions.fontMatchingCandidates,
        runtimeArtifactStatus: fontMatchingPageInference?.runtimeArtifactStatus,
        pixelInference: pixelInferences[itemIndex],
        ...(pageCoordinator ? { pageCoordinator } : {}),
      },
    );
  }
  return blocks;
}

function collectPagePixelInferences({
  candidates,
  enabled,
  fontMatchingPageInference,
  itemCount,
  jobId,
  page,
}: {
  candidates: NonNullable<TranslationOptions["fontMatchingCandidates"]>;
  enabled?: boolean;
  fontMatchingPageInference?: FontMatchingPageInferenceResult;
  itemCount: number;
  jobId: string;
  page: MangaPage;
}): Array<VerifiedAutomaticFontPixelInferenceV2 | undefined> {
  if (!enabled) return [];
  return Array.from({ length: itemCount }, (_unused, index) => {
    const blockId = buildOverlayBlockId(page.id, jobId, index);
    return (
      resolveVerifiedPixelInferenceForBlockId({
        blockId,
        candidates,
        inference:
          fontMatchingPageInference?.pixelInferenceByBlockId.get(blockId),
        page,
        status: fontMatchingPageInference?.runtimeArtifactStatus,
      }) ?? undefined
    );
  });
}

function resolvePageFontCoordinator(
  enabled: boolean | undefined,
  chapterCoordinator: AutomaticFontPageCoordinatorV2 | undefined,
  items: readonly OverlayItem[],
  pixelInferences: readonly (
    | VerifiedAutomaticFontPixelInferenceV2
    | undefined
  )[],
): AutomaticFontPageCoordinatorV2 | undefined {
  if (!enabled) return undefined;
  return createAutomaticFontPageCoordinatorV2({
    ...(chapterCoordinator ? { chapterCoordinator } : {}),
    items,
    pixelInferences,
  });
}

function buildPageResultDetail(
  blockCount: number,
  validationDroppedCount: number,
  soundDroppedCount: number,
  validationReasons: Record<string, number>,
  omittedCandidateIds: number[],
  remappedCount: number,
): string {
  const details = [tMain("units.blocks", { count: blockCount })];
  if (remappedCount > 0) {
    details.push(
      tMain("translation.result.remappedId", { count: remappedCount }),
    );
  }
  if (validationDroppedCount > 0) {
    details.push(
      tMain("translation.result.noiseDropped", {
        count: validationDroppedCount,
        reasons: formatValidationReasons(validationReasons),
      }),
    );
  }
  if (soundDroppedCount > 0) {
    details.push(
      tMain("translation.result.soundDropped", { count: soundDroppedCount }),
    );
  }
  if (omittedCandidateIds.length > 0) {
    details.push(
      tMain("translation.result.modelOmitted", {
        count: omittedCandidateIds.length,
      }),
    );
  }
  return details.join(", ");
}

function formatValidationReasons(reasons: Record<string, number>): string {
  const entries = Object.entries(reasons).filter(([, count]) => count > 0);
  return entries.length
    ? entries.map(([reason, count]) => `${reason}:${count}`).join("/")
    : "unknown";
}
