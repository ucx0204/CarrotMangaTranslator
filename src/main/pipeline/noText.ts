import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationOptions } from "../appSettings";
import type { RequestSummary, TranslationResult } from "./types";

export function isOcrResultNoTextDetected(
  result: TranslationOptions["ocrBboxResult"] | null,
): boolean {
  return (
    result?.noTextDetected === true &&
    result.hints?.length === 0 &&
    (result.textEvidenceCount ?? 0) === 0
  );
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

export function isCumulativeNoTextPage(
  options: Pick<
    TranslationOptions,
    "collectPageContext" | "ocrBboxResult" | "regionCropMode" | "keepBlocksMode"
  >,
  requestBody: TranslationResult["requestBody"],
): boolean {
  return (
    Boolean(options.collectPageContext) &&
    !options.regionCropMode &&
    !options.keepBlocksMode &&
    (options.ocrBboxResult
      ? isOcrResultNoTextDetected(options.ocrBboxResult)
      : isRequestNoTextDetected(requestBody))
  );
}

export function buildNoTextCompletedPage(
  page: MangaPage,
  options: { keepBlocks?: boolean } = {},
): MangaPage {
  return {
    ...page,
    blocks: options.keepBlocks ? page.blocks : [],
    blockOrder: options.keepBlocks ? page.blockOrder : undefined,
    analysisStatus: "completed",
    lastError: undefined,
    updatedAt: new Date().toISOString(),
  };
}
