import type { MangaPage } from "../../shared/libraryTypes";
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
  OverlayItem,
  PageContextPayload,
  TranslationResult,
} from "./types";

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
