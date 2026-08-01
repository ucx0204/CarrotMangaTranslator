import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type { TranslationOptions } from "../appSettings";
import {
  createAutomaticFontPageCoordinatorV2,
  orderAutomaticFontMatchingPageItemIndexes,
} from "./automaticFontMatchingV2PageCoordinator";
import { tMain } from "./localization";
import { buildPageWarnings, overlayItemToBlock } from "./overlayItems";
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
  contextWarnings,
  pageContext,
}: {
  jobId: string;
  page: MangaPage;
  pageOptions: TranslationOptions;
  items: OverlayItem[];
  soundDroppedCount: number;
  validationDroppedCount: number;
  validationReasons: Record<string, number>;
  contextWarnings: string[];
  pageContext?: PageContextPayload;
}): CompletedPageBuildResult {
  const pageCoordinator = pageOptions.autoFontMatching
    ? createAutomaticFontPageCoordinatorV2()
    : undefined;
  const processingOrder = pageOptions.autoFontMatching
    ? orderAutomaticFontMatchingPageItemIndexes(items)
    : items.map((_item, index) => index);
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
        ...(pageCoordinator ? { pageCoordinator } : {}),
      },
    );
  }
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
    ),
    pageContext,
  };
}

function buildPageResultDetail(
  blockCount: number,
  validationDroppedCount: number,
  soundDroppedCount: number,
  validationReasons: Record<string, number>,
): string {
  const details = [tMain("units.blocks", { count: blockCount })];
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
  return details.join(", ");
}

function formatValidationReasons(reasons: Record<string, number>): string {
  const entries = Object.entries(reasons).filter(([, count]) => count > 0);
  return entries.length
    ? entries.map(([reason, count]) => `${reason}:${count}`).join("/")
    : "unknown";
}
