import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TranslationOptions } from "../appSettings";
import type { ChapterRunPaths } from "../library";
import type { JobEvent, MangaPage } from "../../shared/types";
import { throwIfAborted } from "./failure";
import { isOcrResultNoTextDetected } from "./noText";
import type { OcrBboxResult, RuntimeModules } from "./types";

const OCR_HINT_CACHE_SCHEMA_VERSION = 2;

export async function prepareOcrHintsForPages({
  runtime,
  baseOptions,
  pages,
  runPaths,
  emit,
  jobId,
  signal
}: {
  runtime: RuntimeModules;
  baseOptions: TranslationOptions;
  pages: MangaPage[];
  runPaths: ChapterRunPaths;
  emit: (event: JobEvent) => void;
  jobId: string;
  signal: AbortSignal;
}): Promise<Map<string, OcrBboxResult>> {
  const results = new Map<string, OcrBboxResult>();
  const total = pages.length;
  const pendingPages: Array<{ page: MangaPage; index: number; options: TranslationOptions; cachePath: string }> = [];

  for (const [index, page] of pages.entries()) {
    throwIfAborted(signal);
    const cachePath = getOcrHintsCachePath(runPaths, page);
    const cached = await readCachedOcrHints(cachePath, page);
    if (cached) {
      results.set(page.id, cached);
      emit({
        id: jobId,
        kind: "gemma-analysis",
        status: "running",
        progressText: `${page.name} OCR 재사용`,
        phase: "ocr_running",
        progressCurrent: index + 1,
        progressTotal: total,
        pageIndex: index + 1,
        pageTotal: total,
        detail: formatOcrHintDetail(cached)
      });
      continue;
    }

    const ocrOptions = buildOcrPageOptions(baseOptions, page, runPaths, index, total);
    ocrOptions.abortSignal = signal;
    ocrOptions.onProgress = (progress) => {
      const hasExplicitPageProgress = Number.isFinite(progress.pageIndex) && Number.isFinite(progress.pageTotal);
      const suppressDefaultPageProgress = progress.pageIndex === null || progress.pageTotal === null;
      const shouldDefaultToPage = Boolean(ocrOptions.ocrProgressDefaultToPage) && !suppressDefaultPageProgress;
      emit({
        id: jobId,
        kind: "gemma-analysis",
        status: "running",
        progressText: progress.progressText,
        phase: progress.phase,
        progressCurrent: progress.progressCurrent ?? (shouldDefaultToPage ? index + 1 : results.size),
        progressTotal: progress.progressTotal ?? total,
        pageIndex: hasExplicitPageProgress ? Number(progress.pageIndex) : shouldDefaultToPage ? index + 1 : undefined,
        pageTotal: hasExplicitPageProgress ? Number(progress.pageTotal) : shouldDefaultToPage ? total : undefined,
        detail: progress.detail,
        progressMode: progress.progressMode,
        progressPercent: progress.progressPercent,
        progressBytes: progress.progressBytes,
        progressTotalBytes: progress.progressTotalBytes,
        progressBytesPerSecond: progress.progressBytesPerSecond,
        installLogLine: progress.installLogLine
      });
    };
    pendingPages.push({ page, index, options: ocrOptions, cachePath });
  }

  if (pendingPages.length > 0) {
    pendingPages.forEach((entry) => {
      entry.options.ocrBatchCompletedBefore = results.size;
      entry.options.ocrBatchTotal = total;
    });
    emit({
      id: jobId,
      kind: "gemma-analysis",
      status: "running",
      progressText: "Paddle OCR 배치 선분석 중",
      phase: "ocr_running",
      progressCurrent: 0,
      progressTotal: pendingPages.length,
      pageTotal: total,
      detail: `${pendingPages.length}페이지를 한 번에 처리합니다. OCR 프로세스는 이 구간 끝에서 종료됩니다.`
    });

    const batchResults = runtime.simplePage.collectOcrBboxHintsBatch
      ? await runtime.simplePage.collectOcrBboxHintsBatch(pendingPages.map((entry) => entry.options))
      : await collectOcrHintsSequentially(runtime, pendingPages);

    for (const [batchIndex, result] of batchResults.entries()) {
      throwIfAborted(signal);
      const entry = pendingPages[batchIndex];
      if (!entry) {
        continue;
      }
      await writeCachedOcrHints(entry.cachePath, entry.page, result);
      results.set(entry.page.id, result);
      emit({
        id: jobId,
        kind: "gemma-analysis",
        status: "running",
        progressText: `${entry.page.name} OCR 완료`,
        phase: "ocr_running",
        progressCurrent: batchIndex + 1,
        progressTotal: pendingPages.length,
        pageIndex: entry.index + 1,
        pageTotal: total,
        detail: formatOcrHintDetail(result)
      });
    }
  }

  emit({
    id: jobId,
    kind: "gemma-analysis",
    status: "running",
    progressText: "Paddle OCR 선분석 완료",
    phase: "ocr_running",
    progressCurrent: total,
    progressTotal: total,
    pageTotal: total,
    detail: "OCR 프로세스를 종료하고 AI 번역 단계로 넘어갑니다."
  });

  return results;
}

function formatOcrHintDetail(result: OcrBboxResult): string {
  if (isOcrResultNoTextDetected(result)) {
    return `${result.hints.length}개 후보, 텍스트 근거 없음`;
  }
  if (Number.isFinite(result.textEvidenceCount)) {
    return `${result.hints.length}개 후보, 텍스트 근거 ${result.textEvidenceCount}개`;
  }
  return `${result.hints.length}개 후보`;
}

async function collectOcrHintsSequentially(
  runtime: RuntimeModules,
  entries: Array<{ options: TranslationOptions }>
): Promise<OcrBboxResult[]> {
  const results: OcrBboxResult[] = [];
  for (const entry of entries) {
    results.push(await runtime.simplePage.collectOcrBboxHints(entry.options));
  }
  return results;
}

function buildOcrPageOptions(baseOptions: TranslationOptions, page: MangaPage, runPaths: ChapterRunPaths, index: number, total: number): TranslationOptions {
  const outputDir = getOcrHintsOutputDir(runPaths, page);
  return {
    ...baseOptions,
    imagePath: page.imagePath,
    imageWidth: page.width,
    imageHeight: page.height,
    outputDir,
    label: `ocr-page-${index + 1}`,
    ocrPageIndex: index + 1,
    ocrPageTotal: total,
    ocrProgressDefaultToPage: true
  };
}

function getOcrHintsOutputDir(runPaths: ChapterRunPaths, page: MangaPage): string {
  return join(runPaths.chapterDir, "ocr-hints", page.id);
}

function getOcrHintsCachePath(runPaths: ChapterRunPaths, page: MangaPage): string {
  return join(getOcrHintsOutputDir(runPaths, page), "result.json");
}

async function readCachedOcrHints(cachePath: string, page: MangaPage): Promise<OcrBboxResult | null> {
  try {
    const raw = JSON.parse(await readFile(cachePath, "utf8")) as {
      schemaVersion?: number;
      imagePath?: string;
      width?: number;
      height?: number;
      hints?: unknown[];
      diagnostics?: unknown[];
      noTextDetected?: boolean;
      textEvidenceCount?: number;
    };
    if (
      raw.schemaVersion !== OCR_HINT_CACHE_SCHEMA_VERSION ||
      raw.imagePath !== page.imagePath ||
      raw.width !== page.width ||
      raw.height !== page.height ||
      !Array.isArray(raw.hints)
    ) {
      return null;
    }
    return {
      hints: raw.hints,
      diagnostics: Array.isArray(raw.diagnostics) ? raw.diagnostics : [],
      noTextDetected: Boolean(raw.noTextDetected),
      textEvidenceCount: Number.isFinite(raw.textEvidenceCount) ? Number(raw.textEvidenceCount) : undefined
    };
  } catch {
    return null;
  }
}

async function writeCachedOcrHints(cachePath: string, page: MangaPage, result: OcrBboxResult): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    `${JSON.stringify({
      imagePath: page.imagePath,
      width: page.width,
      height: page.height,
      schemaVersion: OCR_HINT_CACHE_SCHEMA_VERSION,
      hints: result.hints,
      diagnostics: result.diagnostics,
      noTextDetected: Boolean(result.noTextDetected),
      textEvidenceCount: Number.isFinite(result.textEvidenceCount) ? result.textEvidenceCount : undefined,
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`,
    "utf8"
  );
}
