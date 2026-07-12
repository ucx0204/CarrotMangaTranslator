import type { TranslationOptions } from "../appSettings";
import type { MangaPage } from "../../shared/libraryTypes";
import { tMain } from "./localization";
import type { ModelEndpointHandle, PipelineOptions } from "./types";

type Emit = PipelineOptions["emit"];

export type ProgressContext = {
  jobId: string;
  emit: Emit;
  progressTotal: number;
  pageTotal: number;
};

export function emitOcrPreparation(
  context: ProgressContext,
  skipOcrPrepass: boolean,
): void {
  if (skipOcrPrepass) {
    context.emit({
      id: context.jobId,
      kind: "gemma-analysis",
      status: "starting",
      progressText: tMain("translation.progress.directPreparing"),
      phase: "booting",
      progressCurrent: 0,
      progressTotal: context.progressTotal,
      pageTotal: context.pageTotal,
      detail: tMain("translation.progress.directPreparingDetail"),
    });
    return;
  }

  context.emit({
    id: context.jobId,
    kind: "gemma-analysis",
    status: "starting",
    progressText: tMain("translation.progress.ocrPreparing"),
    phase: "ocr_preparing",
    progressCurrent: 0,
    progressTotal: context.progressTotal,
    pageTotal: context.pageTotal,
    detail: tMain("translation.progress.ocrPreparingDetail"),
  });
}

export function attachBaseProgress(
  context: ProgressContext,
  baseOptions: TranslationOptions,
): void {
  baseOptions.onProgress = (progress) => {
    context.emit({
      id: context.jobId,
      kind: "gemma-analysis",
      status: "starting",
      progressText: progress.progressText,
      phase: progress.phase,
      progressCurrent: 0,
      progressTotal: context.progressTotal,
      pageTotal: context.pageTotal,
      detail: progress.detail,
      progressMode: progress.progressMode,
      progressPercent: progress.progressPercent,
      progressBytes: progress.progressBytes,
      progressTotalBytes: progress.progressTotalBytes,
      progressBytesPerSecond: progress.progressBytesPerSecond,
      installLogLine: progress.installLogLine,
    });
  };
}

export function attachPageProgress(
  context: ProgressContext,
  pageOptions: TranslationOptions,
  pageIndex: number,
  attempt: number,
  maxAttempts: number,
): void {
  pageOptions.onProgress = (progress) => {
    context.emit({
      id: context.jobId,
      kind: "gemma-analysis",
      status: "running",
      progressText: progress.progressText,
      phase: progress.phase,
      progressCurrent: pageIndex + 1,
      progressTotal: context.progressTotal,
      pageIndex: pageIndex + 1,
      pageTotal: context.pageTotal,
      attempt,
      attemptTotal: maxAttempts,
      detail: progress.detail,
      progressMode: progress.progressMode,
      progressPercent: progress.progressPercent,
      progressBytes: progress.progressBytes,
      progressTotalBytes: progress.progressTotalBytes,
      progressBytesPerSecond: progress.progressBytesPerSecond,
      installLogLine: progress.installLogLine,
    });
  };
}

export function emitEndpointStarting(
  context: ProgressContext,
  options: {
    apiSelected: boolean;
    baseOptions: TranslationOptions;
    codexSelected: boolean;
    localModelSelected: boolean;
    modelCached: boolean;
    formatGemmaVramMode: (mode: TranslationOptions["gemmaVramMode"]) => string;
  },
): void {
  context.emit({
    id: context.jobId,
    kind: "gemma-analysis",
    status: "starting",
    progressText: resolveEndpointStartingText(options),
    phase: resolveEndpointStartingPhase(options),
    progressCurrent: 0,
    progressTotal: context.progressTotal,
    pageTotal: context.pageTotal,
    detail: resolveEndpointStartingDetail(options),
  });
}

type EndpointStartingOptions = Parameters<typeof emitEndpointStarting>[1];

function resolveEndpointStartingText(options: EndpointStartingOptions): string {
  if (options.localModelSelected) {
    return tMain("translation.progress.localModelPreparing");
  }
  if (options.codexSelected) {
    return tMain("translation.progress.codexPreparing");
  }
  if (options.apiSelected) {
    return tMain("translation.progress.apiPreparing");
  }
  return options.modelCached
    ? tMain("translation.progress.gemmaStarting")
    : tMain("translation.progress.modelDownloading");
}

function resolveEndpointStartingPhase(
  options: EndpointStartingOptions,
): "booting" | "model_downloading" {
  if (
    options.localModelSelected ||
    options.modelCached ||
    options.codexSelected ||
    options.apiSelected
  ) {
    return "booting";
  }
  return "model_downloading";
}

function resolveEndpointStartingDetail(
  options: EndpointStartingOptions,
): string {
  const { baseOptions } = options;
  if (options.localModelSelected) {
    return tMain("translation.progress.localModelPreparingDetail");
  }
  if (options.codexSelected) {
    return `${baseOptions.codexModel}, thinking ${baseOptions.codexReasoningEffort}`;
  }
  if (options.apiSelected) {
    return `${baseOptions.apiModel} @ ${baseOptions.apiBaseUrl}`;
  }
  if (options.modelCached) {
    return `${options.formatGemmaVramMode(baseOptions.gemmaVramMode)}, ${baseOptions.modelFile}`;
  }
  return tMain("translation.progress.modelDownloadingDetail");
}

export function emitEndpointReady(
  context: ProgressContext,
  options: {
    server: ModelEndpointHandle;
    apiSelected: boolean;
    baseOptions: TranslationOptions;
    codexSelected: boolean;
  },
): void {
  context.emit({
    id: context.jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: tMain("translation.progress.modelReady"),
    phase: "ready",
    progressCurrent: 0,
    progressTotal: context.progressTotal,
    pageTotal: context.pageTotal,
    detail: options.codexSelected
      ? tMain("translation.progress.oauthReadyDetail", {
          endpoint: options.server.baseUrl,
        })
      : options.apiSelected
        ? tMain("translation.progress.apiReadyDetail", {
            endpoint: options.server.baseUrl,
          })
        : tMain("translation.progress.serverReadyDetail", {
            port: options.baseOptions.port,
          }),
  });
}

export function emitPageRunning(
  context: ProgressContext,
  page: MangaPage,
  pageIndex: number,
  attempt: number,
  maxAttempts: number,
): void {
  context.emit({
    id: context.jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: tMain("translation.progress.pageRunning", {
      page: page.name,
    }),
    phase: "page_running",
    progressCurrent: pageIndex + 1,
    progressTotal: context.progressTotal,
    pageIndex: pageIndex + 1,
    pageTotal: context.pageTotal,
    attempt,
    attemptTotal: maxAttempts,
    detail: tMain("translation.progress.pageAttemptDetail", {
      current: pageIndex + 1,
      total: context.pageTotal,
      attempt,
      maxAttempts,
    }),
  });
}

export function emitPageRetry(
  context: ProgressContext,
  page: MangaPage,
  pageIndex: number,
  attempt: number,
  maxAttempts: number,
): void {
  context.emit({
    id: context.jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: tMain("translation.progress.pageRetry", { page: page.name }),
    phase: "page_retry",
    progressCurrent: pageIndex + 1,
    progressTotal: context.progressTotal,
    pageIndex: pageIndex + 1,
    pageTotal: context.pageTotal,
    attempt: attempt + 1,
    attemptTotal: maxAttempts,
    detail: tMain("translation.progress.pageRetryDetail", {
      attempt,
      maxAttempts,
    }),
  });
}

export function emitPageDone(
  context: ProgressContext,
  page: MangaPage,
  pageIndex: number,
  detail: string,
): void {
  context.emit({
    id: context.jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: tMain("translation.progress.pageDone", { page: page.name }),
    phase: "page_done",
    progressCurrent: pageIndex + 1,
    progressTotal: context.progressTotal,
    pageIndex: pageIndex + 1,
    pageTotal: context.pageTotal,
    detail,
  });
}

export function emitNoTextPage(
  context: ProgressContext,
  page: MangaPage,
  pageIndex: number,
): void {
  context.emit({
    id: context.jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: tMain("translation.progress.pageNoText", {
      page: page.name,
    }),
    phase: "page_done",
    progressCurrent: pageIndex + 1,
    progressTotal: context.progressTotal,
    pageIndex: pageIndex + 1,
    pageTotal: context.pageTotal,
    detail: tMain("translation.progress.pageNoTextDetail"),
  });
}

export function emitPageSkipped(
  context: ProgressContext,
  page: MangaPage,
  pageIndex: number,
  maxAttempts: number,
): void {
  context.emit({
    id: context.jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: tMain("translation.progress.pageSkipped", {
      page: page.name,
    }),
    phase: "page_skipped",
    progressCurrent: pageIndex + 1,
    progressTotal: context.progressTotal,
    pageIndex: pageIndex + 1,
    pageTotal: context.pageTotal,
    detail: tMain("translation.progress.pageSkippedDetail", { maxAttempts }),
  });
}

export function emitFinalizing(context: ProgressContext, detail: string): void {
  context.emit({
    id: context.jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: tMain("translation.progress.finalizing"),
    phase: "finalizing",
    progressCurrent: context.progressTotal,
    progressTotal: context.progressTotal,
    pageTotal: context.pageTotal,
    detail,
  });
}
