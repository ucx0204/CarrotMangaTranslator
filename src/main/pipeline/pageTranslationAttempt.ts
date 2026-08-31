import type { TranslationOptions } from "../appSettings";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  finalizePreparedPageResult,
  preparePageResult,
  requestPageTranslation,
  type PreparedPageBuildResult,
} from "./pageResultBuilder";
import {
  emitNoTextPage,
  emitPageDone,
  type ProgressContext,
} from "./progressEvents";
import type {
  ModelEndpointHandle,
  PageContextPayload,
  PipelineOptions,
} from "./types";
import type { TranslationRuntimePort } from "./translationRuntimePort";
import type { WarningCollector } from "./warningCollector";
import type { FontMatchingPageInferencePort } from "./fontMatchingPagePixelInferenceTypes";
import type { AutomaticFontPageCoordinatorV2 } from "./automaticFontMatchingV2PageCoordinator";
import {
  measurePageProcessingStage,
  type PageProcessingTimingCollector,
} from "./pageProcessingTiming";
import { buildFontContinuityMetadata } from "./wholePageFontContinuity";

export async function preparePageTranslationAttempt({
  jobId,
  page,
  pageOptions,
  runtime,
  server,
  timing,
}: {
  jobId: string;
  page: MangaPage;
  pageOptions: TranslationOptions;
  runtime: TranslationRuntimePort;
  server: ModelEndpointHandle;
  timing: PageProcessingTimingCollector;
}): Promise<PreparedPageBuildResult> {
  return measurePageProcessingStage(
    timing,
    page.id,
    "translation",
    async () => {
      const result = await requestPageTranslation({
        pageOptions,
        runtime,
        server,
      });
      return preparePageResult({
        jobId,
        page,
        pageOptions,
        result,
        runtime,
      });
    },
  );
}

export async function completePreparedPageTranslationAttempt({
  context,
  onPageComplete,
  page,
  pageIndex,
  prepared,
  warningCollector,
  fontMatchingPageInference,
  fontMatchingChapterCoordinator,
  timing,
}: {
  context: ProgressContext;
  onPageComplete?: PipelineOptions["onPageComplete"];
  page: MangaPage;
  pageIndex: number;
  prepared: PreparedPageBuildResult;
  warningCollector: WarningCollector;
  fontMatchingPageInference?: FontMatchingPageInferencePort;
  fontMatchingChapterCoordinator?: AutomaticFontPageCoordinatorV2;
  timing: PageProcessingTimingCollector;
}): Promise<{
  page: MangaPage;
  pageContext?: PageContextPayload;
  approved: boolean;
}> {
  const pageResult = await measurePageProcessingStage(
    timing,
    page.id,
    "typography",
    () =>
      finalizePreparedPageResult({
        prepared,
        fontMatchingPageInference,
        fontMatchingChapterCoordinator,
      }),
  );
  const timedPage = timing.applyTranslationTiming(pageResult.page);
  const continuityObservations =
    fontMatchingChapterCoordinator?.snapshotPageContinuity?.(page.id) ?? [];
  const completedPage: MangaPage = {
    ...timedPage,
    fontContinuity: buildFontContinuityMetadata(continuityObservations),
  };

  warningCollector.add(...pageResult.warnings);
  const approved = (await onPageComplete?.(completedPage)) !== false;
  if (pageResult.kind === "no-text") {
    emitNoTextPage(context, page, pageIndex);
  } else {
    emitPageDone(context, page, pageIndex, pageResult.detail);
  }
  return {
    page: completedPage,
    pageContext: pageResult.pageContext,
    approved,
  };
}
