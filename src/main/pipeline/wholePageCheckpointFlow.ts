import type { MangaPage } from "../../shared/libraryTypes";
import { createPageRevision } from "../../shared/pageRevision";
import {
  DEFAULT_SOURCE_LANGUAGE,
  DEFAULT_TARGET_LANGUAGE,
} from "../../shared/translationLanguageDefaults";
import type { PipelineOptions } from "./types";
import type { OcrBboxResult } from "./types";
import type { PageProcessingTimingCollector } from "./pageProcessingTiming";
import { prepareAnalysisRun } from "./prepareAnalysisRun";
import {
  buildRequestPageOptions,
  type PreparedPageBuildResult,
} from "./pageResultBuilder";
import {
  buildPreparedTranslationCheckpoint,
  resolveCheckpointCompatibility,
  restorePreparedTranslationCheckpoint,
} from "./preparedTranslationCheckpoint";
import type { PreparedTranslationCheckpoint } from "./preparedTranslationCheckpointContract";
import type { AnalysisEndpointSession } from "./endpointSession";

type PreparedRun = Awaited<ReturnType<typeof prepareAnalysisRun>>;

export function requireTranslationEndpoint(
  endpoint: AnalysisEndpointSession | undefined,
): AnalysisEndpointSession {
  if (!endpoint) {
    throw new Error(
      "새 번역 대상이 있지만 모델 endpoint가 시작되지 않았습니다.",
    );
  }
  return endpoint;
}

export function resolveReusableTranslationCheckpoints(
  pages: readonly MangaPage[],
  candidates: PipelineOptions["translationCheckpoints"],
  baseOptions: PreparedRun["baseOptions"],
  blockMode: PipelineOptions["blockMode"],
  warn: (message: string, details?: Record<string, unknown>) => void,
): ReadonlyMap<string, PreparedTranslationCheckpoint> {
  const reusable = new Map<string, PreparedTranslationCheckpoint>();
  if (!candidates?.size) return reusable;
  for (const page of pages) {
    const checkpoint = candidates.get(page.id);
    if (!checkpoint) continue;
    const compatibility = resolveCheckpointCompatibility({
      checkpoint,
      page,
      sourceLanguage: baseOptions.sourceLanguage,
      targetLanguage: baseOptions.targetLanguage,
      blockMode,
    });
    if (compatibility.reusable) {
      reusable.set(page.id, checkpoint);
      continue;
    }
    warn("Translation checkpoint promoted to restart", {
      pageId: page.id,
      reason: compatibility.reason,
    });
  }
  return reusable;
}

export function restoreTranslationCheckpointForRun({
  blockMode,
  checkpoint,
  collectPageContext,
  cumulativeContextDetail,
  ocrHintsByPageId,
  page,
  pageIndex,
  progressPageIndex,
  regionContext,
  run,
  signal,
  timing,
  workContext,
}: {
  blockMode?: PipelineOptions["blockMode"];
  checkpoint: PreparedTranslationCheckpoint;
  collectPageContext: boolean;
  cumulativeContextDetail: NonNullable<
    PipelineOptions["cumulativeContextDetail"]
  >;
  ocrHintsByPageId: Map<string, OcrBboxResult>;
  page: MangaPage;
  pageIndex: number;
  progressPageIndex: number;
  regionContext?: PipelineOptions["regionContext"];
  run: PreparedRun;
  signal: AbortSignal;
  timing: PageProcessingTimingCollector;
  workContext?: PipelineOptions["workContext"];
}): PreparedPageBuildResult {
  timing.setStage(page.id, "translation", checkpoint.translationDurationMs);
  const pageOptions = buildRequestPageOptions({
    attempt: 1,
    baseOptions: run.baseOptions,
    blockMode,
    context: run.progressContext,
    maxAttempts: 1,
    ocrHintsByPageId,
    page,
    pageIndex,
    progressPageIndex,
    signal,
    skipOcrPrepass: true,
    workContext,
    regionContext,
    collectPageContext,
    cumulativeContextDetail,
  });
  return restorePreparedTranslationCheckpoint(checkpoint, page, pageOptions);
}

export async function approvePreparedTranslationCheckpoint({
  blockMode,
  onPagePrepared,
  page,
  prepared,
  run,
  timing,
}: {
  blockMode?: PipelineOptions["blockMode"];
  onPagePrepared?: PipelineOptions["onPagePrepared"];
  page: MangaPage;
  prepared: PreparedPageBuildResult;
  run: PreparedRun;
  timing: PageProcessingTimingCollector;
}): Promise<void> {
  if (!onPagePrepared) return;
  const checkpoint = buildPreparedTranslationCheckpoint({
    prepared,
    pageId: page.id,
    inputRevision: createPageRevision(page),
    sourceLanguage: run.baseOptions.sourceLanguage ?? DEFAULT_SOURCE_LANGUAGE,
    targetLanguage: run.baseOptions.targetLanguage ?? DEFAULT_TARGET_LANGUAGE,
    blockMode: blockMode ?? "auto",
    translationDurationMs: timing.getStages(page.id).translation ?? 0,
  });
  if ((await onPagePrepared(checkpoint)) === false) {
    throw new Error(
      "페이지가 변경되어 번역 체크포인트를 저장하지 못했습니다. 작업을 중단합니다.",
    );
  }
}
