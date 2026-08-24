import { useCallback, type MutableRefObject } from "react";
import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
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
  autoFontMatchingDefault: boolean;
  naturalTextLayoutDefault: boolean;
  fontSizeAutoFitDefault: boolean;
};

type DirectAnalysisRequest = {
  runMode: RunAnalysisMode;
  pageId?: string;
  chapterId?: string;
  blockMode?: AnalysisBlockMode;
  collectPageContext?: boolean;
  naturalTextLayout?: boolean;
  autoFontMatching?: boolean;
  fontSizeAutoFit?: boolean;
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
      fontSizeAutoFit,
    ) =>
      runDirectAnalysis(dependencies, {
        runMode,
        pageId,
        chapterId,
        blockMode,
        collectPageContext,
        naturalTextLayout,
        autoFontMatching,
        fontSizeAutoFit,
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
  return dependencies.executeAnalysisJob({
    ...request,
    chapterId: request.chapterId,
    collectPageContext:
      request.collectPageContext ??
      dependencies.translationWorkflowDefault === "cumulative",
    naturalTextLayout:
      request.naturalTextLayout ?? dependencies.naturalTextLayoutDefault,
    autoFontMatching: resolveAutoFontMatching(dependencies, request),
    fontSizeAutoFit:
      request.fontSizeAutoFit ?? dependencies.fontSizeAutoFitDefault,
  });
}

function resolveAutoFontMatching(
  dependencies: RunAnalysisDependencies,
  request: DirectAnalysisRequest,
): boolean {
  return request.autoFontMatching ?? dependencies.autoFontMatchingDefault;
}
