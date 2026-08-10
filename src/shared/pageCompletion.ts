import type {
  PageAnalysisStatus,
  TranslationCompletionReceipt,
} from "./libraryTypes";

export type PageCompletionState = {
  analysisStatus: PageAnalysisStatus;
  translationCompletion?: Pick<TranslationCompletionReceipt, "status"> &
    Partial<Pick<TranslationCompletionReceipt, "workflow" | "erasedBlockIds">>;
};

/**
 * A page is fully complete only after translation and any required downstream
 * completion workflow have both finished.
 */
export function isPageFullyCompleted(page: PageCompletionState): boolean {
  return (
    page.analysisStatus === "completed" &&
    (!page.translationCompletion ||
      page.translationCompletion.status === "completed")
  );
}
