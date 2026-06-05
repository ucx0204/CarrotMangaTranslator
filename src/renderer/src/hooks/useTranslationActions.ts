import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { BBox, ChapterSnapshot, JobState, MangaPage } from "../../../shared/types";
import { isUsableRegionBbox } from "../../../shared/region";
import { formatErrorMessage } from "../lib/appHelpers";
import { markChapterPagesRunning } from "../lib/chapterSync";
import { summarizeWarnings } from "../lib/jobProgress";

type RunAnalysisMode = "pending" | "all" | "single-page";

type UseTranslationActionsOptions = {
  clearStatusLines: () => void;
  currentChapter: ChapterSnapshot | null;
  jobActive: boolean;
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
  beforeTranslateRegion?: () => Promise<void>;
  pushStatus: (line: string) => void;
  refreshLibrary: () => Promise<void>;
  saveNow: () => Promise<void>;
  selectedPage: MangaPage | null;
  setCurrentChapter: Dispatch<SetStateAction<ChapterSnapshot | null>>;
  setJobState: Dispatch<SetStateAction<JobState>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
};

function failAnalysisJob(
  setJobState: Dispatch<SetStateAction<JobState>>,
  pushStatus: (line: string) => void,
  progressText: string,
  message: string
): void {
  setJobState({
    id: "failed-analysis",
    kind: "gemma-analysis",
    status: "failed",
    progressText,
    phase: "failed",
    detail: message
  });
  pushStatus(message);
}

export function useTranslationActions({
  clearStatusLines,
  currentChapter,
  jobActive,
  mergeLiveChapter,
  beforeTranslateRegion,
  pushStatus,
  refreshLibrary,
  saveNow,
  selectedPage,
  setCurrentChapter,
  setJobState,
  setSelectedBlockId
}: UseTranslationActionsOptions): {
  runAnalysis: (runMode: RunAnalysisMode, pageId?: string) => Promise<void>;
  translateSelectedRegion: (bbox: BBox) => Promise<void>;
} {
  const runAnalysis = useCallback(
    async (runMode: RunAnalysisMode, pageId?: string) => {
      if (!currentChapter || jobActive) {
        return;
      }

      try {
        await saveNow();
        clearStatusLines();
        setJobState({
          id: "pending",
          kind: "gemma-analysis",
          status: "starting",
          progressText: "모델 준비 중",
          phase: "booting"
        });
        setCurrentChapter((chapter) => (chapter ? markChapterPagesRunning(chapter, runMode, pageId) : chapter));

        const result = await window.mangaApi.startAnalysis({ chapterId: currentChapter.id, runMode, pageId });
        if (result.chapter) {
          mergeLiveChapter(result.chapter);
        }
        await refreshLibrary().catch((error) => {
          console.error(error);
          pushStatus(formatErrorMessage(error, "보관함 목록을 새로고침하지 못했습니다."));
        });

        if (result.status === "completed") {
          const warningSummary = summarizeWarnings(result.warnings ?? []);
          if (warningSummary) {
            pushStatus(warningSummary);
          }
          return;
        }

        if (result.status === "failed") {
          failAnalysisJob(setJobState, pushStatus, "번역 작업 실패", result.error ?? "번역 작업에 실패했습니다.");
        }
      } catch (error) {
        console.error(error);
        failAnalysisJob(setJobState, pushStatus, "번역 작업 실패", formatErrorMessage(error, "번역 작업을 시작하지 못했습니다."));
      }
    },
    [clearStatusLines, currentChapter, jobActive, mergeLiveChapter, pushStatus, refreshLibrary, saveNow, setCurrentChapter, setJobState]
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
          pageTotal: 1
        });

        await beforeTranslateRegion?.();
        const result = await window.mangaApi.translateRegion({
          chapterId: currentChapter.id,
          pageId: selectedPage.id,
          bbox
        });
        if (result.chapter) {
          mergeLiveChapter(result.chapter);
        }
        await refreshLibrary().catch((error) => {
          console.error(error);
          pushStatus(formatErrorMessage(error, "보관함 목록을 새로고침하지 못했습니다."));
        });

        if (result.status === "completed") {
          if (result.blockIds?.[0]) {
            setSelectedBlockId(result.blockIds[0]);
          }
          const warningSummary = summarizeWarnings(result.warnings ?? []);
          pushStatus(warningSummary || `선택 영역에서 ${result.blockIds?.length ?? 0}개 블록을 만들었습니다.`);
          return;
        }

        if (result.status === "failed") {
          failAnalysisJob(setJobState, pushStatus, "선택 영역 번역 실패", result.error ?? "선택 영역 번역에 실패했습니다.");
        }
      } catch (error) {
        console.error(error);
        failAnalysisJob(
          setJobState,
          pushStatus,
          "선택 영역 번역 실패",
          formatErrorMessage(error, "선택 영역 번역을 시작하지 못했습니다.")
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
      setSelectedBlockId
    ]
  );

  return {
    runAnalysis,
    translateSelectedRegion
  };
}
