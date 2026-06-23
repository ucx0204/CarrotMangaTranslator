import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranslationOptions } from "../appSettings";
import type { MangaPage } from "../../shared/types";
import { prunePromptWorkContextForBudget } from "../../shared/workContextBudget";
import { buildNoTextCompletedPage } from "./noText";
import {
  applyOcrCandidateGeometryLocks,
  buildPageWarnings,
  filterRejectedOrUncertainSoundItems,
  getBboxNormalizationOptions,
  getOcrBboxHints,
  normalizeOverlayItemBboxes,
  overlayItemToBlock,
} from "./overlayItems";
import { buildPageOptions, summarizePreview } from "./options";
import { attachPageProgress } from "./progressEvents";
import type {
  ModelEndpointHandle,
  OcrBboxResult,
  OverlayItem,
  PipelineWorkContext,
  TranslationResult,
} from "./types";
import { buildPromptWorkContextForPage } from "./workContextPrompt";
import { isRequestNoTextDetected } from "./noText";
import type { ProgressContext } from "./progressEvents";
import type { TranslationRuntimePort } from "./translationRuntimePort";

export type PageBuildResult =
  | {
      kind: "completed";
      page: MangaPage;
      warnings: string[];
      detail: string;
    }
  | {
      kind: "no-text";
      page: MangaPage;
    };

export function buildRequestPageOptions({
  attempt,
  baseOptions,
  context,
  maxAttempts,
  ocrHintsByPageId,
  page,
  pageIndex,
  signal,
  skipOcrPrepass,
  workContext,
}: {
  attempt: number;
  baseOptions: TranslationOptions;
  context: ProgressContext;
  maxAttempts: number;
  ocrHintsByPageId: Map<string, OcrBboxResult>;
  page: MangaPage;
  pageIndex: number;
  signal: AbortSignal;
  skipOcrPrepass: boolean;
  workContext?: PipelineWorkContext;
}): TranslationOptions {
  const pageOptions = buildPageOptions(baseOptions, page, pageIndex, attempt);
  if (workContext) {
    const promptWorkContext = buildPromptWorkContextForPage({
      baseStyleGuide: workContext.styleGuide,
      storyMemory: workContext.storyMemory,
      pageId: page.id,
      pageIndex,
      recentPageCount: workContext.recentPageCount,
    });
    const budgetedWorkContext = prunePromptWorkContextForBudget(
      promptWorkContext,
      {
        ctx: pageOptions.ctx,
        maxTokens: pageOptions.maxTokens,
      },
    );
    pageOptions.workContext = budgetedWorkContext.workContext;
    pageOptions.workContextBudget = budgetedWorkContext.budget;
  }
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
      textEvidenceCount: 0,
    };
    pageOptions.ocrBboxHints = pageOptions.ocrBboxResult.hints ?? [];
  }
  pageOptions.abortSignal = signal;
  attachPageProgress(context, pageOptions, pageIndex, attempt, maxAttempts);
  return pageOptions;
}

export async function requestPageTranslation({
  pageOptions,
  runtime,
  server,
}: {
  pageOptions: TranslationOptions;
  runtime: TranslationRuntimePort;
  server: ModelEndpointHandle;
}): Promise<TranslationResult> {
  const result = await runtime.requestTranslation(server, pageOptions);
  await runtime.saveArtifacts(pageOptions, result);
  return result;
}

export async function buildPageResult({
  jobId,
  page,
  pageOptions,
  result,
  runtime,
}: {
  jobId: string;
  page: MangaPage;
  pageOptions: TranslationOptions;
  result: TranslationResult;
  runtime: TranslationRuntimePort;
}): Promise<PageBuildResult> {
  const items = parseOverlayItems(runtime, result, page, pageOptions);
  if (items.length === 0 && isRequestNoTextDetected(result.requestBody)) {
    return { kind: "no-text", page: buildNoTextCompletedPage(page) };
  }
  if (items.length === 0) {
    const bboxError = new Error(`${page.name}: bbox 결과를 만들지 못했습니다.`);
    Object.assign(bboxError, {
      outputDir: pageOptions.outputDir,
      outputPreview: summarizePreview(result.outputText),
    });
    throw bboxError;
  }

  await writeOverlayItems(pageOptions.outputDir, items);
  const normalizedItems = buildNormalizedItems(page, result, items);
  const soundFiltered = filterRejectedOrUncertainSoundItems(normalizedItems);
  const blocks = soundFiltered.items.map((item, itemIndex) =>
    overlayItemToBlock(
      item,
      page,
      itemIndex,
      jobId,
      pageOptions.blockFormatDefaults,
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
    warnings: buildPageWarnings(page.name, soundFiltered.items),
    detail:
      soundFiltered.droppedCount > 0
        ? `${soundFiltered.items.length}개 블록, 불확실한 효과음 ${soundFiltered.droppedCount}개 제외`
        : `${soundFiltered.items.length}개 블록`,
  };
}

export function buildFailedPage(
  page: MangaPage,
  lastErrorMessage: string,
): MangaPage {
  return {
    ...page,
    analysisStatus: "failed",
    lastError: lastErrorMessage,
    updatedAt: new Date().toISOString(),
  };
}

async function writeOverlayItems(
  outputDir: string,
  items: OverlayItem[],
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, "overlay-items.json"),
    `${JSON.stringify({ items }, null, 2)}\n`,
    "utf8",
  );
}

function parseOverlayItems(
  runtime: TranslationRuntimePort,
  result: TranslationResult,
  page: MangaPage,
  pageOptions: TranslationOptions,
): OverlayItem[] {
  try {
    return runtime.normalizeItems(runtime.parseJsonLenient(result.outputText));
  } catch (error) {
    throw buildParseError(page, pageOptions, result, error);
  }
}

function buildParseError(
  page: MangaPage,
  pageOptions: TranslationOptions,
  result: TranslationResult,
  error: unknown,
): Error {
  const preview = summarizePreview(result.outputText);
  const parseError = new Error(
    `${page.name}: 모델 응답을 구조화 형식으로 해석하지 못했습니다. preview=${preview} cause=${error instanceof Error ? error.message : String(error)}`,
  ) as Error & { cause?: unknown };
  parseError.cause = error;
  Object.assign(parseError, {
    outputPreview: preview,
    outputDir: pageOptions.outputDir,
    responseFormat: "structured-overlay",
  });
  return parseError;
}

function buildNormalizedItems(
  page: MangaPage,
  result: TranslationResult,
  items: OverlayItem[],
): OverlayItem[] {
  return applyOcrCandidateGeometryLocks(
    normalizeOverlayItemBboxes(
      items,
      page,
      getBboxNormalizationOptions(result.requestBody),
    ),
    page,
    getOcrBboxHints(result.requestBody),
  );
}
