import { useCallback, type MutableRefObject } from "react";
import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { CumulativeContextDetail } from "../../../shared/settingsTypes";
import type {
  ExecuteAnalysisJob,
  RunAnalysisOutcome,
} from "./translationFlowHelpers";
import type {
  RunAnalysisMode,
  TranslationActions,
  UseTranslationActionsOptions,
} from "./translationActionTypes";

type RunAnalysisDependencies = {
  currentChapter: ChapterSnapshot | null;
  executeAnalysisJob: ExecuteAnalysisJob;
  flowActiveRef: MutableRefObject<boolean>;
  jobActive: boolean;
  translationWorkflowDefault: UseTranslationActionsOptions["translationWorkflowDefault"];
  cumulativeContextDetailDefault: CumulativeContextDetail;
  autoFontMatchingDefault: boolean;
  naturalTextLayoutDefault: boolean;
  aiFontSizeMatchingDefault: boolean;
};

type DirectAnalysisRequest = {
  runMode: RunAnalysisMode;
  pageId?: string;
  chapterId?: string;
  blockMode?: AnalysisBlockMode;
  collectPageContext?: boolean;
  naturalTextLayout?: boolean;
  autoFontMatching?: boolean;
  aiFontSizeMatching?: boolean;
  cumulativeContextDetail?: CumulativeContextDetail;
};

export function useRunAnalysisAction(
  dependencies: RunAnalysisDependencies,
): TranslationActions["runAnalysis"] {
  return useCallback(
    (
      runMode,
      pageId,
      chapterId,
      blockMode,
      collectPageContext,
      naturalTextLayout,
      autoFontMatching,
      aiFontSizeMatching,
      cumulativeContextDetail,
    ) =>
      runDirectAnalysis(dependencies, {
        runMode,
        pageId,
        chapterId,
        blockMode,
        collectPageContext,
        naturalTextLayout,
        autoFontMatching,
        aiFontSizeMatching,
        cumulativeContextDetail,
      }),
    [dependencies],
  );
}

async function runDirectAnalysis(
  dependencies: RunAnalysisDependencies,
  request: DirectAnalysisRequest,
): Promise<RunAnalysisOutcome> {
  if (dependencies.jobActive || dependencies.flowActiveRef.current) {
    return "no-op";
  }
  const chapterId = request.chapterId ?? dependencies.currentChapter?.id;
  if (!chapterId) return "no-op";
  const cumulativeContextDetail =
    request.cumulativeContextDetail ??
    dependencies.cumulativeContextDetailDefault;
  return dependencies.executeAnalysisJob({
    ...request,
    chapterId: request.chapterId,
    collectPageContext:
      request.collectPageContext ??
      dependencies.translationWorkflowDefault === "cumulative",
    naturalTextLayout:
      request.naturalTextLayout ?? dependencies.naturalTextLayoutDefault,
    autoFontMatching: resolveAutoFontMatching(dependencies, request),
    aiFontSizeMatching:
      request.aiFontSizeMatching ?? dependencies.aiFontSizeMatchingDefault,
    ...(cumulativeContextDetail !== "detailed"
      ? { cumulativeContextDetail }
      : {}),
  });
}

function resolveAutoFontMatching(
  dependencies: RunAnalysisDependencies,
  request: DirectAnalysisRequest,
): boolean {
  return request.autoFontMatching ?? dependencies.autoFontMatchingDefault;
}
