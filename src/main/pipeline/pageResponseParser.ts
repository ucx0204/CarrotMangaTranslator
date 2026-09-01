import type { MangaPage } from "../../shared/libraryTypes";
import {
  normalizeSoundEffectReview,
  SOUND_EFFECT_REVIEW_CONTRACT_VERSION,
} from "../../shared/soundEffectReview";
import type { TranslationOptions } from "../appSettings";
import {
  isJapaneseCumulativeNoTextRequest,
  isRequestNoTextDetected,
} from "./noText";
import { summarizePreview } from "./options";
import { extractPageContextResponse } from "./pageContextResponse";
import { tMain } from "./localization";
import type { TranslationRuntimePort } from "./translationRuntimePort";
import type {
  OcrBboxResult,
  OverlayItem,
  PageContextPayload,
  TranslationResult,
} from "./types";

export function attachEffectReviewToPage(
  page: MangaPage,
  pipeline: TranslationOptions["ocrPipeline"],
  result: OcrBboxResult | TranslationOptions["ocrBboxResult"] | undefined,
): MangaPage {
  if (pipeline !== "hayai") return page;
  return {
    ...page,
    soundEffectReview: mergeSoundEffectReview(page, result),
  };
}

function mergeSoundEffectReview(
  page: MangaPage,
  result: OcrBboxResult | TranslationOptions["ocrBboxResult"] | undefined,
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
    producer: "hayai-regions-v1",
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
  return {
    items: isJapaneseCumulativeNoTextRequest(pageOptions, result.requestBody)
      ? []
      : parseOverlayItems(
          runtime,
          result,
          page,
          pageOptions,
          extracted.overlayText,
        ),
    pageContext: extracted.pageContext,
    warnings: buildPageContextWarnings(page, pageOptions, extracted.status),
  };
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
  const preview = summarizePreview(result.outputText);
  const parseError = new Error(
    tMain("translation.errors.responseParse", {
      page: page.name,
      preview,
      cause: error instanceof Error ? error.message : String(error),
    }),
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
