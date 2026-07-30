import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationOptions } from "../appSettings";
import { tMain } from "./localization";
import { buildPageWarnings, overlayItemToBlock } from "./overlayItems";
import { buildAutomaticBodyTextCorpus } from "./automaticFontMatching";
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
  const blocks = items.map((item, itemIndex) =>
    overlayItemToBlock(
      item,
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
        workTitle: pageOptions.fontMatchingWorkTitle,
        bodyTextCorpus: buildAutomaticBodyTextCorpus(items),
        candidates: pageOptions.fontMatchingCandidates,
      },
    ),
  );
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
