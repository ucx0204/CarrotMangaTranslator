import { useCallback, useRef, type MutableRefObject } from "react";
import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
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
  refreshLibraryWithWarning,
  regionLiveMergeOptions,
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
    async ({ runMode, pageId, pageIds, chapterId, blockMode }) => {
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
          pageIds,
          runMode,
          setCurrentChapter,
        });

        const result = await mangaGateway.startAnalysis(
          makeStartAnalysisRequest(targetChapterId, {
            runMode,
            pageId,
            pageIds,
            blockMode,
          }),
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
      blockMode?: AnalysisBlockMode,
    ): Promise<RunAnalysisOutcome> => {
      if (jobActive || flowActiveRef.current) {
        return "no-op";
      }
      if (!chapterId && !currentChapter) {
        return "no-op";
      }
      return executeAnalysisJob({ runMode, pageId, chapterId, blockMode });
    },
    [currentChapter, executeAnalysisJob, flowActiveRef, jobActive],
  );
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
  return useCallback(
    async (options: TranslationFlowOptions): Promise<void> => {
      if (!currentChapter || jobActive || flowActiveRef.current) {
        return;
      }
      if (options.selection.length === 0) {
        return;
      }
      flowActiveRef.current = true;
      setFlowActive(true);
      try {
        await saveNow();
        await runTranslationFlowPasses({
          chapterId: currentChapter.id,
          selection: options.selection,
          executeAnalysisJob,
          options,
          pushStatus,
          refreshLibrary,
          setJobState,
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
}: {
  chapterId: string;
  selection: ChapterRunSelection[];
  executeAnalysisJob: ExecuteAnalysisJob;
  options: TranslationFlowOptions;
  pushStatus: UseTranslationActionsOptions["pushStatus"];
  refreshLibrary: UseTranslationActionsOptions["refreshLibrary"];
  setJobState: UseTranslationActionsOptions["setJobState"];
}): Promise<void> {
  const pass1 = await runSelectionsSequentially(
    executeAnalysisJob,
    selection,
    pushStatus,
    "1차",
    options.blockMode,
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
    chapterId,
    pushStatus,
    refreshLibrary,
    setJobState,
  });
  if (!contextReady) {
    return;
  }
  await runSecondTranslationPass(
    executeAnalysisJob,
    selection,
    pushStatus,
    options.blockMode,
  );
}

function useTranslateSelectedRegionAction({
  beforeTranslateRegion,
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
          mergeLiveChapter(result.chapter, regionLiveMergeOptions(result));
          if (
            result.status === "completed" &&
            currentChapterRef.current?.id === result.chapter.id
          ) {
            // 작업 중 편집으로 페이지가 dirty면 버전 동기화 효과가 이 페이지를
            // 건너뛰므로, append된 디스크 상태를 저장 기준선으로 직접 반영해
            // 다음 자동 저장이 충돌하지 않게 한다.
            syncSavedPageVersion(
              result.chapter,
              result.pageId ?? selectedPage.id,
            );
          }
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
    ],
  );
}
