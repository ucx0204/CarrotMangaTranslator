import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranslationOptions } from "../appSettings";
import type { MangaPage } from "../../shared/types";
import { prunePromptWorkContextForBudget } from "../../shared/workContextBudget";
import { buildNoTextCompletedPage } from "./noText";
import { buildPreviousBlocksForPrompt } from "./previousBlocksForPrompt";
import {
  applyOcrCandidateGeometryLocks,
  buildPageWarnings,
  filterRejectedOrUncertainSoundItems,
  getBboxNormalizationOptions,
  getOcrBboxHints,
  normalizeOverlayItemBboxes,
  overlayItemToBlock,
  validateOverlayItemsAgainstReferences,
} from "./overlayItems";
import { buildPageOptions, summarizePreview } from "./options";
import { attachPageProgress } from "./progressEvents";
import type {
  ModelEndpointHandle,
  OcrBboxResult,
  OverlayItem,
  PipelineRegionContext,
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
  regionContext,
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
  regionContext?: PipelineRegionContext;
}): TranslationOptions {
  const pageOptions = buildPageOptions(baseOptions, page, pageIndex, attempt);
  if (workContext) {
    const promptPageIndex = regionContext?.sourcePageIndex ?? pageIndex;
    const promptWorkContext = buildPromptWorkContextForPage({
      baseStyleGuide: workContext.styleGuide,
      storyMemory: workContext.storyMemory,
      pageId: regionContext?.sourcePage.id ?? page.id,
      pageIndex: promptPageIndex,
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
  if (regionContext) {
    pageOptions.regionCropMode = true;
    pageOptions.regionContextImagePath = regionContext.sourcePage.imagePath;
    pageOptions.regionContextImageWidth = regionContext.sourcePage.width;
    pageOptions.regionContextImageHeight = regionContext.sourcePage.height;
    pageOptions.regionContextCropRect = regionContext.cropRect;
    pageOptions.ocrBboxResult = ocrHintsByPageId.get(page.id) ?? {
      hints: [],
      diagnostics: [{ provider: "region-context", reason: "missing-result" }],
      noTextDetected: false,
      textEvidenceCount: 0,
    };
    pageOptions.ocrBboxHints = pageOptions.ocrBboxResult.hints ?? [];
  } else if (skipOcrPrepass) {
    pageOptions.skipOcrBboxHints = true;
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
  applyStrictRefineOptions(pageOptions, page);
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
  if (items.length === 0 && pageOptions.regionCropMode) {
    return { kind: "no-text", page: buildNoTextCompletedPage(page) };
  }
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

  await writeOverlayItems(pageOptions.outputDir, items, pageOptions);
  const normalizedItems = buildNormalizedItems(page, result, items);
  const validated = validateOverlayItemsAgainstReferences(
    normalizedItems,
    page,
    getOcrBboxHints(result.requestBody),
    pageOptions.previousBlocksForPrompt,
  );
  const soundFiltered = filterRejectedOrUncertainSoundItems(validated.items, {
    dropUncertainSound: !pageOptions.regionCropMode,
  });
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
    detail: buildPageResultDetail(
      soundFiltered.items.length,
      validated.droppedCount,
      soundFiltered.droppedCount,
      validated.reasons,
    ),
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
  pageOptions: TranslationOptions,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  if (pageOptions.regionCropMode) {
    await writeFile(
      join(outputDir, "region-item.json"),
      `${JSON.stringify({ item: items[0] ?? null }, null, 2)}\n`,
      "utf8",
    );
    return;
  }
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
    if (pageOptions.regionCropMode) {
      return runtime.normalizeRegionSingleItem(
        runtime.parseRegionSingleItem(result.outputText),
      );
    }
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
    responseFormat: pageOptions.regionCropMode
      ? "region-single-item"
      : "structured-overlay",
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

function buildPageResultDetail(
  blockCount: number,
  validationDroppedCount: number,
  soundDroppedCount: number,
  validationReasons: Record<string, number>,
): string {
  const details = [`${blockCount}개 블록`];
  if (validationDroppedCount > 0) {
    details.push(
      `잡음/중복 ${validationDroppedCount}개 제외(${formatValidationReasons(validationReasons)})`,
    );
  }
  if (soundDroppedCount > 0) {
    details.push(`불확실한 효과음 ${soundDroppedCount}개 제외`);
  }
  return details.join(", ");
}

function formatValidationReasons(reasons: Record<string, number>): string {
  const entries = Object.entries(reasons).filter(([, count]) => count > 0);
  return entries.length
    ? entries.map(([reason, count]) => `${reason}:${count}`).join("/")
    : "unknown";
}

function applyStrictRefineOptions(
  pageOptions: TranslationOptions,
  page: MangaPage,
): void {
  if (!page.blocks.length) {
    return;
  }

  pageOptions.strictRefineMode = true;
  pageOptions.previousBlocksForPrompt = buildPreviousBlocksForPrompt(
    page,
    Array.isArray(pageOptions.ocrBboxHints) ? pageOptions.ocrBboxHints : [],
  );

  pageOptions.temperature = Math.min(pageOptions.temperature, 0.1);
  pageOptions.topP = Math.min(pageOptions.topP, 0.85);
  pageOptions.topK = Math.min(pageOptions.topK, 32);
}
