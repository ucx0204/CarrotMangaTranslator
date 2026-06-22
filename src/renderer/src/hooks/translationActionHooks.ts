import { useCallback, useRef, type MutableRefObject } from "react";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";
import type { BBox } from "../../../shared/textTypes";
import { isUsableRegionBbox } from "../../../shared/region";
import { mangaGateway } from "../api/mangaGateway";
import { formatErrorMessage } from "../lib/appHelpers";
import { markChapterPagesRunning } from "../lib/chapterSync";
import { toast } from "../lib/toastStore";
import {
  enumerateWorkChapterIds,
  runChaptersSequentially,
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
  refreshLibraryWithWarning,
  regionTranslationStartingState,
  reportRefreshLibraryFailure,
  resolveStartOutcome,
  runSecondTranslationPass,
  runWorkContextAnalysis,
  startingJobState,
} from "./translationActionUtils";

type FlowActiveRef = MutableRefObject<boolean>;
export { reportRefreshLibraryFailure };

export function useTranslationActionsImpl(
  options: UseTranslationActionsOptions,
): TranslationActions {
  const flowActiveRef = useRef(false);
  const executeAnalysisJob = useExecuteAnalysisJob(options);
  const runAnalysis = useRunAnalysisAction({
    currentChapter: options.currentChapter,
    executeAnalysisJob,
    flowActiveRef,
    jobActive: options.jobActive,
  });
  const runTranslationFlow = useRunTranslationFlowAction({
    ...options,
    executeAnalysisJob,
    flowActiveRef,
  });
  const translateSelectedRegion = useTranslateSelectedRegionAction(options);

  return { runAnalysis, runTranslationFlow, translateSelectedRegion };
}

function useExecuteAnalysisJob({
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
  return useCallback<ExecuteAnalysisJob>(
    async (runMode, pageId, chapterId) => {
      const openChapterId = currentChapter?.id;
      const targetChapterId = chapterId ?? openChapterId;
      if (!targetChapterId) {
        return "no-op";
      }
      const isOpenChapter = targetChapterId === openChapterId;
      try {
        if (isOpenChapter) {
          await saveNow();
        }
        clearStatusLines();
        setJobState(startingJobState());
        markOpenChapterRunning({
          currentChapter: isOpenChapter ? currentChapter : null,
          currentChapterRef,
          pageId,
          runMode,
          setCurrentChapter,
        });

        const result = await mangaGateway.startAnalysis(
          makeStartAnalysisRequest(targetChapterId, runMode, pageId),
        );
        if (result.chapter && result.chapter.id === openChapterId) {
          mergeLiveChapter(result.chapter);
        }
        await refreshLibraryWithWarning(refreshLibrary, pushStatus);
        return resolveStartOutcome(result, setJobState, pushStatus);
      } catch (error) {
        console.error(error);
        failAnalysisJob(
          setJobState,
          pushStatus,
          "번역 작업 실패",
          formatErrorMessage(error, "번역 작업을 시작하지 못했습니다."),
        );
        return "failed";
      }
    },
    [
      clearStatusLines,
      currentChapter,
      currentChapterRef,
      mergeLiveChapter,
      pushStatus,
      refreshLibrary,
      saveNow,
      setCurrentChapter,
      setJobState,
    ],
  );
}

function markOpenChapterRunning({
  currentChapter,
  currentChapterRef,
  pageId,
  runMode,
  setCurrentChapter,
}: {
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  pageId?: string;
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
  );
  currentChapterRef.current = optimisticChapter;
  setCurrentChapter(optimisticChapter);
}

function useRunAnalysisAction({
  currentChapter,
  executeAnalysisJob,
  flowActiveRef,
  jobActive,
}: {
  currentChapter: ChapterSnapshot | null;
  executeAnalysisJob: ExecuteAnalysisJob;
  flowActiveRef: FlowActiveRef;
  jobActive: boolean;
}): TranslationActions["runAnalysis"] {
  return useCallback(
    async (
      runMode: RunAnalysisMode,
      pageId?: string,
      chapterId?: string,
    ): Promise<RunAnalysisOutcome> => {
      if (jobActive || flowActiveRef.current) {
        return "no-op";
      }
      if (!chapterId && !currentChapter) {
        return "no-op";
      }
      return executeAnalysisJob(runMode, pageId, chapterId);
    },
    [currentChapter, executeAnalysisJob, flowActiveRef, jobActive],
  );
}

function useRunTranslationFlowAction({
  currentChapter,
  executeAnalysisJob,
  flowActiveRef,
  jobActive,
  library,
  pushStatus,
  refreshLibrary,
  saveNow,
  setFlowActive,
  setJobState,
}: UseTranslationActionsOptions & {
  executeAnalysisJob: ExecuteAnalysisJob;
  flowActiveRef: FlowActiveRef;
}): TranslationActions["runTranslationFlow"] {
  return useCallback(
    async (options: TranslationFlowOptions): Promise<void> => {
      if (!currentChapter || jobActive || flowActiveRef.current) {
        return;
      }
      flowActiveRef.current = true;
      setFlowActive(true);
      try {
        await saveNow();
        const chapterIds = resolveFlowChapterIds(
          options,
          currentChapter,
          library,
        );
        if (chapterIds.length === 0) {
          return;
        }
        const pass1 = await runChaptersSequentially(
          executeAnalysisJob,
          chapterIds,
          options.scope,
          pushStatus,
          "1차",
        );
        if (pass1 !== "completed") {
          return;
        }
        if (!options.twoPass) {
          toast.success("번역을 완료했습니다.");
          return;
        }
        const contextReady = await runWorkContextAnalysis({
          analysisScope: options.analysisScope,
          chapterId: currentChapter.id,
          pushStatus,
          refreshLibrary,
          setJobState,
        });
        if (!contextReady) {
          return;
        }
        await runSecondTranslationPass(
          executeAnalysisJob,
          chapterIds,
          pushStatus,
        );
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
      library,
      pushStatus,
      refreshLibrary,
      saveNow,
      setFlowActive,
      setJobState,
    ],
  );
}

function resolveFlowChapterIds(
  options: TranslationFlowOptions,
  chapter: ChapterSnapshot,
  library: LibraryIndex,
): string[] {
  return options.target === "work"
    ? enumerateWorkChapterIds(library, chapter.workId)
    : [chapter.id];
}

function useTranslateSelectedRegionAction({
  beforeTranslateRegion,
  clearStatusLines,
  currentChapter,
  jobActive,
  mergeLiveChapter,
  pushStatus,
  refreshLibrary,
  saveNow,
  selectedPage,
  setJobState,
  setSelectedBlockId,
}: UseTranslationActionsOptions): TranslationActions["translateSelectedRegion"] {
  return useCallback(
    async (bbox: BBox) => {
      if (!currentChapter || !selectedPage || jobActive) {
        return;
      }
      if (!isUsableRegionBbox(bbox, 10)) {
        pushStatus("선택 영역이 너무 작습니다.");
        return;
      }

      try {
        await saveNow();
        clearStatusLines();
        setJobState(regionTranslationStartingState());
        await beforeTranslateRegion?.();
        const result = await mangaGateway.translateRegion({
          chapterId: currentChapter.id,
          pageId: selectedPage.id,
          bbox,
        });
        if (result.chapter) {
          mergeLiveChapter(result.chapter);
        }
        await refreshLibraryWithWarning(refreshLibrary, pushStatus);
        handleTranslateRegionResult(result, {
          pushStatus,
          setJobState,
          setSelectedBlockId,
        });
      } catch (error) {
        console.error(error);
        failAnalysisJob(
          setJobState,
          pushStatus,
          "선택 영역 번역 실패",
          formatErrorMessage(error, "선택 영역 번역을 시작하지 못했습니다."),
        );
      }
    },
    [
      beforeTranslateRegion,
      clearStatusLines,
      currentChapter,
      jobActive,
      mergeLiveChapter,
      pushStatus,
      refreshLibrary,
      saveNow,
      selectedPage,
      setJobState,
      setSelectedBlockId,
    ],
  );
}
