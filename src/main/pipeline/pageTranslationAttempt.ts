import type { TranslationOptions } from "../appSettings";
import type { MangaPage } from "../../shared/libraryTypes";
import { buildPageResult, requestPageTranslation } from "./pageResultBuilder";
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

export async function translatePageAttempt({
  context,
  jobId,
  onPageComplete,
  page,
  pageIndex,
  pageOptions,
  runtime,
  server,
  warningCollector,
  fontMatchingPageInference,
  fontMatchingChapterCoordinator,
}: {
  context: ProgressContext;
  jobId: string;
  onPageComplete?: PipelineOptions["onPageComplete"];
  page: MangaPage;
  pageIndex: number;
  pageOptions: TranslationOptions;
  runtime: TranslationRuntimePort;
  server: ModelEndpointHandle;
  warningCollector: WarningCollector;
  fontMatchingPageInference?: FontMatchingPageInferencePort;
  fontMatchingChapterCoordinator?: AutomaticFontPageCoordinatorV2;
}): Promise<{
  page: MangaPage;
  pageContext?: PageContextPayload;
  approved: boolean;
}> {
  const result = await requestPageTranslation({ pageOptions, runtime, server });
  const pageResult = await buildPageResult({
    jobId,
    page,
    pageOptions,
    result,
    runtime,
    fontMatchingPageInference,
    fontMatchingChapterCoordinator,
  });

  warningCollector.add(...pageResult.warnings);
  const approved = (await onPageComplete?.(pageResult.page)) !== false;
  if (pageResult.kind === "no-text") {
    emitNoTextPage(context, page, pageIndex);
  } else {
    emitPageDone(context, page, pageIndex, pageResult.detail);
  }
  return {
    page: pageResult.page,
    pageContext: pageResult.pageContext,
    approved,
  };
}
