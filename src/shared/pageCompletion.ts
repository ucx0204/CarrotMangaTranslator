import type { PageWorkflowReceipt } from "./pageWorkflowReceipt";

import type {
  PageAnalysisStatus,
  TranslationCompletionReceipt,
} from "./libraryTypes";

export type PageCompletionState = {
  analysisStatus: PageAnalysisStatus;
  blocks?: readonly unknown[];
  pageWorkflow?: Pick<PageWorkflowReceipt, "steps" | "stages">;
  translationCompletion?: Pick<TranslationCompletionReceipt, "status"> &
    Partial<Pick<TranslationCompletionReceipt, "workflow" | "erasedBlockIds">>;
};

/**
 * A page is fully complete only after translation and any required downstream
 * completion workflow have both finished.
 */
export function isPageFullyCompleted(page: PageCompletionState): boolean {
  const workflow = page.pageWorkflow;
  if (
    workflow?.stages?.some((stage) => {
      const status = workflow.steps[stage]?.status;
      return status !== "completed" && status !== "empty";
    })
  )
    return false;
  return (
    (page.analysisStatus === "completed" ||
      isCompletedEmptyTranslation(page)) &&
    (!page.translationCompletion ||
      page.translationCompletion.status === "completed")
  );
}

/** Older workflow runs left successfully processed, block-free pages idle. */
function isCompletedEmptyTranslation(page: PageCompletionState): boolean {
  return (
    page.analysisStatus === "idle" &&
    page.blocks?.length === 0 &&
    page.pageWorkflow?.steps.translate?.status === "empty" &&
    !Object.values(page.pageWorkflow.steps).some(
      (step) => step?.status === "failed",
    )
  );
}
