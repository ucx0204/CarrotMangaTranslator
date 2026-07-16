import type { MangaPage } from "../../shared/libraryTypes";
import { isJapaneseLanguageCode } from "../../shared/translationLanguages";
import type { TranslationOptions } from "../appSettings";
import type { OcrBboxResult, RequestSummary, TranslationResult } from "./types";

export function isOcrResultNoTextDetected(
  result: OcrBboxResult | null | undefined,
): boolean {
  return Boolean(result?.noTextDetected);
}

export function isRequestNoTextDetected(
  requestBody: TranslationResult["requestBody"],
): boolean {
  return Boolean(
    requestBody &&
    typeof requestBody === "object" &&
    (requestBody as RequestSummary).noTextDetected,
  );
}

export function isJapaneseCumulativeNoTextRequest(
  options: Pick<TranslationOptions, "collectPageContext" | "sourceLanguage">,
  requestBody: TranslationResult["requestBody"],
): boolean {
  return (
    Boolean(options.collectPageContext) &&
    isJapaneseLanguageCode(options.sourceLanguage) &&
    isRequestNoTextDetected(requestBody)
  );
}

export function buildNoTextCompletedPage(
  page: MangaPage,
  options: { keepBlocks?: boolean } = {},
): MangaPage {
  return {
    ...page,
    blocks: options.keepBlocks ? page.blocks : [],
    analysisStatus: "completed",
    lastError: undefined,
    updatedAt: new Date().toISOString(),
  };
}
