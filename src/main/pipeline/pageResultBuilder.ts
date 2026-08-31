/* eslint-disable max-lines -- page assembly and its fail-closed inference provenance remain auditable together */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranslationOptions } from "../appSettings";
import type { MangaPage } from "../../shared/libraryTypes";
import { tMain } from "./localization";
import { prunePromptWorkContextForBudget } from "../../shared/workContextBudget";
import {
  buildNoTextCompletedPage,
  isJapaneseCumulativeNoTextRequest,
} from "./noText";
import {
  buildKeepBlocksCompletedPage,
  shouldKeepExistingBlocks,
} from "./keepBlocksResult";
import { buildKeepBlocksFontInferenceBlocks } from "./keepBlocksAssignment";
import { buildPreviousBlocksForPrompt } from "./previousBlocksForPrompt";
import { filterRejectedOrUncertainSoundItems } from "./overlayItems";
import { applyOcrCandidateGeometryLocks } from "./overlayOcrGeometryLocks";
import {
  getBboxNormalizationOptions,
  getOcrBboxHints,
  normalizeOverlayItemBboxes,
  validateOverlayItemsAgainstReferences,
} from "./overlayItemReferences";
import { buildPageOptions, summarizePreview } from "./options";
import { attachPageProgress } from "./progressEvents";
import type {
  CompletedPageBuildResult,
  ModelEndpointHandle,
  OcrBboxResult,
  OverlayItem,
  PipelineRegionContext,
  PipelineOptions,
  PipelineWorkContext,
  PageContextPayload,
  TranslationResult,
} from "./types";
import { buildPromptWorkContextForPage } from "./workContextPrompt";
import { isRequestNoTextDetected } from "./noText";
import type { ProgressContext } from "./progressEvents";
import type { TranslationRuntimePort } from "./translationRuntimePort";
import { parsePageResponse } from "./pageResponseParser";
import { buildTranslatedPageResult } from "./translatedPageResult";
import { runPageTypographyStages } from "./pageTypographyStages";
import { attachFontMatchingFixedBlockCandidateMembership } from "./fontMatchingOcrGeometryDirection";
import type { FontMatchingPageInferencePort } from "./fontMatchingPagePixelInferenceTypes";
import type { AutomaticFontPageCoordinatorV2 } from "./automaticFontMatchingV2PageCoordinator";
import { resolveKeepBlocksAutomaticFont } from "./keepBlocksAutomaticFont";
import {
  applyGlossaryOmissionsToOverlayItems,
  collectGlossaryOmissionTerms,
} from "./glossaryOmission";

export type PageBuildResult =
  | CompletedPageBuildResult
  | {
      kind: "no-text";
      page: MangaPage;
      warnings: string[];
      pageContext?: PageContextPayload;
    };

export type PreparedPageBuildResult =
  | Readonly<{
      kind: "ready";
      result: PageBuildResult;
    }>
  | Readonly<{
      kind: "translated";
      jobId: string;
      page: MangaPage;
      pageOptions: TranslationOptions;
      items: OverlayItem[];
      fontInferenceItems: OverlayItem[];
      keepBlocksInferenceBlocks?: ReturnType<
        typeof buildKeepBlocksFontInferenceBlocks
      >;
      soundDroppedCount: number;
      validationDroppedCount: number;
      validationReasons: Record<string, number>;
      omittedCandidateIds?: number[];
      remappedCount?: number;
      contextWarnings: string[];
      pageContext?: PageContextPayload;
    }>;

export function buildRequestPageOptions({
  attempt,
  baseOptions,
  blockMode,
  context,
  maxAttempts,
  ocrHintsByPageId,
  page,
  pageIndex,
  progressPageIndex = pageIndex,
  signal,
  skipOcrPrepass,
  workContext,
  regionContext,
  collectPageContext,
  cumulativeContextDetail,
}: {
  attempt: number;
  baseOptions: TranslationOptions;
  blockMode?: "auto" | "keep";
  context: ProgressContext;
  maxAttempts: number;
  ocrHintsByPageId: Map<string, OcrBboxResult>;
  page: MangaPage;
  pageIndex: number;
  progressPageIndex?: number;
  signal: AbortSignal;
  skipOcrPrepass: boolean;
  workContext?: PipelineWorkContext;
  regionContext?: PipelineRegionContext;
  collectPageContext?: boolean;
  cumulativeContextDetail?: PipelineOptions["cumulativeContextDetail"];
}): TranslationOptions {
  const pageOptions = buildPageOptions(baseOptions, page, pageIndex, attempt);
  pageOptions.collectPageContext = collectPageContext || undefined;
  pageOptions.cumulativeContextDetail = collectPageContext
    ? (cumulativeContextDetail ?? "detailed")
    : undefined;
  applyOcrHintPageOptions({
    ocrHintsByPageId,
    page,
    pageOptions,
    regionContext,
    skipOcrPrepass,
  });
  applyWorkContextPageOptions({
    page,
    pageIndex,
    pageOptions,
    regionContext,
    workContext,
  });
  applyStrictRefineOptions(
    pageOptions,
    page,
    shouldKeepExistingBlocks(blockMode, page),
  );
  pageOptions.abortSignal = signal;
  attachPageProgress(
    context,
    pageOptions,
    progressPageIndex,
    attempt,
    maxAttempts,
  );
  return pageOptions;
}

function applyWorkContextPageOptions({
  page,
  pageIndex,
  pageOptions,
  regionContext,
  workContext,
}: {
  page: MangaPage;
  pageIndex: number;
  pageOptions: TranslationOptions;
  regionContext?: PipelineRegionContext;
  workContext?: PipelineWorkContext;
}): void {
  if (!workContext) return;
  const omissionTerms = collectGlossaryOmissionTerms(workContext.styleGuide);
  if (omissionTerms.length > 0) {
    pageOptions.glossaryOmissionTerms = omissionTerms;
  }
  const promptWorkContext = buildPromptWorkContextForPage({
    baseStyleGuide: workContext.styleGuide,
    storyMemory: workContext.storyMemory,
    pageId: regionContext?.sourcePage.id ?? page.id,
    pageIndex: regionContext?.sourcePageIndex ?? pageIndex,
    recentPageCount: workContext.recentPageCount,
    previousStoryPages: workContext.previousStoryPages,
    ocrHints: pageOptions.ocrBboxHints,
  });
  const budgetedWorkContext = prunePromptWorkContextForBudget(
    promptWorkContext,
    { ctx: pageOptions.ctx, maxTokens: pageOptions.maxTokens },
  );
  pageOptions.workContext = budgetedWorkContext.workContext;
  pageOptions.workContextBudget = budgetedWorkContext.budget;
}

function applyOcrHintPageOptions({
  ocrHintsByPageId,
  page,
  pageOptions,
  regionContext,
  skipOcrPrepass,
}: {
  ocrHintsByPageId: Map<string, OcrBboxResult>;
  page: MangaPage;
  pageOptions: TranslationOptions;
  regionContext?: PipelineRegionContext;
  skipOcrPrepass: boolean;
}): void {
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
    return;
  }
  if (skipOcrPrepass) {
    pageOptions.skipOcrBboxHints = true;
    pageOptions.ocrBboxProvider = "none";
    delete pageOptions.ocrBboxHints;
    delete pageOptions.ocrBboxResult;
    return;
  }
  pageOptions.ocrBboxResult = ocrHintsByPageId.get(page.id) ?? {
    hints: [],
    diagnostics: [{ provider: "prepass", reason: "missing-result" }],
    noTextDetected: false,
    textEvidenceCount: 0,
  };
  pageOptions.ocrBboxHints = pageOptions.ocrBboxResult.hints ?? [];
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

export async function preparePageResult({
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
}): Promise<PreparedPageBuildResult> {
  const parsed = parsePageResponse({
    runtime,
    result,
    page,
    pageOptions,
  });
  const items = applyGlossaryOmissionsToOverlayItems(parsed.items, pageOptions);
  if (isJapaneseCumulativeNoTextRequest(pageOptions, result.requestBody)) {
    return {
      kind: "ready",
      result: {
        kind: "no-text",
        page: buildNoTextCompletedPage(page),
        warnings: parsed.warnings,
        pageContext: parsed.pageContext,
      },
    };
  }
  if (items.length === 0) {
    const emptyResult = buildEmptyItemsResult(page, pageOptions, result);
    return {
      kind: "ready",
      result: {
        ...emptyResult,
        warnings: parsed.warnings,
        pageContext: parsed.pageContext,
      },
    };
  }

  return prepareTranslatedPageResult({
    jobId,
    page,
    pageOptions,
    result,
    items,
    contextWarnings: parsed.warnings,
    pageContext: parsed.pageContext,
  });
}

async function prepareTranslatedPageResult({
  jobId,
  page,
  pageOptions,
  result,
  items,
  contextWarnings,
  pageContext,
}: {
  jobId: string;
  page: MangaPage;
  pageOptions: TranslationOptions;
  result: TranslationResult;
  items: OverlayItem[];
  contextWarnings: string[];
  pageContext?: PageContextPayload;
}): Promise<PreparedPageBuildResult> {
  await writeOverlayItems(pageOptions.outputDir, items, pageOptions);
  const normalizedItems = buildNormalizedItems(page, result, items);
  const validated = validateOverlayItemsAgainstReferences(
    normalizedItems,
    page,
    getOcrBboxHints(result.requestBody),
    pageOptions.previousBlocksForPrompt,
    {
      regionCropMode: Boolean(pageOptions.regionCropMode),
      sourceLanguage: pageOptions.sourceLanguage,
    },
  );
  const soundFiltered = filterRejectedOrUncertainSoundItems(validated.items, {
    dropUncertainSound: !pageOptions.regionCropMode,
  });
  const fontInferenceItems = attachFontMatchingFixedBlockCandidateMembership(
    soundFiltered.items,
    result.requestBody,
  );
  const keepBlocksInferenceBlocks = pageOptions.keepBlocksMode
    ? buildKeepBlocksFontInferenceBlocks({
        page,
        items: fontInferenceItems,
        previousBlocks: pageOptions.previousBlocksForPrompt ?? [],
      })
    : undefined;
  return {
    kind: "translated",
    jobId,
    page,
    pageOptions,
    items: soundFiltered.items,
    fontInferenceItems,
    keepBlocksInferenceBlocks,
    soundDroppedCount: soundFiltered.droppedCount,
    validationDroppedCount: validated.droppedCount,
    validationReasons: validated.reasons,
    omittedCandidateIds: validated.omittedCandidateIds,
    remappedCount: validated.remappedCount,
    contextWarnings,
    pageContext,
  };
}

export async function finalizePreparedPageResult({
  prepared,
  fontMatchingPageInference,
  fontMatchingChapterCoordinator,
}: {
  prepared: PreparedPageBuildResult;
  fontMatchingPageInference?: FontMatchingPageInferencePort;
  fontMatchingChapterCoordinator?: AutomaticFontPageCoordinatorV2;
}): Promise<PageBuildResult> {
  if (prepared.kind === "ready") return prepared.result;
  const {
    jobId,
    page,
    pageOptions,
    items,
    fontInferenceItems,
    keepBlocksInferenceBlocks,
    soundDroppedCount,
    validationDroppedCount,
    validationReasons,
    omittedCandidateIds,
    remappedCount,
    contextWarnings,
    pageContext,
  } = prepared;
  const { pixelInference, sourceFontSizeEstimates } =
    await runPageTypographyStages({
      jobId,
      page,
      pageOptions,
      items: fontInferenceItems,
      inferenceBlocks: keepBlocksInferenceBlocks,
      port: fontMatchingPageInference,
    });
  if (pageOptions.keepBlocksMode) {
    const kept = buildKeepBlocksCompletedPage({
      page,
      items,
      previousBlocks: pageOptions.previousBlocksForPrompt ?? [],
      soundDroppedCount,
      naturalLayout: resolveKeepBlocksNaturalLayout(pageOptions),
      automaticFont: resolveKeepBlocksAutomaticFont(
        pageOptions,
        pixelInference,
        fontMatchingChapterCoordinator,
      ),
      fontSizeAutoFit: pageOptions.fontSizeAutoFit === true,
      sourceFontSizeEstimates,
    });
    return {
      kind: "completed",
      ...kept,
      warnings: [...kept.warnings, ...contextWarnings],
      pageContext,
    };
  }
  return buildTranslatedPageResult({
    jobId,
    page,
    pageOptions,
    items,
    soundDroppedCount,
    validationDroppedCount,
    validationReasons,
    omittedCandidateIds,
    remappedCount,
    contextWarnings,
    pageContext,
    fontMatchingPageInference: pixelInference,
    fontMatchingChapterCoordinator,
    sourceFontSizeEstimates,
  });
}

/**
 * Build the lightweight completed-page projection needed to feed cumulative
 * story context into the next model request. GPU typography is deliberately
 * omitted; the authoritative page is rebuilt after the model endpoint exits.
 */
export function projectPreparedPageForContext(
  prepared: PreparedPageBuildResult,
): MangaPage {
  if (prepared.kind === "ready") return prepared.result.page;
  if (prepared.pageOptions.keepBlocksMode) {
    return buildKeepBlocksCompletedPage({
      page: prepared.page,
      items: prepared.items,
      previousBlocks: prepared.pageOptions.previousBlocksForPrompt ?? [],
      soundDroppedCount: prepared.soundDroppedCount,
      naturalLayout: resolveKeepBlocksNaturalLayout(prepared.pageOptions),
      automaticFont: undefined,
    }).page;
  }
  return buildTranslatedPageResult({
    jobId: prepared.jobId,
    page: prepared.page,
    pageOptions: {
      ...prepared.pageOptions,
      autoFontMatching: false,
      fontSizeAutoFit: false,
    },
    items: prepared.items,
    soundDroppedCount: prepared.soundDroppedCount,
    validationDroppedCount: prepared.validationDroppedCount,
    validationReasons: prepared.validationReasons,
    omittedCandidateIds: prepared.omittedCandidateIds,
    remappedCount: prepared.remappedCount,
    contextWarnings: prepared.contextWarnings,
    pageContext: prepared.pageContext,
  }).page;
}

function resolveKeepBlocksNaturalLayout(pageOptions: TranslationOptions): {
  enabled?: boolean;
  locale?: string;
} {
  return {
    enabled: pageOptions.naturalTextLayout,
    locale: pageOptions.targetLanguage,
  };
}

function buildEmptyItemsResult(
  page: MangaPage,
  pageOptions: TranslationOptions,
  result: TranslationResult,
): PageBuildResult {
  if (pageOptions.regionCropMode) {
    return {
      kind: "no-text",
      page: buildNoTextCompletedPage(page),
      warnings: [],
    };
  }
  if (isRequestNoTextDetected(result.requestBody)) {
    return {
      kind: "no-text",
      page: buildNoTextCompletedPage(page, {
        keepBlocks: Boolean(pageOptions.keepBlocksMode),
      }),
      warnings: [],
    };
  }
  const bboxError = new Error(
    tMain("translation.errors.bboxMissing", { page: page.name }),
  );
  Object.assign(bboxError, {
    outputDir: pageOptions.outputDir,
    outputPreview: summarizePreview(result.outputText),
  });
  throw bboxError;
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

function applyStrictRefineOptions(
  pageOptions: TranslationOptions,
  page: MangaPage,
  keepBlocks = false,
): void {
  if (!page.blocks.length) {
    return;
  }

  pageOptions.strictRefineMode = true;
  pageOptions.keepBlocksMode = keepBlocks || undefined;
  pageOptions.previousBlocksForPrompt = buildPreviousBlocksForPrompt(
    page,
    Array.isArray(pageOptions.ocrBboxHints) ? pageOptions.ocrBboxHints : [],
    { assignSequentialCandidateIds: keepBlocks },
  );

  pageOptions.temperature = Math.min(pageOptions.temperature, 0.1);
  pageOptions.topP = Math.min(pageOptions.topP, 0.85);
  pageOptions.topK = Math.min(pageOptions.topK, 32);
}
