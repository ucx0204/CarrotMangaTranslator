import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranslationOptions } from "./appSettings";
import { logError, logInfo, logWarn } from "./logger";
import type { MangaPage } from "../shared/types";
import { getAppPaths } from "./appPaths";
import { getAppSettings } from "./settingsStore";
import { classifyFailure, isAbortErrorLike, isNonRetriableRuntimeError, summarizePage, throwIfAborted } from "./pipeline/failure";
import { buildNoTextCompletedPage, isOcrResultNoTextDetected, isRequestNoTextDetected } from "./pipeline/noText";
import { prepareOcrHintsForPages } from "./pipeline/ocrHints";
import {
  applyOcrCandidateGeometryLocks,
  buildPageWarnings,
  filterRejectedOrUncertainSoundItems,
  getBboxNormalizationOptions,
  getOcrBboxHints,
  normalizeOverlayItemBboxes,
  overlayItemToBlock
} from "./pipeline/overlayItems";
import { buildBaseOptions, buildPageOptions, formatGemmaVramMode, readNumberEnv, summarizePreview, summarizeTranslationOptions } from "./pipeline/options";
import { loadTranslationRuntimePort } from "./pipeline/translationRuntimePort";
import type {
  OcrBboxResult,
  PipelineOptions,
} from "./pipeline/types";

export async function runWholePagePipeline({
  jobId,
  emit,
  onCleanupReady,
  onPageComplete,
  onPageFailed,
  pages,
  runPaths,
  signal,
  skipOcrPrepass = false
}: PipelineOptions): Promise<{ pages: MangaPage[]; warnings: string[] }> {
  if (pages.length === 0) {
    return { pages: [], warnings: [] };
  }

  throwIfAborted(signal);

  const paths = getAppPaths();
  const appSettings = await getAppSettings(paths);
  const runtime = loadTranslationRuntimePort();
  const baseOptions = buildBaseOptions(jobId, runPaths.runDir, appSettings, paths);
  const progressTotal = pages.length;
  const codexSelected = baseOptions.modelProvider === "openai-codex";
  const modelCached = codexSelected || runtime.isModelCached(baseOptions);
  const localModelSelected = !codexSelected && baseOptions.modelSource === "local";
  const warnings: string[] = [];

  logInfo("Analysis pipeline initialized", {
    jobId,
    pageCount: pages.length,
    runPaths,
    modelCached,
    settings: summarizeTranslationOptions(baseOptions)
  });

  if (skipOcrPrepass) {
    emit({
      id: jobId,
      kind: "gemma-analysis",
      status: "starting",
      progressText: "AI 직접 분석 준비 중",
      phase: "booting",
      progressCurrent: 0,
      progressTotal,
      pageTotal: pages.length,
      detail: "선택 영역은 Paddle OCR 선분석 없이 모델이 직접 텍스트 그룹을 찾습니다."
    });
  } else {
    emit({
      id: jobId,
      kind: "gemma-analysis",
      status: "starting",
      progressText: "Paddle OCR 선분석 준비 중",
      phase: "ocr_preparing",
      progressCurrent: 0,
      progressTotal,
      pageTotal: pages.length,
      detail: "대상 페이지의 OCR 후보 좌표를 먼저 준비합니다."
    });
  }

  baseOptions.onProgress = (progress) => {
    emit({
      id: jobId,
      kind: "gemma-analysis",
      status: "starting",
      progressText: progress.progressText,
      phase: progress.phase,
      progressCurrent: 0,
      progressTotal,
      pageTotal: pages.length,
      detail: progress.detail,
      progressMode: progress.progressMode,
      progressPercent: progress.progressPercent,
      progressBytes: progress.progressBytes,
      progressTotalBytes: progress.progressTotalBytes,
      progressBytesPerSecond: progress.progressBytesPerSecond,
      installLogLine: progress.installLogLine
    });
  };
  baseOptions.abortSignal = signal;

  const ocrHintsByPageId = skipOcrPrepass
    ? new Map<string, OcrBboxResult>()
    : await prepareOcrHintsForPages({
        runtime,
        baseOptions,
        pages,
        runPaths,
        emit,
        jobId,
        signal
      });

  if (skipOcrPrepass) {
    logInfo("OCR prepass skipped for analysis pipeline", {
      jobId,
      pageCount: pages.length
    });
  }

  throwIfAborted(signal);

  const pageIndexById = new Map(pages.map((page, index) => [page.id, index]));
  const completedPagesById = new Map<string, MangaPage>();
  const pagesToTranslate: MangaPage[] = [];

  for (const page of pages) {
    const ocrResult = ocrHintsByPageId.get(page.id);
    if (!isOcrResultNoTextDetected(ocrResult)) {
      pagesToTranslate.push(page);
      continue;
    }

    const pageIndex = (pageIndexById.get(page.id) ?? 0) + 1;
    const noTextPage = buildNoTextCompletedPage(page);
    completedPagesById.set(page.id, noTextPage);
    await onPageComplete?.(noTextPage);
    emit({
      id: jobId,
      kind: "gemma-analysis",
      status: "running",
      progressText: `${page.name} 텍스트 없음`,
      phase: "page_done",
      progressCurrent: pageIndex,
      progressTotal,
      pageIndex,
      pageTotal: pages.length,
      detail: "Paddle OCR에서 일본어 텍스트 근거를 찾지 못해 모델 호출을 생략했습니다."
    });
  }

  if (pagesToTranslate.length === 0) {
    emit({
      id: jobId,
      kind: "gemma-analysis",
      status: "running",
      progressText: "결과 정리 중",
      phase: "finalizing",
      progressCurrent: progressTotal,
      progressTotal,
      pageTotal: pages.length,
      detail: `${pages.length} pages ready, 모델 호출 없음`
    });

    return {
      pages: pages.map((page) => completedPagesById.get(page.id) ?? page),
      warnings
    };
  }

  emit({
    id: jobId,
    kind: "gemma-analysis",
    status: "starting",
    progressText: localModelSelected
      ? "로컬 모델/서버 준비 중"
      : codexSelected
        ? "OpenAI Codex 엔드포인트 준비 중"
        : modelCached
          ? "Gemma 4 서버 시작 중"
          : "모델 다운로드/서버 준비 중",
    phase: localModelSelected || modelCached || codexSelected ? "booting" : "model_downloading",
    progressCurrent: 0,
    progressTotal,
    pageTotal: pages.length,
    detail: localModelSelected
      ? "선택한 로컬 모델을 불러오는 중입니다. 큰 모델은 시작까지 시간이 걸릴 수 있습니다."
      : codexSelected
        ? `${baseOptions.codexModel}, thinking ${baseOptions.codexReasoningEffort}`
        : modelCached
          ? `${formatGemmaVramMode(baseOptions.gemmaVramMode)}, ${baseOptions.modelFile}`
          : "로컬 모델 자산이 없거나 부족해 다운로드/갱신이 필요할 수 있습니다."
  });

  const endpointSession = await runtime.startEndpointSession(baseOptions);
  const server = endpointSession.handle;
  onCleanupReady?.(() => endpointSession.dispose());
  const maxAttempts = Math.max(1, readNumberEnv("MANGA_TRANSLATOR_PAGE_RETRIES", 5));

  emit({
    id: jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: "모델 준비 완료",
    phase: "ready",
    progressCurrent: 0,
    progressTotal,
    pageTotal: pages.length,
    detail: codexSelected ? `openai-oauth ready at ${server.baseUrl}` : `server ready on port ${baseOptions.port}`
  });

  const buildRequestPageOptions = (page: MangaPage, pageIndex: number, attempt: number): TranslationOptions => {
    const pageOptions = buildPageOptions(baseOptions, page, pageIndex, attempt);
    if (skipOcrPrepass) {
      pageOptions.skipOcrBboxHints = true;
      pageOptions.regionCropMode = true;
      pageOptions.ocrBboxProvider = "none";
      delete pageOptions.ocrBboxHints;
      delete pageOptions.ocrBboxResult;
    } else {
      pageOptions.ocrBboxResult = ocrHintsByPageId.get(page.id) ?? {
        hints: [],
        diagnostics: [{ provider: "prepass", reason: "missing-result" }],
        noTextDetected: false,
        textEvidenceCount: 0
      };
      pageOptions.ocrBboxHints = pageOptions.ocrBboxResult.hints ?? [];
    }
    pageOptions.abortSignal = signal;
    pageOptions.onProgress = (progress) => {
      emit({
        id: jobId,
        kind: "gemma-analysis",
        status: "running",
        progressText: progress.progressText,
        phase: progress.phase,
        progressCurrent: pageIndex + 1,
        progressTotal,
        pageIndex: pageIndex + 1,
        pageTotal: pages.length,
        attempt,
        attemptTotal: maxAttempts,
        detail: progress.detail,
        progressMode: progress.progressMode,
        progressPercent: progress.progressPercent,
        progressBytes: progress.progressBytes,
        progressTotalBytes: progress.progressTotalBytes,
        progressBytesPerSecond: progress.progressBytesPerSecond,
        installLogLine: progress.installLogLine
      });
    };
    return pageOptions;
  };

  try {
    for (let translateIndex = 0; translateIndex < pagesToTranslate.length; translateIndex += 1) {
      const page = pagesToTranslate[translateIndex];
      const index = pageIndexById.get(page.id) ?? 0;
      throwIfAborted(signal);
      let successPage: MangaPage | null = null;
      let lastErrorMessage = "";
      let lastError: unknown;
      let lastPageOptions: TranslationOptions | null = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        throwIfAborted(signal);

        const pageOptions = buildRequestPageOptions(page, index, attempt);
        lastPageOptions = pageOptions;
        emit({
          id: jobId,
          kind: "gemma-analysis",
          status: "running",
          progressText: `${page.name} 분석 중`,
          phase: "page_running",
          progressCurrent: index + 1,
          progressTotal,
          pageIndex: index + 1,
          pageTotal: pages.length,
          attempt,
          attemptTotal: maxAttempts,
          detail: `${index + 1}/${pages.length}, 시도 ${attempt}/${maxAttempts}`
        });

        try {
          const result = await runtime.requestTranslation(server, pageOptions);
          await runtime.saveArtifacts(pageOptions, result);

          let parsed: unknown;
          try {
            parsed = runtime.parseJsonLenient(result.outputText);
          } catch (error) {
            const preview = summarizePreview(result.outputText);
            const parseError = new Error(
              `${page.name}: 모델 응답을 구조화 형식으로 해석하지 못했습니다. preview=${preview} cause=${error instanceof Error ? error.message : String(error)}`
            ) as Error & { cause?: unknown };
            parseError.cause = error;
            Object.assign(parseError, {
              outputPreview: preview,
              outputDir: pageOptions.outputDir,
              responseFormat: "structured-overlay"
            });
            throw parseError;
          }

          const items = runtime.normalizeItems(parsed);
          if (items.length === 0 && isRequestNoTextDetected(result.requestBody)) {
            successPage = buildNoTextCompletedPage(page);
            await onPageComplete?.(successPage);
            emit({
              id: jobId,
              kind: "gemma-analysis",
              status: "running",
              progressText: `${page.name} 텍스트 없음`,
              phase: "page_done",
              progressCurrent: index + 1,
              progressTotal,
              pageIndex: index + 1,
              pageTotal: pages.length,
              detail: "Paddle OCR에서 일본어 텍스트 근거를 찾지 못해 모델 호출을 생략했습니다."
            });
            break;
          }
          if (items.length === 0) {
            const bboxError = new Error(`${page.name}: bbox 결과를 만들지 못했습니다.`);
            Object.assign(bboxError, {
              outputDir: pageOptions.outputDir,
              outputPreview: summarizePreview(result.outputText)
            });
            throw bboxError;
          }

          const overlayItemsPath = join(pageOptions.outputDir, "overlay-items.json");
          await mkdir(pageOptions.outputDir, { recursive: true });
          await writeFile(overlayItemsPath, `${JSON.stringify({ items }, null, 2)}\n`, "utf8");

          let normalizedItems = applyOcrCandidateGeometryLocks(
            normalizeOverlayItemBboxes(items, page, getBboxNormalizationOptions(result.requestBody)),
            page,
            getOcrBboxHints(result.requestBody)
          );
          const soundFiltered = filterRejectedOrUncertainSoundItems(normalizedItems);
          normalizedItems = soundFiltered.items;
          successPage = {
            ...page,
            blocks: normalizedItems.map((item, itemIndex) => overlayItemToBlock(item, page, itemIndex)),
            analysisStatus: "completed",
            lastError: undefined,
            updatedAt: new Date().toISOString()
          };
          warnings.push(...buildPageWarnings(page.name, normalizedItems));
          await onPageComplete?.(successPage);
          emit({
            id: jobId,
            kind: "gemma-analysis",
            status: "running",
            progressText: `${page.name} 완료`,
            phase: "page_done",
            progressCurrent: index + 1,
            progressTotal,
            pageIndex: index + 1,
            pageTotal: pages.length,
            detail: soundFiltered.droppedCount > 0
              ? `${normalizedItems.length}개 블록, 불확실한 효과음 ${soundFiltered.droppedCount}개 제외`
              : `${normalizedItems.length}개 블록`
          });
          break;
        } catch (error) {
          if (isAbortErrorLike(error)) {
            throw error;
          }
          if (isNonRetriableRuntimeError(error)) {
            throw error;
          }

          lastError = error;
          lastErrorMessage = error instanceof Error ? error.message : String(error);
          warnings.push(`${page.name}: 시도 ${attempt}/${maxAttempts} 실패 - ${lastErrorMessage}`);
          logWarn("Analysis attempt failed", {
            failureCategory: classifyFailure(error),
            jobId,
            page: summarizePage(page),
            pageIndex: index + 1,
            pageTotal: pages.length,
            attempt,
            attemptTotal: maxAttempts,
            willRetry: attempt < maxAttempts,
            runPaths,
            pageOptions: summarizeTranslationOptions(pageOptions),
            error
          });

          if (attempt < maxAttempts) {
            emit({
              id: jobId,
              kind: "gemma-analysis",
              status: "running",
              progressText: `${page.name} 재시도`,
              phase: "page_retry",
              progressCurrent: index + 1,
              progressTotal,
              pageIndex: index + 1,
              pageTotal: pages.length,
              attempt: attempt + 1,
              attemptTotal: maxAttempts,
              detail: `${attempt}/${maxAttempts} 실패, 다시 시도합니다`
            });
            continue;
          }
        }
      }

      if (successPage) {
        completedPagesById.set(page.id, successPage);
        continue;
      }

      warnings.push(`${page.name}: ${maxAttempts}회 재시도 후 실패하여 이 페이지는 건너뜁니다. 마지막 오류: ${lastErrorMessage}`);
      logError("Analysis page skipped after retries", {
        failureCategory: classifyFailure(lastError),
        jobId,
        page: summarizePage(page),
        pageIndex: index + 1,
        pageTotal: pages.length,
        attemptTotal: maxAttempts,
        runPaths,
        lastPageOptions: lastPageOptions ? summarizeTranslationOptions(lastPageOptions) : null,
        lastErrorMessage,
        error: lastError
      });
      const failedPage: MangaPage = {
        ...page,
        blocks: [],
        analysisStatus: "failed",
        lastError: lastErrorMessage,
        updatedAt: new Date().toISOString()
      };
      completedPagesById.set(page.id, failedPage);
      await onPageFailed?.(failedPage, lastErrorMessage);
      emit({
        id: jobId,
        kind: "gemma-analysis",
        status: "running",
        progressText: `${page.name} 건너뜀`,
        phase: "page_skipped",
        progressCurrent: index + 1,
        progressTotal,
        pageIndex: index + 1,
        pageTotal: pages.length,
        detail: `${maxAttempts}회 재시도 후 실패`
      });
    }

    emit({
      id: jobId,
      kind: "gemma-analysis",
      status: "running",
      progressText: "결과 정리 중",
      phase: "finalizing",
      progressCurrent: progressTotal,
      progressTotal,
      pageTotal: pages.length,
      detail: `${pages.length} pages ready`
    });

    return {
      pages: pages.map((page) => completedPagesById.get(page.id) ?? page),
      warnings
    };
  } finally {
    await endpointSession.dispose();
  }
}
