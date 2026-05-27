import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildBaseTranslationOptions, type TranslationOptions } from "./appSettings";
import { logError, logInfo, logWarn } from "./logger";
import { startOpenAIOAuthEndpoint, stopOpenAIOAuthEndpoint, type OpenAIOAuthEndpoint } from "./openaiOauthEndpoint";
import { estimateBlockFontSizePx, clamp, clampBbox, enforceRenderDirection, enforceRotationDeg, normalizeBlockType, pixelsToBbox } from "../shared/geometry";
import type { AppSettings, BBox, BlockType, JobEvent, MangaPage, RenderTextDirection, SourceTextDirection, TranslationBlock } from "../shared/types";
import { getAppPaths } from "./appPaths";
import type { ChapterRunPaths } from "./library";
import { getAppSettings } from "./settingsStore";

type PipelineOptions = {
  jobId: string;
  pages: MangaPage[];
  runPaths: ChapterRunPaths;
  emit: (event: JobEvent) => void;
  signal: AbortSignal;
  onCleanupReady?: (cleanup: () => Promise<void>) => void;
  onPageComplete?: (page: MangaPage) => Promise<void>;
  onPageFailed?: (page: MangaPage, errorMessage: string) => Promise<void>;
};

type ServerHandle = {
  baseUrl: string;
  child: unknown;
  startedByScript: boolean;
};

type ModelEndpointHandle = ServerHandle | OpenAIOAuthEndpoint;

type TranslationResult = {
  outputText: string;
  rawResponse: unknown;
  requestBody: RequestSummary | unknown;
};

type OcrBboxResult = {
  hints: unknown[];
  diagnostics: unknown[];
};

type OverlayItem = {
  id: number;
  type: string;
  bbox: BBox;
  jp: string;
  ko: string;
  direction?: SourceTextDirection;
  angle?: number;
  fontSize?: number | null;
};

type DetectedBboxSpace = "normalized_1000" | "pixels";

type RequestSummary = {
  bboxCoordinateSpace?: DetectedBboxSpace;
  bboxCoordinateFrame?: {
    width?: number;
    height?: number;
  };
  ocrBboxHints?: Array<{
    id?: number;
    label?: string;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }>;
};

type BboxNormalizationOptions = {
  coordinateSpace?: DetectedBboxSpace;
  pixelWidth?: number;
  pixelHeight?: number;
};

type RuntimeModules = {
  simplePage: {
    collectOcrBboxHints: (options: TranslationOptions) => Promise<OcrBboxResult>;
    requestTranslation: (server: ServerHandle, options: TranslationOptions) => Promise<TranslationResult>;
    saveArtifacts: (options: TranslationOptions, result: TranslationResult) => Promise<void>;
    startServer: (options: TranslationOptions) => Promise<ServerHandle>;
    stopServer: (server: ServerHandle | null | undefined) => Promise<void>;
    isModelCached: (options: TranslationOptions) => boolean;
  };
  overlayTools: {
    normalizeItems: (parsed: unknown) => OverlayItem[];
    parseJsonLenient: (rawText: string) => unknown;
  };
};

let cachedRuntimeDir: string | null = null;
let cachedRuntime: RuntimeModules | null = null;

function loadRuntimeModules(): RuntimeModules {
  const runtimeDir = getAppPaths().runtimeDir;
  if (cachedRuntime && cachedRuntimeDir === runtimeDir) {
    return cachedRuntime;
  }

  cachedRuntimeDir = runtimeDir;
  cachedRuntime = {
    simplePage: require(join(runtimeDir, "simple-page-translate.cjs")) as RuntimeModules["simplePage"],
    overlayTools: require(join(runtimeDir, "overlay-parser.cjs")) as RuntimeModules["overlayTools"]
  };
  return cachedRuntime;
}

const DEFAULT_TEXT_COLOR = "#111111";
const DEFAULT_BACKGROUND_COLOR = "#fffdf5";

export async function runWholePagePipeline({
  jobId,
  emit,
  onCleanupReady,
  onPageComplete,
  onPageFailed,
  pages,
  runPaths,
  signal
}: PipelineOptions): Promise<{ pages: MangaPage[]; warnings: string[] }> {
  if (pages.length === 0) {
    return { pages: [], warnings: [] };
  }

  throwIfAborted(signal);

  const paths = getAppPaths();
  const appSettings = await getAppSettings(paths);
  const runtime = loadRuntimeModules();
  const baseOptions = buildBaseOptions(jobId, runPaths.runDir, appSettings, paths);
  const progressTotal = pages.length;
  const codexSelected = baseOptions.modelProvider === "openai-codex";
  const modelCached = codexSelected || runtime.simplePage.isModelCached(baseOptions);
  const localModelSelected = !codexSelected && baseOptions.modelSource === "local";

  logInfo("Analysis pipeline initialized", {
    jobId,
    pageCount: pages.length,
    runPaths,
    modelCached,
    settings: summarizeTranslationOptions(baseOptions)
  });

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
      progressPercent: progress.progressPercent,
      progressBytes: progress.progressBytes,
      progressTotalBytes: progress.progressTotalBytes,
      progressBytesPerSecond: progress.progressBytesPerSecond,
      installLogLine: progress.installLogLine
    });
  };
  baseOptions.abortSignal = signal;

  const ocrHintsByPageId = await prepareOcrHintsForPages({
    runtime,
    baseOptions,
    pages,
    runPaths,
    emit,
    jobId,
    signal
  });

  throwIfAborted(signal);

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
          ? `gpu layers ${baseOptions.gpuLayers}, ${baseOptions.modelFile}`
          : "로컬 모델 자산이 없거나 부족해 다운로드/갱신이 필요할 수 있습니다."
  });

  const server = await startModelEndpoint(runtime, baseOptions);
  onCleanupReady?.(() => stopModelEndpoint(runtime, server));
  const warnings: string[] = [];
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

  try {
    const nextPages: MangaPage[] = [];

    for (const [index, page] of pages.entries()) {
      throwIfAborted(signal);
      let successPage: MangaPage | null = null;
      let lastErrorMessage = "";
      let lastError: unknown;
      let lastPageOptions: TranslationOptions | null = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        throwIfAborted(signal);

        const pageOptions = buildPageOptions(baseOptions, page, index, attempt);
        pageOptions.ocrBboxHints = ocrHintsByPageId.get(page.id)?.hints ?? [];
        lastPageOptions = pageOptions;
        pageOptions.abortSignal = signal;
        pageOptions.onProgress = (progress) => {
          emit({
            id: jobId,
            kind: "gemma-analysis",
            status: "running",
            progressText: progress.progressText,
            phase: progress.phase,
            progressCurrent: index + 1,
            progressTotal,
            pageIndex: index + 1,
            pageTotal: pages.length,
            attempt,
            attemptTotal: maxAttempts,
            detail: progress.detail,
            progressPercent: progress.progressPercent,
            progressBytes: progress.progressBytes,
            progressTotalBytes: progress.progressTotalBytes,
            progressBytesPerSecond: progress.progressBytesPerSecond,
            installLogLine: progress.installLogLine
          });
        };
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
          const result = await runtime.simplePage.requestTranslation(server, pageOptions);
          await runtime.simplePage.saveArtifacts(pageOptions, result);

          let parsed: unknown;
          try {
            parsed = runtime.overlayTools.parseJsonLenient(result.outputText);
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

          const items = runtime.overlayTools.normalizeItems(parsed);
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

          const normalizedItems = applyOcrCandidateGeometryLocks(
            normalizeOverlayItemBboxes(items, page, getBboxNormalizationOptions(result.requestBody)),
            page,
            getOcrBboxHints(result.requestBody)
          );
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
            detail: `${items.length}개 블록`
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
        nextPages.push(successPage);
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
      nextPages.push(failedPage);
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
      detail: `${nextPages.length} pages ready`
    });

    return { pages: nextPages, warnings };
  } finally {
    await stopModelEndpoint(runtime, server);
  }
}

async function prepareOcrHintsForPages({
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
        detail: `${cached.hints.length}개 후보`
      });
      continue;
    }

    emit({
      id: jobId,
      kind: "gemma-analysis",
      status: "running",
      progressText: `${page.name} OCR 선분석 중`,
      phase: "ocr_running",
      progressCurrent: index + 1,
      progressTotal: total,
      pageIndex: index + 1,
      pageTotal: total,
      detail: `${index + 1}/${total}`
    });

    const ocrOptions = buildOcrPageOptions(baseOptions, page, runPaths, index);
    ocrOptions.abortSignal = signal;
    ocrOptions.onProgress = (progress) => {
      emit({
        id: jobId,
        kind: "gemma-analysis",
        status: "running",
        progressText: progress.progressText,
        phase: progress.phase,
        progressCurrent: index + 1,
        progressTotal: total,
        pageIndex: index + 1,
        pageTotal: total,
        detail: progress.detail,
        progressPercent: progress.progressPercent,
        progressBytes: progress.progressBytes,
        progressTotalBytes: progress.progressTotalBytes,
        progressBytesPerSecond: progress.progressBytesPerSecond,
        installLogLine: progress.installLogLine
      });
    };

    const result = await runtime.simplePage.collectOcrBboxHints(ocrOptions);
    await writeCachedOcrHints(cachePath, page, result);
    results.set(page.id, result);
    emit({
      id: jobId,
      kind: "gemma-analysis",
      status: "running",
      progressText: `${page.name} OCR 완료`,
      phase: "ocr_running",
      progressCurrent: index + 1,
      progressTotal: total,
      pageIndex: index + 1,
      pageTotal: total,
      detail: `${result.hints.length}개 후보`
    });
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

function buildOcrPageOptions(baseOptions: TranslationOptions, page: MangaPage, runPaths: ChapterRunPaths, index: number): TranslationOptions {
  const outputDir = getOcrHintsOutputDir(runPaths, page);
  return {
    ...baseOptions,
    imagePath: page.imagePath,
    imageWidth: page.width,
    imageHeight: page.height,
    outputDir,
    label: `ocr-page-${index + 1}`
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
      imagePath?: string;
      width?: number;
      height?: number;
      hints?: unknown[];
      diagnostics?: unknown[];
    };
    if (raw.imagePath !== page.imagePath || raw.width !== page.width || raw.height !== page.height || !Array.isArray(raw.hints)) {
      return null;
    }
    return {
      hints: raw.hints,
      diagnostics: Array.isArray(raw.diagnostics) ? raw.diagnostics : []
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
      hints: result.hints,
      diagnostics: result.diagnostics,
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`,
    "utf8"
  );
}

export function buildBaseOptions(
  jobId: string,
  runDir: string,
  settings: AppSettings,
  paths = getAppPaths(),
  env: NodeJS.ProcessEnv = process.env
): TranslationOptions {
  return buildBaseTranslationOptions({
    jobId,
    runDir,
    paths,
    settings,
    env
  });
}

function buildPageOptions(baseOptions: TranslationOptions, page: MangaPage, index: number, attempt: number): TranslationOptions {
  return {
    ...baseOptions,
    imagePath: page.imagePath,
    imageWidth: page.width,
    imageHeight: page.height,
    outputDir: join(baseOptions.outputDir, "pages", page.id, `attempt-${attempt}`),
    label: `page-${index + 1}-attempt-${attempt}`
  };
}

export function overlayItemToBlock(item: OverlayItem, page: MangaPage, index: number): TranslationBlock {
  const type = mapOverlayType(item.type);
  const rawBbox = clampBbox(item.bbox);
  const translatedText = item.ko.trim();
  const sourceText = item.jp.trim();
  const textForSizing = translatedText || sourceText || "...";
  const lineHeight = 1.18;
  const fontSizePx = resolveOverlayFontSizePx(item, rawBbox, page, textForSizing);
  const sourceDirection = item.direction === "vertical" ? "vertical" : "horizontal";
  const bbox = rawBbox;
  const renderDirection = resolveInitialRenderDirection(type, sourceDirection, item, bbox, page, fontSizePx);
  const rotationDeg = enforceRotationDeg(type, item.angle ?? 0);
  return {
    id: `${page.id}-block-${index + 1}`,
    type,
    bbox,
    bboxSpace: "normalized_1000",
    sourceText,
    translatedText,
    confidence: sourceText ? 0.92 : 0.75,
    sourceDirection,
    renderDirection,
    rotationDeg,
    fontSizePx,
    lineHeight,
    textAlign: "center",
    textColor: DEFAULT_TEXT_COLOR,
    backgroundColor: type === "sfx" || type === "caption" ? "#fff4ea" : DEFAULT_BACKGROUND_COLOR,
    opacity: type === "caption" ? 0.7 : type === "sfx" ? 0.5 : 1,
    autoFitText: true
  };
}

function resolveOverlayFontSizePx(item: OverlayItem, bbox: BBox, page: MangaPage, textForSizing: string): number {
  if (typeof item.fontSize === "number" && Number.isFinite(item.fontSize)) {
    return Math.round(clamp(item.fontSize, 6, 160));
  }

  return estimateBlockFontSizePx(textForSizing, { bbox }, { width: page.width, height: page.height });
}

function resolveInitialRenderDirection(
  type: BlockType,
  sourceDirection: SourceTextDirection,
  item: OverlayItem,
  bbox: BBox,
  page: MangaPage,
  fontSizePx: number
): RenderTextDirection {
  if (type === "speech" || type === "caption") {
    return "horizontal";
  }

  if (type === "sfx" && sourceDirection === "vertical" && shouldKeepVerticalRendering(bbox, page, fontSizePx)) {
    return "vertical";
  }

  if (Math.abs(enforceRotationDeg(type, item.angle ?? 0)) > 0) {
    return "rotated";
  }

  return enforceRenderDirection(type, "horizontal");
}

function shouldKeepVerticalRendering(bbox: BBox, page: MangaPage, fontSizePx: number): boolean {
  const widthPx = (bbox.w / 1000) * page.width;
  const estimatedColumns = Math.max(1, Math.round(widthPx / Math.max(1, fontSizePx * 1.15)));
  return estimatedColumns <= 2;
}

export function normalizeOverlayItemBboxes(items: OverlayItem[], page: MangaPage, options: BboxNormalizationOptions = {}): OverlayItem[] {
  const bboxSpace = options.coordinateSpace ?? inferDetectedBboxSpace(items, page);
  const pixelWidth = options.pixelWidth && options.pixelWidth > 0 ? options.pixelWidth : page.width;
  const pixelHeight = options.pixelHeight && options.pixelHeight > 0 ? options.pixelHeight : page.height;
  const fontSizeScale = bboxSpace === "pixels" ? Math.max(page.width / pixelWidth, page.height / pixelHeight) : 1;
  return items.map((item) => ({
    ...item,
    bbox: bboxSpace === "pixels" ? pixelsToBbox(item.bbox, pixelWidth, pixelHeight) : clampBbox(item.bbox),
    fontSize:
      bboxSpace === "pixels" && typeof item.fontSize === "number" && Number.isFinite(item.fontSize)
        ? Math.max(1, Math.round(item.fontSize * fontSizeScale))
        : item.fontSize
  }));
}

function getBboxNormalizationOptions(requestBody: TranslationResult["requestBody"]): BboxNormalizationOptions {
  if (!requestBody || typeof requestBody !== "object") {
    return {};
  }

  const summary = requestBody as RequestSummary;
  if (summary.bboxCoordinateSpace !== "pixels") {
    return {};
  }

  return {
    coordinateSpace: "pixels",
    pixelWidth: Number(summary.bboxCoordinateFrame?.width),
    pixelHeight: Number(summary.bboxCoordinateFrame?.height)
  };
}

function getOcrBboxHints(requestBody: TranslationResult["requestBody"]): NonNullable<RequestSummary["ocrBboxHints"]> {
  if (!requestBody || typeof requestBody !== "object") {
    return [];
  }
  const hints = (requestBody as RequestSummary).ocrBboxHints;
  return Array.isArray(hints) ? hints : [];
}

export function applyOcrCandidateGeometryLocks(items: OverlayItem[], page: MangaPage, hints: NonNullable<RequestSummary["ocrBboxHints"]>): OverlayItem[] {
  if (hints.length === 0) {
    return items;
  }

  const hintMap = new Map<number, { bbox: BBox; label: string }>();
  for (const hint of hints) {
    const id = Number(hint.id);
    const x1 = Number(hint.x1);
    const y1 = Number(hint.y1);
    const x2 = Number(hint.x2);
    const y2 = Number(hint.y2);
    if (!Number.isInteger(id) || id <= 0 || ![x1, y1, x2, y2].every(Number.isFinite)) {
      continue;
    }
    hintMap.set(id, {
      bbox: pixelsToBbox({
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        w: Math.abs(x2 - x1),
        h: Math.abs(y2 - y1)
      }, page.width, page.height),
      label: String(hint.label ?? "")
    });
  }

  if (hintMap.size === 0) {
    return items;
  }

  const usedHintIds = new Set<number>();
  const firstPass = items.map((item) => {
    const lockedHint = hintMap.get(item.id);
    if (!lockedHint || !isNearOcrHint(item.bbox, lockedHint.bbox, page)) {
      return item;
    }
    usedHintIds.add(item.id);
    return {
      ...item,
      bbox: lockedHint.bbox
    };
  });

  return firstPass.map((item) => {
    if (usedHintIds.has(item.id) || normalizeBlockType(item.type) === "sfx") {
      return item;
    }
    const nearest = findNearestUnusedLayoutHint(item.bbox, page, hintMap, usedHintIds);
    if (!nearest) {
      return item;
    }
    usedHintIds.add(nearest.id);
    return {
      ...item,
      bbox: nearest.bbox
    };
  });
}

function findNearestUnusedLayoutHint(
  bbox: BBox,
  page: MangaPage,
  hints: Map<number, { bbox: BBox; label: string }>,
  usedHintIds: Set<number>
): { id: number; bbox: BBox } | null {
  let best: { id: number; bbox: BBox; distance: number } | null = null;
  for (const [id, hint] of hints) {
    if (usedHintIds.has(id) || hint.label === "ocr_textline") {
      continue;
    }
    if (!isNearOcrHint(bbox, hint.bbox, page)) {
      continue;
    }
    const distance = bboxCenterDistancePx(bbox, hint.bbox, page);
    if (!best || distance < best.distance) {
      best = { id, bbox: hint.bbox, distance };
    }
  }
  return best;
}

function isNearOcrHint(modelBbox: BBox, hintBbox: BBox, page: MangaPage): boolean {
  const modelPx = normalizedBboxToPixels(modelBbox, page);
  const hintPx = normalizedBboxToPixels(hintBbox, page);
  const modelCenterX = modelPx.x + modelPx.w / 2;
  const modelCenterY = modelPx.y + modelPx.h / 2;
  const hintCenterX = hintPx.x + hintPx.w / 2;
  const hintCenterY = hintPx.y + hintPx.h / 2;
  const distance = Math.hypot(modelCenterX - hintCenterX, modelCenterY - hintCenterY);
  const tolerance = Math.max(150, Math.max(hintPx.w, hintPx.h) * 1.35);
  return distance <= tolerance || bboxOverlapRatio(modelPx, hintPx) > 0.1;
}

function bboxCenterDistancePx(a: BBox, b: BBox, page: MangaPage): number {
  const aPx = normalizedBboxToPixels(a, page);
  const bPx = normalizedBboxToPixels(b, page);
  return Math.hypot(
    aPx.x + aPx.w / 2 - (bPx.x + bPx.w / 2),
    aPx.y + aPx.h / 2 - (bPx.y + bPx.h / 2)
  );
}

function normalizedBboxToPixels(bbox: BBox, page: MangaPage): BBox {
  return {
    x: (bbox.x / 1000) * page.width,
    y: (bbox.y / 1000) * page.height,
    w: (bbox.w / 1000) * page.width,
    h: (bbox.h / 1000) * page.height
  };
}

function bboxOverlapRatio(a: BBox, b: BBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
  const minArea = Math.max(1, Math.min(a.w * a.h, b.w * b.h));
  return overlap / minArea;
}

function inferDetectedBboxSpace(items: OverlayItem[], page: Pick<MangaPage, "width" | "height">): DetectedBboxSpace {
  const coordinatePixelEvidence = items.filter((item) => hasPixelCoordinateEvidence(item.bbox, page)).length;
  if (coordinatePixelEvidence > 0) {
    return "pixels";
  }

  const overflowPixelEvidence = items.filter((item) => hasPixelOverflowEvidence(item.bbox, page)).length;
  return overflowPixelEvidence >= Math.max(2, Math.ceil(items.length * 0.2)) ? "pixels" : "normalized_1000";
}

function hasPixelCoordinateEvidence(bbox: BBox, page: Pick<MangaPage, "width" | "height">): boolean {
  return fitsPagePixels(bbox, page) && (bbox.x > 1000 || bbox.y > 1000 || bbox.w > 1000 || bbox.h > 1000);
}

function hasPixelOverflowEvidence(bbox: BBox, page: Pick<MangaPage, "width" | "height">): boolean {
  const right = bbox.x + bbox.w;
  const bottom = bbox.y + bbox.h;
  const normalizedTolerance = 80;
  return fitsPagePixels(bbox, page) && (right > 1000 + normalizedTolerance || bottom > 1000 + normalizedTolerance);
}

function fitsPagePixels(bbox: BBox, page: Pick<MangaPage, "width" | "height">): boolean {
  const right = bbox.x + bbox.w;
  const bottom = bbox.y + bbox.h;
  const pixelBoundsTolerance = 1.06;
  return (
    bbox.x >= 0 &&
    bbox.y >= 0 &&
    bbox.w > 0 &&
    bbox.h > 0 &&
    right <= page.width * pixelBoundsTolerance &&
    bottom <= page.height * pixelBoundsTolerance
  );
}

function mapOverlayType(value: string): BlockType {
  const normalized = normalizeBlockType(value);
  if (normalized !== "other") {
    return normalized;
  }
  const text = value.trim().toLowerCase();
  if (text === "dialogue" || text === "dialog") {
    return "speech";
  }
  if (text === "narration" || text === "caption") {
    return "caption";
  }
  if (text === "name") {
    return "caption";
  }
  return "other";
}

function buildPageWarnings(pageName: string, items: OverlayItem[]): string[] {
  const warnings: string[] = [];
  const uncertainCount = items.filter((item) => item.jp.includes("[?]") || item.ko.includes("[?]")).length;
  if (uncertainCount > 0) {
    warnings.push(`${pageName}: 불확실한 OCR 조각이 ${uncertainCount}개 있습니다.`);
  }
  return warnings;
}

function readNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function summarizePreview(text: string, maxLength = 240): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function summarizeTranslationOptions(options: TranslationOptions): Record<string, unknown> {
  return {
    label: options.label,
    imagePath: options.imagePath,
    outputDir: options.outputDir,
    modelProvider: options.modelProvider,
    port: options.port,
    promptMode: options.promptMode,
    promptOverrideText: options.promptOverrideText ? summarizePreview(options.promptOverrideText, 600) : undefined,
    nsfwMode: options.nsfwMode,
    temperature: options.temperature,
    topP: options.topP,
    topK: options.topK,
    maxTokens: options.maxTokens,
    ctx: options.ctx,
    batch: options.batch,
    ubatch: options.ubatch,
    gpuLayers: options.gpuLayers,
    fitTargetMb: options.fitTargetMb,
    imageMinTokens: options.imageMinTokens,
    imageMaxTokens: options.imageMaxTokens,
    includeEnhancedVariant: options.includeEnhancedVariant,
    enhancedMaxLongSide: options.enhancedMaxLongSide,
    enhancedContrast: options.enhancedContrast,
    imageFirst: options.imageFirst,
    reuseServer: options.reuseServer,
    workingDir: options.workingDir,
    toolsDir: options.toolsDir,
    serverPath: options.serverPath,
    modelRepo: options.modelRepo,
    modelFile: options.modelFile,
    codexModel: options.codexModel,
    codexReasoningEffort: options.codexReasoningEffort,
    codexOauthPort: options.codexOauthPort,
    ocrDevice: options.ocrDevice,
    hfHomeDir: options.hfHomeDir ?? null,
    hfHubCacheDir: options.hfHubCacheDir ?? null
  };
}

async function startModelEndpoint(runtime: RuntimeModules, options: TranslationOptions): Promise<ModelEndpointHandle> {
  if (options.modelProvider === "openai-codex") {
    return startOpenAIOAuthEndpoint(options);
  }
  return runtime.simplePage.startServer(options);
}

async function stopModelEndpoint(runtime: RuntimeModules, endpoint: ModelEndpointHandle | null | undefined): Promise<void> {
  if (isOpenAIOAuthEndpoint(endpoint)) {
    await stopOpenAIOAuthEndpoint(endpoint);
    return;
  }
  await runtime.simplePage.stopServer(endpoint);
}

function isOpenAIOAuthEndpoint(endpoint: ModelEndpointHandle | null | undefined): endpoint is OpenAIOAuthEndpoint {
  return Boolean(endpoint && "provider" in endpoint && endpoint.provider === "openai-codex");
}

function summarizePage(page: MangaPage): Record<string, unknown> {
  return {
    id: page.id,
    name: page.name,
    imagePath: page.imagePath,
    width: page.width,
    height: page.height,
    analysisStatus: page.analysisStatus
  };
}

function classifyFailure(error: unknown): string {
  if (isNonRetriableRuntimeError(error)) {
    return "runtime";
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

  if (message.includes("build-page-variant")) {
    return "image-preprocessing";
  }
  if (message.includes("llama-server") || message.includes("bundled llama-server") || message.includes("timed out while waiting")) {
    return "server-startup";
  }
  if (
    message.includes("gemma request failed") ||
    message.includes("openai codex request failed") ||
    message.includes("request transport failed") ||
    message.includes("openai-oauth")
  ) {
    return "model-request";
  }
  if (message.includes("json parse failed")) {
    return "response-json-parse";
  }
  if (message.includes("구조화 형식으로 해석하지 못했습니다") || message.includes("parseable structured payload")) {
    return "overlay-parse";
  }
  if (message.includes("empty response")) {
    return "empty-model-response";
  }
  if (message.includes("bbox 결과를 만들지 못했습니다")) {
    return "empty-overlay-items";
  }
  return "unknown";
}

function isNonRetriableRuntimeError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "nonRetriable" in error && (error as { nonRetriable?: unknown }).nonRetriable);
}

function isAbortErrorLike(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
