import type { TranslationOptions } from "../appSettings";
import type { MangaPage } from "../../shared/types";
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
      progressText: "AI 직접 분석 준비 중",
      phase: "booting",
      progressCurrent: 0,
      progressTotal: context.progressTotal,
      pageTotal: context.pageTotal,
      detail:
        "선택 영역은 Paddle OCR 선분석 없이 모델이 직접 텍스트 그룹을 찾습니다.",
    });
    return;
  }

  context.emit({
    id: context.jobId,
    kind: "gemma-analysis",
    status: "starting",
    progressText: "Paddle OCR 선분석 준비 중",
    phase: "ocr_preparing",
    progressCurrent: 0,
    progressTotal: context.progressTotal,
    pageTotal: context.pageTotal,
    detail: "대상 페이지의 OCR 후보 좌표를 먼저 준비합니다.",
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
    baseOptions: TranslationOptions;
    codexSelected: boolean;
    localModelSelected: boolean;
    modelCached: boolean;
    formatGemmaVramMode: (mode: TranslationOptions["gemmaVramMode"]) => string;
  },
): void {
  const { baseOptions, codexSelected, localModelSelected, modelCached } =
    options;
  context.emit({
    id: context.jobId,
    kind: "gemma-analysis",
    status: "starting",
    progressText: localModelSelected
      ? "로컬 모델/서버 준비 중"
      : codexSelected
        ? "OpenAI Codex 엔드포인트 준비 중"
        : modelCached
          ? "Gemma 4 서버 시작 중"
          : "모델 다운로드/서버 준비 중",
    phase:
      localModelSelected || modelCached || codexSelected
        ? "booting"
        : "model_downloading",
    progressCurrent: 0,
    progressTotal: context.progressTotal,
    pageTotal: context.pageTotal,
    detail: localModelSelected
      ? "선택한 로컬 모델을 불러오는 중입니다. 큰 모델은 시작까지 시간이 걸릴 수 있습니다."
      : codexSelected
        ? `${baseOptions.codexModel}, thinking ${baseOptions.codexReasoningEffort}`
        : modelCached
          ? `${options.formatGemmaVramMode(baseOptions.gemmaVramMode)}, ${baseOptions.modelFile}`
          : "로컬 모델 자산이 없거나 부족해 다운로드/갱신이 필요할 수 있습니다.",
  });
}

export function emitEndpointReady(
  context: ProgressContext,
  options: {
    server: ModelEndpointHandle;
    baseOptions: TranslationOptions;
    codexSelected: boolean;
  },
): void {
  context.emit({
    id: context.jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: "모델 준비 완료",
    phase: "ready",
    progressCurrent: 0,
    progressTotal: context.progressTotal,
    pageTotal: context.pageTotal,
    detail: options.codexSelected
      ? `openai-oauth ready at ${options.server.baseUrl}`
      : `server ready on port ${options.baseOptions.port}`,
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
    progressText: `${page.name} 분석 중`,
    phase: "page_running",
    progressCurrent: pageIndex + 1,
    progressTotal: context.progressTotal,
    pageIndex: pageIndex + 1,
    pageTotal: context.pageTotal,
    attempt,
    attemptTotal: maxAttempts,
    detail: `${pageIndex + 1}/${context.pageTotal}, 시도 ${attempt}/${maxAttempts}`,
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
    progressText: `${page.name} 재시도`,
    phase: "page_retry",
    progressCurrent: pageIndex + 1,
    progressTotal: context.progressTotal,
    pageIndex: pageIndex + 1,
    pageTotal: context.pageTotal,
    attempt: attempt + 1,
    attemptTotal: maxAttempts,
    detail: `${attempt}/${maxAttempts} 실패, 다시 시도합니다`,
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
    progressText: `${page.name} 완료`,
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
    progressText: `${page.name} 텍스트 없음`,
    phase: "page_done",
    progressCurrent: pageIndex + 1,
    progressTotal: context.progressTotal,
    pageIndex: pageIndex + 1,
    pageTotal: context.pageTotal,
    detail:
      "Paddle OCR에서 일본어 텍스트 근거를 찾지 못해 모델 호출을 생략했습니다.",
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
    progressText: `${page.name} 건너뜀`,
    phase: "page_skipped",
    progressCurrent: pageIndex + 1,
    progressTotal: context.progressTotal,
    pageIndex: pageIndex + 1,
    pageTotal: context.pageTotal,
    detail: `${maxAttempts}회 재시도 후 실패`,
  });
}

export function emitFinalizing(context: ProgressContext, detail: string): void {
  context.emit({
    id: context.jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: "결과 정리 중",
    phase: "finalizing",
    progressCurrent: context.progressTotal,
    progressTotal: context.progressTotal,
    pageTotal: context.pageTotal,
    detail,
  });
}
