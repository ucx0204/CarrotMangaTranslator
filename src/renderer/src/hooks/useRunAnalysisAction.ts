import { useCallback, type MutableRefObject } from "react";
import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { ChapterRunSelection } from "../lib/translationSelection";
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
  runTranslationFlow: TranslationActions["runTranslationFlow"];
  translationWorkflowDefault: UseTranslationActionsOptions["translationWorkflowDefault"];
  analysisScopeDefault: NonNullable<
    UseTranslationActionsOptions["analysisScopeDefault"]
  >;
  blockModeDefault: NonNullable<
    UseTranslationActionsOptions["blockModeDefault"]
  >;
};

type DirectAnalysisRequest = {
  runMode: RunAnalysisMode;
  pageId?: string;
  chapterId?: string;
  blockMode?: AnalysisBlockMode;
  collectPageContext?: boolean;
};

export function useRunAnalysisAction(
  dependencies: RunAnalysisDependencies,
): TranslationActions["runAnalysis"] {
  return useCallback(
    (runMode, pageId, chapterId, blockMode, collectPageContext) =>
      runDirectAnalysis(dependencies, {
        runMode,
        pageId,
        chapterId,
        blockMode,
        collectPageContext,
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
  if (shouldRunPreciseFlow(dependencies, request)) {
    return dependencies.runTranslationFlow({
      selection: [buildDirectSelection(chapterId, request)],
      workflowMode: "two-pass",
      analysisScope: dependencies.analysisScopeDefault,
      blockMode: request.blockMode ?? dependencies.blockModeDefault,
    });
  }
  return dependencies.executeAnalysisJob({
    ...request,
    chapterId: request.chapterId,
    collectPageContext:
      request.collectPageContext ??
      dependencies.translationWorkflowDefault === "cumulative",
  });
}

function shouldRunPreciseFlow(
  dependencies: RunAnalysisDependencies,
  request: DirectAnalysisRequest,
): boolean {
  return (
    request.collectPageContext === undefined &&
    dependencies.translationWorkflowDefault === "two-pass"
  );
}

function buildDirectSelection(
  chapterId: string,
  request: DirectAnalysisRequest,
): ChapterRunSelection {
  if (
    (request.runMode === "single-page" || request.runMode === "page-set") &&
    request.pageId
  ) {
    return { chapterId, mode: "page-set", pageIds: [request.pageId] };
  }
  return {
    chapterId,
    mode: request.runMode === "all" ? "all" : "pending",
  };
}
