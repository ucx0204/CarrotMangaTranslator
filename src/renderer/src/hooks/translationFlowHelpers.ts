import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type { TranslationCompletionWorkflow } from "../../../shared/libraryTypes";
import type { Dispatch, SetStateAction } from "react";
import type { JobFailureGuidance, JobState } from "../../../shared/jobTypes";
import type { TFunction } from "i18next";
import type { ChapterRunSelection } from "../lib/translationSelection";
import type { CumulativeContextDetail } from "../../../shared/settingsTypes";
import type { PageTimingSessionRef } from "../../../shared/pageProcessingTiming";

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
  cumulativeContextDetail?: CumulativeContextDetail;
  naturalTextLayout?: boolean;
  autoFontMatching?: boolean;
  fontSizeAutoFit?: boolean;
  completionWorkflow?: TranslationCompletionWorkflow;
  deferTerminalFailure?: boolean;
  onDeferredFailureGuidance?: (guidance: JobFailureGuidance) => void;
  timingSession?: PageTimingSessionRef;
};

export type ExecuteAnalysisJob = (
  args: ExecuteAnalysisArgs,
) => Promise<RunAnalysisOutcome>;

type FlowTerminalContext = {
  pushStatus: (line: string, chapterId?: string) => void;
  setJobState: Dispatch<SetStateAction<JobState>>;
  t: TFunction<"renderer">;
};

export function setFlowTerminal(
  context: FlowTerminalContext,
  status: "completed" | "partial" | "failed",
  progressText: string,
  detail?: string,
  _elapsedMs?: number,
  failureGuidance?: JobFailureGuidance,
): void {
  context.setJobState({
    id: `translation-flow-${status}`,
    kind: status === "partial" ? "inpainting" : "gemma-analysis",
    status,
    progressText,
    phase:
      status === "completed"
        ? "done"
        : status === "partial"
          ? "partial"
          : "failed",
    ...(detail ? { detail } : {}),
    ...(failureGuidance ? { failureGuidance } : {}),
  });
  if (status === "completed") {
    context.pushStatus(progressText);
  } else if (detail) {
    context.pushStatus(detail);
  }
}

/**
 * Translate a list of chapter selections in order, each with its own scope
 * (whole chapter, pending pages, or an explicit page subset). Stops on the
 * first cancellation or failure so later chapters cannot overtake incomplete
 * work. The aggregate is completed only when every attempted chapter completed.
 */
export async function runSelectionsSequentially(
  execute: ExecuteAnalysisJob,
  selections: ChapterRunSelection[],
  pushStatus: (line: string, chapterId?: string) => void,
  passLabel: string,
  blockMode?: AnalysisBlockMode,
  collectPageContext?: boolean,
  naturalTextLayout?: boolean,
  autoFontMatching?: boolean,
  fontSizeAutoFit?: boolean,
  t?: TFunction<"renderer">,
  completionWorkflow?: TranslationCompletionWorkflow,
  deferTerminalFailure?: boolean,
  onDeferredFailureGuidance?: (guidance: JobFailureGuidance) => void,
  cumulativeContextDetail?: CumulativeContextDetail,
  timingSession?: PageTimingSessionRef,
): Promise<RunAnalysisOutcome> {
  let anyCompleted = false;
  let anyPartial = false;
  let anyAttempted = false;
  for (let index = 0; index < selections.length; index += 1) {
    const selection = selections[index];
    pushChapterProgress(
      pushStatus,
      passLabel,
      index,
      selections.length,
      selection.chapterId,
      t,
    );
    const outcome = await execute({
      runMode: selection.mode,
      chapterId: selection.chapterId,
      pageIds: selection.mode === "page-set" ? selection.pageIds : undefined,
      blockMode,
      collectPageContext,
      ...(cumulativeContextDetail && cumulativeContextDetail !== "detailed"
        ? { cumulativeContextDetail }
        : {}),
      naturalTextLayout,
      autoFontMatching,
      fontSizeAutoFit,
      completionWorkflow,
      deferTerminalFailure,
      onDeferredFailureGuidance,
      timingSession,
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
  pushStatus: (line: string, chapterId?: string) => void,
  passLabel: string,
  index: number,
  total: number,
  chapterId?: string,
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
      : `${passLabel} ${index + 1}/${total}화`,
    chapterId,
  );
}

function getTerminalAnalysisOutcome(
  outcome: RunAnalysisOutcome,
): "cancelled" | "failed" | undefined {
  if (outcome === "cancelled" || outcome === "failed") return outcome;
  return undefined;
}
