import type { MangaPage } from "../../shared/libraryTypes";
import {
  normalizeSoundEffectReview,
  SOUND_EFFECT_REVIEW_CONTRACT_VERSION,
} from "../../shared/soundEffectReview";
import type { TranslationOptions } from "../appSettings";
import { isCumulativeNoTextPage, isRequestNoTextDetected } from "./noText";
import { extractPageContextResponse } from "./pageContextResponse";
import { tMain } from "./localization";
import type { TranslationRuntimePort } from "./translationRuntimePort";
import type {
  OcrBboxResult,
  OverlayItem,
  PageContextPayload,
  RequestSummary,
  TranslationResult,
} from "./types";

export function attachEffectReviewToPage(
  page: MangaPage,
  pipeline: TranslationOptions["ocrPipeline"],
  result: OcrBboxResult | TranslationOptions["ocrBboxResult"] | undefined,
): MangaPage {
  if (pipeline !== "hayai" && pipeline !== "hunyuan") return page;
  return {
    ...page,
    soundEffectReview: mergeSoundEffectReview(page, result, pipeline),
  };
}

function mergeSoundEffectReview(
  page: MangaPage,
  result: OcrBboxResult | TranslationOptions["ocrBboxResult"] | undefined,
  pipeline: "hayai" | "hunyuan",
): MangaPage["soundEffectReview"] {
  const history = resolveEffectReviewHistory(page.soundEffectReview);
  const regions = mergeEffectReviewRegions(
    history.regions,
    result?.effectReviewRegions ?? [],
  );
  if (
    !hasEffectReviewHistory(
      regions,
      history.manualRegions,
      history.resolvedRegions,
      history.dismissedRegionIds,
    )
  ) {
    return undefined;
  }
  return {
    contractVersion: SOUND_EFFECT_REVIEW_CONTRACT_VERSION,
    producer:
      pipeline === "hunyuan" ? "hunyuan-regions-v1" : "hayai-regions-v1",
    regions,
    regionOverrides: history.regionOverrides,
    manualRegions: history.manualRegions,
    resolvedRegions: history.resolvedRegions,
    ...(history.dismissedRegionIds.length > 0
      ? { dismissedRegionIds: history.dismissedRegionIds }
      : {}),
  };
}

function resolveEffectReviewHistory(review: MangaPage["soundEffectReview"]) {
  if (!review) {
    return {
      dismissedRegionIds: [] as string[],
      manualRegions: [],
      regionOverrides: [],
      regions: [],
      resolvedRegions: [],
    };
  }
  const normalized = normalizeSoundEffectReview(review);
  return {
    dismissedRegionIds: [...new Set(normalized.dismissedRegionIds ?? [])],
    manualRegions: normalized.manualRegions,
    regionOverrides: normalized.regionOverrides,
    regions: normalized.regions,
    resolvedRegions: normalized.resolvedRegions,
  };
}

function mergeEffectReviewRegions(
  previous: NonNullable<MangaPage["soundEffectReview"]>["regions"],
  detected: NonNullable<OcrBboxResult["effectReviewRegions"]>,
) {
  const byId = new Map(previous.map((region) => [region.id, region]));
  for (const region of detected) byId.set(region.id, region);
  return [...byId.values()];
}

function hasEffectReviewHistory(
  regions: readonly unknown[],
  manualRegions: readonly unknown[],
  resolvedRegions: readonly unknown[],
  dismissedRegionIds: readonly string[],
): boolean {
  return (
    regions.length > 0 ||
    manualRegions.length > 0 ||
    resolvedRegions.length > 0 ||
    dismissedRegionIds.length > 0
  );
}

export function parsePageResponse({
  runtime,
  result,
  page,
  pageOptions,
}: {
  runtime: TranslationRuntimePort;
  result: TranslationResult;
  page: MangaPage;
  pageOptions: TranslationOptions;
}): {
  items: OverlayItem[];
  pageContext?: PageContextPayload;
  warnings: string[];
} {
  const extracted = extractPageContextResponse(result.outputText);
  if (isCumulativeNoTextPage(pageOptions, result.requestBody)) {
    return {
      items: [],
      pageContext: extracted.pageContext && {
        visualSummary: extracted.pageContext.visualSummary,
        glossary: [],
        characters: [],
      },
      warnings: buildPageContextWarnings(page, pageOptions, extracted.status),
    };
  }
  const contextOnlyKeepBlocks =
    pageOptions.keepBlocksMode &&
    pageOptions.collectPageContext &&
    extracted.status === "parsed" &&
    !extracted.overlayText.trim();
  const parsedItems = contextOnlyKeepBlocks
    ? []
    : parseOverlayItems(
        runtime,
        result,
        page,
        pageOptions,
        extracted.overlayText,
      );
  return {
    items: markFixedBlockFallbacksForReview(parsedItems, result.requestBody),
    pageContext: extracted.pageContext,
    warnings: buildPageContextWarnings(page, pageOptions, extracted.status),
  };
}

function markFixedBlockFallbacksForReview(
  items: OverlayItem[],
  requestBody: unknown,
): OverlayItem[] {
  if (!requestBody || typeof requestBody !== "object") return items;
  const summary = requestBody as RequestSummary;
  const reviewIds = new Set(summary.fixedBlockNeedsReviewIds ?? []);
  if (reviewIds.size === 0) return items;
  const reviewedMemberships = new Set(
    (summary.fixedBlockIds ?? []).flatMap((blockId, index) => {
      if (!reviewIds.has(blockId)) return [];
      const candidateIds = summary.fixedBlockCandidateIds?.[index];
      const membership = fixedBlockMembershipKey(candidateIds);
      return membership ? [membership] : [];
    }),
  );
  if (reviewedMemberships.size === 0) return items;
  return items.map((item) =>
    reviewedMemberships.has(fixedBlockMembershipKey(item.candidateIds))
      ? { ...item, reviewStatus: "needs_review" }
      : item,
  );
}

function fixedBlockMembershipKey(candidateIds: number[] | undefined): string {
  return candidateIds?.length ? candidateIds.join(",") : "";
}

function parseOverlayItems(
  runtime: TranslationRuntimePort,
  result: TranslationResult,
  page: MangaPage,
  pageOptions: TranslationOptions,
  overlayText: string,
): OverlayItem[] {
  try {
    if (!overlayText.trim() && isRequestNoTextDetected(result.requestBody)) {
      return [];
    }
    if (pageOptions.regionCropMode) {
      return runtime.normalizeRegionSingleItem(
        runtime.parseRegionSingleItem(overlayText),
      );
    }
    return runtime.normalizeItems(runtime.parseJsonLenient(overlayText));
  } catch (error) {
    throw buildParseError(page, pageOptions, result, error);
  }
}

function buildPageContextWarnings(
  page: MangaPage,
  pageOptions: TranslationOptions,
  status: "missing" | "invalid" | "parsed",
): string[] {
  if (!pageOptions.collectPageContext || status === "parsed") {
    return [];
  }
  return [
    status === "missing"
      ? `${page.name}: 페이지 컨텍스트가 없어 번역 결과만 저장했습니다.`
      : `${page.name}: 페이지 컨텍스트 JSON을 읽지 못해 번역 결과만 저장했습니다.`,
  ];
}

function buildParseError(
  page: MangaPage,
  pageOptions: TranslationOptions,
  result: TranslationResult,
  error: unknown,
): Error {
  const responseShape = describeResponseShape(result.outputText);
  const safeCause = safeParseCause(error);
  const parseError = new Error(
    tMain("translation.errors.responseParse", {
      page: page.id,
      shape: responseShape,
      cause: safeCause.message,
    }),
  ) as Error & { cause?: unknown };
  parseError.cause = safeCause;
  Object.assign(parseError, {
    responseShape,
    outputLength: result.outputText.length,
    outputDir: pageOptions.outputDir,
    responseFormat: pageOptions.regionCropMode
      ? "region-single-item"
      : "structured-overlay",
  });
  return parseError;
}

function safeParseCause(error: unknown, depth = 0): Error {
  const safeMessages = new Set([
    "Region response contract violation: item must be an object or null.",
    "Region response contract violation: item object is incomplete.",
    "Region response contract violation: top-level object required.",
    "Region response contract violation: exactly one item key required.",
    'Region response contract violation: expected { "item": {...} } or { "item": null }.',
    "Region response contract violation: JSON object missing.",
    "Failed to parse model output as JSON.",
  ]);
  const safe = new Error(
    error instanceof Error && safeMessages.has(error.message)
      ? error.message
      : "Structured response validation failed",
  );
  if (error instanceof Error) {
    safe.name = error instanceof SyntaxError ? "SyntaxError" : "Error";
    safe.stack = `${safe.name}: ${safe.message}\n${
      error.stack
        ?.split("\n")
        .filter((line) => /^\s+at /.test(line))
        .join("\n") ?? ""
    }`;
    if (error.cause !== undefined && depth < 3)
      safe.cause = safeParseCause(error.cause, depth + 1);
  }
  return safe;
}

function describeResponseShape(text: string): string {
  const kind = (value: unknown): string =>
    value === null
      ? "null"
      : Array.isArray(value)
        ? `array(${value.length})`
        : typeof value;
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return `object; item=${kind(record.item)}; items=${kind(record.items)}; length=${text.length}`;
    }
    return `${kind(value)}; length=${text.length}`;
  } catch (_error) {
    return `non-JSON; length=${text.length}`;
  }
}
