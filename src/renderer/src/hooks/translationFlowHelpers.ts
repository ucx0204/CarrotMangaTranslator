import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type { TranslationCompletionWorkflow } from "../../../shared/libraryTypes";
import type { TFunction } from "i18next";
import type { ChapterRunSelection } from "../lib/translationSelection";

export type RunAnalysisOutcome =
  | "completed"
  | "partial"
  | "cancelled"
  | "failed"
  | "no-op";

type ExecuteAnalysisArgs = {
  runMode: "pending" | "all" | "single-page" | "page-set";
  chapterId?: string;
  pageId?: string;
  pageIds?: string[];
  blockMode?: AnalysisBlockMode;
  collectPageContext?: boolean;
  naturalTextLayout?: boolean;
  autoFontMatching?: boolean;
  completionWorkflow?: TranslationCompletionWorkflow;
  deferTerminalFailure?: boolean;
};

export type ExecuteAnalysisJob = (
  args: ExecuteAnalysisArgs,
) => Promise<RunAnalysisOutcome>;

/**
 * Translate a list of chapter selections in order, each with its own scope
 * (whole chapter, pending pages, or an explicit page subset). Stops on the
 * first cancellation or failure so later chapters cannot overtake incomplete
 * work. The aggregate is completed only when every attempted chapter completed.
 */
export async function runSelectionsSequentially(
  execute: ExecuteAnalysisJob,
  selections: ChapterRunSelection[],
  pushStatus: (line: string) => void,
  passLabel: string,
  blockMode?: AnalysisBlockMode,
  collectPageContext?: boolean,
  naturalTextLayout?: boolean,
  autoFontMatching?: boolean,
  t?: TFunction<"renderer">,
  completionWorkflow?: TranslationCompletionWorkflow,
  deferTerminalFailure?: boolean,
): Promise<RunAnalysisOutcome> {
  let anyCompleted = false;
  let anyPartial = false;
  let anyAttempted = false;
  for (let index = 0; index < selections.length; index += 1) {
    pushChapterProgress(pushStatus, passLabel, index, selections.length, t);
    const selection = selections[index];
    const outcome = await execute({
      runMode: selection.mode,
      chapterId: selection.chapterId,
      pageIds: selection.mode === "page-set" ? selection.pageIds : undefined,
      blockMode,
      collectPageContext,
      naturalTextLayout,
      autoFontMatching,
      completionWorkflow,
      deferTerminalFailure,
    });
    const terminalOutcome = getTerminalAnalysisOutcome(outcome);
    if (terminalOutcome) return terminalOutcome;
    anyAttempted ||= outcome !== "no-op";
    anyCompleted ||= outcome === "completed";
    anyPartial ||= outcome === "partial";
  }
  if (anyPartial) {
    return "partial";
  }
  if (anyCompleted) {
    return "completed";
  }
  return anyAttempted ? "failed" : "no-op";
}

function pushChapterProgress(
  pushStatus: (line: string) => void,
  passLabel: string,
  index: number,
  total: number,
  t?: TFunction<"renderer">,
): void {
  if (total <= 1) return;
  pushStatus(
    t
      ? t("translation.flow.chapterProgress", {
          pass: passLabel,
          current: index + 1,
          total,
        })
      : `${passLabel} 번역 ${index + 1}/${total}화`,
  );
}

function getTerminalAnalysisOutcome(
  outcome: RunAnalysisOutcome,
): "cancelled" | "failed" | undefined {
  if (outcome === "cancelled" || outcome === "failed") return outcome;
  return undefined;
}
