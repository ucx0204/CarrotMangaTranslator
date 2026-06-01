import type { MangaPage } from "../../shared/types";
import type { OcrBboxResult, RequestSummary, TranslationResult } from "./types";

export function isOcrResultNoTextDetected(result: OcrBboxResult | null | undefined): boolean {
  return Boolean(result?.noTextDetected);
}

export function isRequestNoTextDetected(requestBody: TranslationResult["requestBody"]): boolean {
  return Boolean(requestBody && typeof requestBody === "object" && (requestBody as RequestSummary).noTextDetected);
}

export function buildNoTextCompletedPage(page: MangaPage): MangaPage {
  return {
    ...page,
    blocks: [],
    analysisStatus: "completed",
    lastError: undefined,
    updatedAt: new Date().toISOString()
  };
}
