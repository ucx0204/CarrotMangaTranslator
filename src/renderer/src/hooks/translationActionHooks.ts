import { useCallback, useRef, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { BBox } from "../../../shared/textTypes";
import { isUsableRegionBbox } from "../../../shared/region";
import { mangaGateway } from "../api/mangaGateway";
import { formatErrorMessage } from "../lib/appHelpers";
import { markChapterPagesRunning } from "../lib/chapterSync";
import { toast } from "../lib/toastStore";
import type { ChapterRunSelection } from "../lib/translationSelection";
import {
  runSelectionsSequentially,
  type ExecuteAnalysisJob,
  type RunAnalysisOutcome,
} from "./translationFlowHelpers";
import type {
  RunAnalysisMode,
  TranslationActions,
  TranslationFlowOptions,
  UseTranslationActionsOptions,
} from "./translationActionTypes";
import {
  failAnalysisJob,
  handleTranslateRegionResult,
  makeStartAnalysisRequest,
  mergeTranslatedRegionResult,
  refreshLibraryWithWarning,
  regionTranslationStartingState,
  reportRefreshLibraryFailure,
  resolveStartOutcome,
  runSecondTranslationPass,
  runWorkContextAnalysis,
  startingJobState,
} from "./translationActionUtils";
import { useRunAnalysisAction } from "./useRunAnalysisAction";

type FlowActiveRef = MutableRefObject<boolean>;
export { reportRefreshLibraryFailure };

export function useTranslationActionsImpl(
  options: UseTranslationActionsOptions,
): TranslationActions {
  const flowActiveRef = useRef(false);
  const executeAnalysisJob = useExecuteAnalysisJob(options);
  const runTranslationFlow = useRunTranslationFlowAction({
    ...options,
    executeAnalysisJob,
    flowActiveRef,
  });
  const runAnalysis = useRunAnalysisAction({
    currentChapter: options.currentChapter,
    executeAnalysisJob,
    flowActiveRef,
    jobActive: options.jobActive,
    runTranslationFlow,
    translationWorkflowDefault:
      options.translationWorkflowDefault ?? "cumulative",
    analysisScopeDefault: options.analysisScopeDefault ?? "missing",
    blockModeDefault: options.blockModeDefault ?? "auto",
  });
  const translateSelectedRegion = useTranslateSelectedRegionAction(options);

  return { runAnalysis, runTranslationFlow, translateSelectedRegion };
}

function useExecuteAnalysisJob({
  beforeTranslate,
  clearStatusLines,
  currentChapter,
  currentChapterRef,
  mergeLiveChapter,
  pushStatus,
  refreshLibrary,
  saveNow,
  setCurrentChapter,
  setJobState,
}: UseTranslationActionsOptions): ExecuteAnalysisJob {
  const { t } = useTranslation("renderer");
  return useCallback<ExecuteAnalysisJob>(
    async (job) => {
      const openChapterId = currentChapter?.id;
      const targetChapterId = job.chapterId ?? openChapterId;
      if (!targetChapterId) {
        return "no-op";
      }
      const isOpenChapter = targetChapterId === openChapterId;
      try {
        if (isOpenChapter) {
          await saveNow();
        }
        await beforeTranslate?.();
        clearStatusLines();
        setJobState(startingJobState(t));
        markOpenChapterRunning({
          currentChapter: isOpenChapter ? currentChapter : null,
          currentChapterRef,
          pageId: job.pageId,
          pageIds: job.pageIds,
          runMode: job.runMode,
          setCurrentChapter,
        });

        const result = await mangaGateway.startAnalysis(
          makeStartAnalysisRequest(
            targetChapterId,
            {
              runMode: job.runMode,
              pageId: job.pageId,
              pageIds: job.pageIds,
              blockMode: job.blockMode,
              collectPageContext: job.collectPageContext,
            },
            t,
          ),
        );
        if (result.chapter && result.chapter.id === openChapterId) {
          mergeLiveChapter(result.chapter);
        }
        await refreshLibraryWithWarning(refreshLibrary, pushStatus, t);
        return resolveStartOutcome(result, setJobState, pushStatus, t);
      } catch (error) {
        console.error(error);
        failAnalysisJob(
          setJobState,
          pushStatus,
          t("translation.errors.jobFailedTitle"),
          formatErrorMessage(error, t("translation.errors.startFailed")),
        );
        return "failed";
      }
    },
    [
      clearStatusLines,
      beforeTranslate,
      currentChapter,
      currentChapterRef,
      mergeLiveChapter,
      pushStatus,
      refreshLibrary,
      saveNow,
      setCurrentChapter,
      setJobState,
      t,
    ],
  );
}

function markOpenChapterRunning({
  currentChapter,
  currentChapterRef,
  pageId,
  pageIds,
  runMode,
  setCurrentChapter,
}: {
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  pageId?: string;
  pageIds?: string[];
  runMode: RunAnalysisMode;
  setCurrentChapter: UseTranslationActionsOptions["setCurrentChapter"];
}): void {
  if (!currentChapter) {
    return;
  }
  const optimisticChapter = markChapterPagesRunning(
    currentChapter,
    runMode,
    pageId,
    pageIds,
  );
  currentChapterRef.current = optimisticChapter;
  setCurrentChapter(optimisticChapter);
}

function useRunTranslationFlowAction({
  currentChapter,
  executeAnalysisJob,
  flowActiveRef,
  jobActive,
  pushStatus,
  refreshLibrary,
  saveNow,
  setFlowActive,
  setJobState,
}: UseTranslationActionsOptions & {
  executeAnalysisJob: ExecuteAnalysisJob;
  flowActiveRef: FlowActiveRef;
}): TranslationActions["runTranslationFlow"] {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (options: TranslationFlowOptions): Promise<RunAnalysisOutcome> => {
      if (!currentChapter || jobActive || flowActiveRef.current) {
        return "no-op";
      }
      if (options.selection.length === 0) {
        return "no-op";
      }
      flowActiveRef.current = true;
      setFlowActive(true);
      try {
        await saveNow();
        return await runTranslationFlowPasses({
          chapterId: currentChapter.id,
          selection: options.selection,
          executeAnalysisJob,
          options,
          pushStatus,
          refreshLibrary,
          setJobState,
          t,
        });
      } finally {
        flowActiveRef.current = false;
        setFlowActive(false);
      }
    },
    [
      currentChapter,
      executeAnalysisJob,
      flowActiveRef,
      jobActive,
      pushStatus,
      refreshLibrary,
      saveNow,
      setFlowActive,
      setJobState,
      t,
    ],
  );
}

async function runTranslationFlowPasses({
  chapterId,
  selection,
  executeAnalysisJob,
  options,
  pushStatus,
  refreshLibrary,
  setJobState,
  t,
}: {
  chapterId: string;
  selection: ChapterRunSelection[];
  executeAnalysisJob: ExecuteAnalysisJob;
  options: TranslationFlowOptions;
  pushStatus: UseTranslationActionsOptions["pushStatus"];
  refreshLibrary: UseTranslationActionsOptions["refreshLibrary"];
  setJobState: UseTranslationActionsOptions["setJobState"];
  t: TFunction<"renderer">;
}): Promise<RunAnalysisOutcome> {
  const pass1 = await runSelectionsSequentially(
    executeAnalysisJob,
    selection,
    pushStatus,
    t("translation.flow.firstPass"),
    options.blockMode,
    options.workflowMode === "cumulative",
    t,
  );
  if (pass1 !== "completed") {
    return pass1;
  }
  if (options.workflowMode !== "two-pass") {
    toast.success(t("translation.flow.completed"));
    return "completed";
  }
  const contextReady = await runWorkContextAnalysis({
    analysisScope: options.analysisScope,
    chapterId,
    pushStatus,
    refreshLibrary,
    setJobState,
    t,
  });
  if (!contextReady) {
    return "failed";
  }
  return runSecondTranslationPass(
    executeAnalysisJob,
    selection,
    pushStatus,
    options.blockMode,
    t,
  );
}

function useTranslateSelectedRegionAction({
  beforeTranslate,
  clearStatusLines,
  currentChapter,
  currentChapterRef,
  jobActive,
  mergeLiveChapter,
  pushStatus,
  refreshLibrary,
  saveNow,
  selectedPage,
  setJobState,
  setSelectedBlockId,
  syncSavedPageVersion,
}: UseTranslationActionsOptions): TranslationActions["translateSelectedRegion"] {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (bbox: BBox) => {
      if (!currentChapter || !selectedPage || jobActive) {
        return;
      }
      if (!isUsableRegionBbox(bbox, 10)) {
        return void pushStatus(t("regionTranslation.tooSmall"));
      }

      try {
        await saveNow();
        clearStatusLines();
        setJobState(regionTranslationStartingState(t));
        await beforeTranslate?.();
        const result = await mangaGateway.translateRegion({
          chapterId: currentChapter.id,
          pageId: selectedPage.id,
          bbox,
        });
        mergeTranslatedRegionResult(result, {
          currentChapterRef,
          mergeLiveChapter,
          selectedPageId: selectedPage.id,
          syncSavedPageVersion,
        });
        await refreshLibraryWithWarning(refreshLibrary, pushStatus, t);
        handleTranslateRegionResult(
          result,
          {
            pushStatus,
            setJobState,
            setSelectedBlockId,
          },
          t,
        );
      } catch (error) {
        console.error(error);
        failAnalysisJob(
          setJobState,
          pushStatus,
          t("regionTranslation.failedTitle"),
          formatErrorMessage(error, t("regionTranslation.startFailed")),
        );
      }
    },
    [
      beforeTranslate,
      clearStatusLines,
      currentChapter,
      currentChapterRef,
      jobActive,
      mergeLiveChapter,
      pushStatus,
      refreshLibrary,
      saveNow,
      selectedPage,
      setJobState,
      setSelectedBlockId,
      syncSavedPageVersion,
      t,
    ],
  );
}
