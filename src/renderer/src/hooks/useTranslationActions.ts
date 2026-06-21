import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type {
  BBox,
  ChapterSnapshot,
  JobState,
  LibraryIndex,
  MangaPage,
  StartAnalysisRequest,
  StartAnalysisResult,
  WorkContextAnalysisScope,
} from "../../../shared/types";
import { isUsableRegionBbox } from "../../../shared/region";
import { formatErrorMessage } from "../lib/appHelpers";
import { markChapterPagesRunning } from "../lib/chapterSync";
import { summarizeWarnings } from "../lib/jobProgress";
import { mangaGateway } from "../api/mangaGateway";
import { toast } from "../lib/toastStore";
import {
  enumerateWorkChapterIds,
  runChaptersSequentially,
  type ExecuteAnalysisJob,
  type RunAnalysisOutcome,
} from "./translationFlowHelpers";

type RunAnalysisMode = "pending" | "all" | "single-page";

export type TranslationFlowOptions = {
  scope: "pending" | "all";
  target: "chapter" | "work";
  twoPass: boolean;
  analysisScope: WorkContextAnalysisScope;
};

type UseTranslationActionsOptions = {
  clearStatusLines: () => void;
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  jobActive: boolean;
  library: LibraryIndex;
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
  beforeTranslateRegion?: () => Promise<void>;
  pushStatus: (line: string) => void;
  refreshLibrary: () => Promise<void>;
  saveNow: () => Promise<void>;
  selectedPage: MangaPage | null;
  setCurrentChapter: Dispatch<SetStateAction<ChapterSnapshot | null>>;
  setFlowActive: (active: boolean) => void;
  setJobState: Dispatch<SetStateAction<JobState>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
};

function failAnalysisJob(
  setJobState: Dispatch<SetStateAction<JobState>>,
  pushStatus: (line: string) => void,
  progressText: string,
  message: string,
): void {
  setJobState({
    id: "failed-analysis",
    kind: "gemma-analysis",
    status: "failed",
    progressText,
    phase: "failed",
    detail: message,
  });
  pushStatus(message);
}

function makeStartAnalysisRequest(
  chapterId: string,
  runMode: RunAnalysisMode,
  pageId?: string,
): StartAnalysisRequest {
  if (runMode === "single-page") {
    if (!pageId) {
      throw new Error("다시 번역할 페이지를 찾지 못했습니다.");
    }
    return { chapterId, runMode, pageId };
  }
  return { chapterId, runMode };
}

function startingJobState(): JobState {
  return {
    id: "pending",
    kind: "gemma-analysis",
    status: "starting",
    progressText: "모델 준비 중",
    phase: "booting",
  };
}

function resolveStartOutcome(
  result: StartAnalysisResult,
  setJobState: Dispatch<SetStateAction<JobState>>,
  pushStatus: (line: string) => void,
): RunAnalysisOutcome {
  if (result.status === "completed") {
    const warningSummary = summarizeWarnings(result.warnings ?? []);
    if (warningSummary) {
      pushStatus(warningSummary);
    }
    return "completed";
  }
  if (result.status === "cancelled") {
    return "cancelled";
  }
  failAnalysisJob(
    setJobState,
    pushStatus,
    "번역 작업 실패",
    result.error ?? "번역 작업에 실패했습니다.",
  );
  return "failed";
}

export function useTranslationActions({
  beforeTranslateRegion,
  clearStatusLines,
  currentChapter,
  currentChapterRef,
  jobActive,
  library,
  mergeLiveChapter,
  pushStatus,
  refreshLibrary,
  saveNow,
  selectedPage,
  setCurrentChapter,
  setFlowActive,
  setJobState,
  setSelectedBlockId,
}: UseTranslationActionsOptions): {
  runAnalysis: (
    runMode: RunAnalysisMode,
    pageId?: string,
    chapterId?: string,
  ) => Promise<RunAnalysisOutcome>;
  runTranslationFlow: (options: TranslationFlowOptions) => Promise<void>;
  translateSelectedRegion: (bbox: BBox) => Promise<void>;
} {
  const flowActiveRef = useRef(false);

  // Core job runner — no jobActive guard, so the flow can chain passes without
  // tripping its own re-entrancy check. Always invoked sequentially.
  const executeAnalysisJob = useCallback<ExecuteAnalysisJob>(
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
        if (isOpenChapter && currentChapter) {
          const optimisticChapter = markChapterPagesRunning(
            currentChapter,
            runMode,
            pageId,
          );
          currentChapterRef.current = optimisticChapter;
          setCurrentChapter(optimisticChapter);
        }

        const result = await mangaGateway.startAnalysis(
          makeStartAnalysisRequest(targetChapterId, runMode, pageId),
        );
        if (result.chapter && result.chapter.id === openChapterId) {
          mergeLiveChapter(result.chapter);
        }
        await refreshLibrary().catch((error) => {
          console.error(error);
          pushStatus(
            formatErrorMessage(error, "보관함 목록을 새로고침하지 못했습니다."),
          );
        });

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

  const runAnalysis = useCallback(
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
    [currentChapter, executeAnalysisJob, jobActive],
  );

  const runTranslationFlow = useCallback(
    async (options: TranslationFlowOptions): Promise<void> => {
      if (!currentChapter || jobActive || flowActiveRef.current) {
        return;
      }
      flowActiveRef.current = true;
      setFlowActive(true);
      try {
        await saveNow();
        const chapterIds =
          options.target === "work"
            ? enumerateWorkChapterIds(library, currentChapter.workId)
            : [currentChapter.id];
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

        setJobState({
          id: "flow-analysis",
          kind: "gemma-analysis",
          status: "running",
          progressText: "AI 용어/기억 분석 중",
          phase: "model_requesting",
          progressMode: "indeterminate",
        });
        try {
          await mangaGateway.analyzeWorkContext({
            chapterId: currentChapter.id,
            scope: options.analysisScope,
          });
          await refreshLibrary().catch(() => undefined);
        } catch (error) {
          console.error(error);
          setJobState({
            id: "flow-analysis-skipped",
            kind: "gemma-analysis",
            status: "completed",
            progressText: "1차 번역 완료 (AI 분석 건너뜀)",
            phase: "done",
          });
          toast.error("AI 용어/기억 분석에 실패해 1차 번역 결과만 유지합니다.");
          return;
        }

        const pass2 = await runChaptersSequentially(
          executeAnalysisJob,
          chapterIds,
          "all",
          pushStatus,
          "2차",
        );
        if (pass2 === "completed") {
          toast.success("2차 번역까지 완료했습니다.");
        }
      } finally {
        flowActiveRef.current = false;
        setFlowActive(false);
      }
    },
    [
      currentChapter,
      executeAnalysisJob,
      jobActive,
      library,
      pushStatus,
      refreshLibrary,
      saveNow,
      setFlowActive,
      setJobState,
    ],
  );

  const translateSelectedRegion = useCallback(
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
        setJobState({
          id: "pending",
          kind: "gemma-analysis",
          status: "starting",
          progressText: "선택 영역 번역 준비 중",
          phase: "booting",
          progressCurrent: 0,
          progressTotal: 1,
          pageIndex: 1,
          pageTotal: 1,
        });

        await beforeTranslateRegion?.();
        const result = await mangaGateway.translateRegion({
          chapterId: currentChapter.id,
          pageId: selectedPage.id,
          bbox,
        });
        if (result.chapter) {
          mergeLiveChapter(result.chapter);
        }
        await refreshLibrary().catch((error) => {
          console.error(error);
          pushStatus(
            formatErrorMessage(error, "보관함 목록을 새로고침하지 못했습니다."),
          );
        });

        if (result.status === "completed") {
          if (result.blockIds?.[0]) {
            setSelectedBlockId(result.blockIds[0]);
          }
          const warningSummary = summarizeWarnings(result.warnings ?? []);
          pushStatus(
            warningSummary ||
              `선택 영역에서 ${result.blockIds?.length ?? 0}개 블록을 만들었습니다.`,
          );
          return;
        }

        if (result.status === "failed") {
          failAnalysisJob(
            setJobState,
            pushStatus,
            "선택 영역 번역 실패",
            result.error ?? "선택 영역 번역에 실패했습니다.",
          );
        }
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

  return {
    runAnalysis,
    runTranslationFlow,
    translateSelectedRegion,
  };
}
