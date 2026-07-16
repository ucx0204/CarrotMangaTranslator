import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type { TFunction } from "i18next";
import type { ChapterRunSelection } from "../lib/translationSelection";

export type RunAnalysisOutcome = "completed" | "cancelled" | "failed" | "no-op";

type ExecuteAnalysisArgs = {
  runMode: "pending" | "all" | "single-page" | "page-set";
  chapterId?: string;
  pageId?: string;
  pageIds?: string[];
  blockMode?: AnalysisBlockMode;
  collectPageContext?: boolean;
};

export type ExecuteAnalysisJob = (
  args: ExecuteAnalysisArgs,
) => Promise<RunAnalysisOutcome>;

/**
 * Translate a list of chapter selections in order, each with its own scope
 * (whole chapter, pending pages, or an explicit page subset). Stops on
 * cancellation; tolerates an individual chapter failing. Returns "completed" if
 * at least one chapter finished, "failed" if all attempted chapters failed,
 * "cancelled" on cancel.
 */
export async function runSelectionsSequentially(
  execute: ExecuteAnalysisJob,
  selections: ChapterRunSelection[],
  pushStatus: (line: string) => void,
  passLabel: string,
  blockMode?: AnalysisBlockMode,
  collectPageContext?: boolean,
  t?: TFunction<"renderer">,
): Promise<RunAnalysisOutcome> {
  let anyCompleted = false;
  let anyAttempted = false;
  for (let index = 0; index < selections.length; index += 1) {
    if (selections.length > 1) {
      pushStatus(
        t
          ? t("translation.flow.chapterProgress", {
              pass: passLabel,
              current: index + 1,
              total: selections.length,
            })
          : `${passLabel} 번역 ${index + 1}/${selections.length}화`,
      );
    }
    const selection = selections[index];
    const outcome = await execute({
      runMode: selection.mode,
      chapterId: selection.chapterId,
      pageIds: selection.mode === "page-set" ? selection.pageIds : undefined,
      blockMode,
      collectPageContext,
    });
    if (outcome === "cancelled") {
      return "cancelled";
    }
    if (outcome !== "no-op") {
      anyAttempted = true;
    }
    if (outcome === "completed") {
      anyCompleted = true;
    }
  }
  if (anyCompleted) {
    return "completed";
  }
  return anyAttempted ? "failed" : "no-op";
}
