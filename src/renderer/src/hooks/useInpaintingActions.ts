import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { ChapterSnapshot, InpaintingMaskStroke, JobState, MangaPage } from "../../../shared/types";
import type { RegionSelectionState } from "../lib/appHelpers";
import { formatErrorMessage } from "../lib/appHelpers";

type InpaintingScope = "page" | "chapter";

type UseInpaintingActionsOptions = {
  askConfirm: (title: string, message: string, detail?: string) => Promise<boolean>;
  clearPageImageCache: () => void;
  clearRetouchHistory: () => void;
  currentChapter: ChapterSnapshot | null;
  dirty: boolean;
  hideInpaintingGuide: boolean;
  jobActive: boolean;
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
  patternMaskStrokes: InpaintingMaskStroke[];
  pushStatus: (line: string) => void;
  refreshLibrary: () => Promise<void>;
  saveNow: () => Promise<void>;
  selectedPage: MangaPage | null;
  setInpaintingGuideOpen: Dispatch<SetStateAction<boolean>>;
  setInpaintingMode: Dispatch<SetStateAction<boolean>>;
  setInpaintingTool: Dispatch<SetStateAction<"none" | "brush" | "eraser" | "picker" | "mask">>;
  setJobState: Dispatch<SetStateAction<JobState>>;
  setPatternMaskStrokesByPage: Dispatch<SetStateAction<Record<string, InpaintingMaskStroke[]>>>;
  setPeekOriginal: Dispatch<SetStateAction<boolean>>;
  setRegionSelection: Dispatch<SetStateAction<RegionSelectionState | null>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  setShowBlockChrome: Dispatch<SetStateAction<boolean>>;
  setShowTextBlocks: Dispatch<SetStateAction<boolean>>;
};

function failInpaintingJob(
  setJobState: Dispatch<SetStateAction<JobState>>,
  pushStatus: (line: string) => void,
  progressText: string,
  message: string
): void {
  setJobState({
    id: "failed-inpainting",
    kind: "inpainting",
    status: "failed",
    progressText,
    detail: message
  });
  pushStatus(message);
}

export function useInpaintingActions({
  askConfirm,
  clearPageImageCache,
  clearRetouchHistory,
  currentChapter,
  dirty,
  hideInpaintingGuide,
  jobActive,
  mergeLiveChapter,
  patternMaskStrokes,
  pushStatus,
  refreshLibrary,
  saveNow,
  selectedPage,
  setInpaintingGuideOpen,
  setInpaintingMode,
  setInpaintingTool,
  setJobState,
  setPatternMaskStrokesByPage,
  setPeekOriginal,
  setRegionSelection,
  setSelectedBlockId,
  setShowBlockChrome,
  setShowTextBlocks
}: UseInpaintingActionsOptions): {
  enterInpaintingMode: () => Promise<void>;
  exitInpaintingMode: () => void;
  exportInpaintingResults: (scope: InpaintingScope) => Promise<void>;
  revertInpainting: (scope: InpaintingScope) => Promise<void>;
  runDrawnPatternInpainting: () => Promise<void>;
  runInpainting: (scope: InpaintingScope) => Promise<void>;
} {
  const enterInpaintingMode = useCallback(async () => {
    if (!currentChapter || jobActive) {
      return;
    }
    if (dirty) {
      await saveNow();
    }
    setInpaintingMode(true);
    setInpaintingTool("none");
    setSelectedBlockId(null);
    setRegionSelection(null);
    setShowBlockChrome(true);
    setShowTextBlocks(true);
    if (!hideInpaintingGuide) {
      setInpaintingGuideOpen(true);
    }
    pushStatus("인페인팅 모드로 전환했습니다. 원문 지우기부터 시작하세요.");
  }, [
    currentChapter,
    dirty,
    hideInpaintingGuide,
    jobActive,
    pushStatus,
    saveNow,
    setInpaintingGuideOpen,
    setInpaintingMode,
    setInpaintingTool,
    setRegionSelection,
    setSelectedBlockId,
    setShowBlockChrome,
    setShowTextBlocks
  ]);

  const exitInpaintingMode = useCallback(() => {
    if (jobActive) {
      return;
    }
    setInpaintingMode(false);
    setInpaintingTool("none");
    setPeekOriginal(false);
    setInpaintingGuideOpen(false);
    setPatternMaskStrokesByPage({});
    setSelectedBlockId(null);
    setRegionSelection(null);
    void window.mangaApi.disposeInpaintingEngine().catch((error) => console.error(error));
    pushStatus("인페인팅 모드를 종료했습니다.");
  }, [
    jobActive,
    pushStatus,
    setInpaintingGuideOpen,
    setInpaintingMode,
    setInpaintingTool,
    setPatternMaskStrokesByPage,
    setPeekOriginal,
    setRegionSelection,
    setSelectedBlockId
  ]);

  const runInpainting = useCallback(
    async (scope: InpaintingScope) => {
      if (!currentChapter || jobActive) {
        return;
      }
      if (scope === "page" && !selectedPage) {
        return;
      }
      if (dirty) {
        await saveNow();
      }
      const targetLabel = "원문";
      const scopeLabel = scope === "page" ? "현재 페이지" : "아직 지우지 않은 페이지";
      const confirmed = await askConfirm(
        `${targetLabel} 지우기`,
        `${scopeLabel}의 번역 블록 위치에 있는 원문을 지웁니다.`,
        "말풍선, 톤, 배경 그림, 효과음 위 글자까지 모두 Flux 인페인팅으로 지웁니다. 원본 이미지는 유지하고 결과 이미지는 별도로 저장합니다."
      );
      if (!confirmed) {
        return;
      }

      setJobState({
        id: "pending-inpainting",
        kind: "inpainting",
        status: "starting",
        progressText: `${targetLabel} 지우기 준비 중`,
        phase: "inpainting_preparing"
      });

      let result;
      try {
        result = await window.mangaApi.startInpainting(
          scope === "page"
            ? {
                chapterId: currentChapter.id,
                mode: "page-pattern",
                pageId: selectedPage!.id
              }
            : {
                chapterId: currentChapter.id,
                mode: "chapter-pattern-pending"
              }
        );
      } catch (error) {
        console.error(error);
        failInpaintingJob(setJobState, pushStatus, "작업 실패", formatErrorMessage(error, `${targetLabel} 지우기를 시작하지 못했습니다.`));
        return;
      }
      if (result.chapter) {
        clearRetouchHistory();
        clearPageImageCache();
        mergeLiveChapter(result.chapter);
      }
      await refreshLibrary().catch((error) => {
        console.error(error);
        pushStatus(formatErrorMessage(error, "보관함 목록을 새로고침하지 못했습니다."));
      });

      if (result.status === "completed") {
        pushStatus(`${targetLabel} 지우기 완료: ${result.pagesChanged ?? 0}페이지, ${result.blocksErased ?? 0}블록`);
      } else if (result.status === "failed" && result.error) {
        pushStatus(result.error);
      }
    },
    [
      askConfirm,
      clearPageImageCache,
      clearRetouchHistory,
      currentChapter,
      dirty,
      jobActive,
      mergeLiveChapter,
      pushStatus,
      refreshLibrary,
      saveNow,
      selectedPage,
      setJobState
    ]
  );

  const runDrawnPatternInpainting = useCallback(async () => {
    if (!currentChapter || !selectedPage || jobActive || patternMaskStrokes.length === 0) {
      return;
    }
    if (dirty) {
      await saveNow();
    }
    const confirmed = await askConfirm(
      "그린 영역 지우기",
      "주황색으로 그린 마스크 영역만 Flux로 지웁니다.",
      "글자 위를 넉넉히 문질러 둔 영역을 crop으로 잘라 배경을 복원합니다. 결과는 별도 이미지로 저장되며 원본 페이지는 유지됩니다."
    );
    if (!confirmed) {
      return;
    }
    setInpaintingTool("none");
    setJobState({
      id: "pending-inpainting",
      kind: "inpainting",
      status: "starting",
      progressText: "그린 영역 지우기 준비 중",
      phase: "inpainting_preparing",
      progressCurrent: 0,
      progressTotal: 1
    });
    let result;
    try {
      result = await window.mangaApi.startInpainting({
        chapterId: currentChapter.id,
        mode: "page-pattern-drawn",
        pageId: selectedPage.id,
        strokes: patternMaskStrokes,
        featherPx: 8
      });
    } catch (error) {
      console.error(error);
      failInpaintingJob(setJobState, pushStatus, "작업 실패", formatErrorMessage(error, "그린 영역 지우기를 시작하지 못했습니다."));
      return;
    }
    if (result.chapter) {
      clearRetouchHistory();
      clearPageImageCache();
      mergeLiveChapter(result.chapter);
    }
    await refreshLibrary().catch((error) => {
      console.error(error);
      pushStatus(formatErrorMessage(error, "보관함 목록을 새로고침하지 못했습니다."));
    });
    if (result.status === "completed") {
      setPatternMaskStrokesByPage((current) => {
        const next = { ...current };
        delete next[selectedPage.id];
        return next;
      });
      pushStatus(`그린 영역 지우기 완료: ${result.pagesChanged ?? 0}페이지, ${result.blocksErased ?? 0}영역`);
    } else if (result.status === "failed" && result.error) {
      pushStatus(result.error);
    }
  }, [
    askConfirm,
    clearPageImageCache,
    clearRetouchHistory,
    currentChapter,
    dirty,
    jobActive,
    mergeLiveChapter,
    patternMaskStrokes,
    pushStatus,
    refreshLibrary,
    saveNow,
    selectedPage,
    setInpaintingTool,
    setJobState,
    setPatternMaskStrokesByPage
  ]);

  const revertInpainting = useCallback(
    async (scope: InpaintingScope) => {
      if (!currentChapter || jobActive) {
        return;
      }
      if (scope === "page" && !selectedPage) {
        return;
      }
      const confirmed = await askConfirm(
        scope === "page" ? "이 페이지 원본으로 되돌리기" : "전체 페이지 원본으로 되돌리기",
        scope === "page" ? "현재 페이지의 인페인팅 결과를 원본 이미지로 되돌립니다." : "현재 화의 인페인팅 결과를 원본 이미지로 되돌립니다.",
        "번역 블록과 좌표는 유지하고, 지워진 이미지 결과만 해제합니다."
      );
      if (!confirmed) {
        return;
      }
      try {
        const result = await window.mangaApi.revertInpainting(
          scope === "page"
            ? { chapterId: currentChapter.id, scope: "page", pageId: selectedPage!.id }
            : { chapterId: currentChapter.id, scope: "chapter" }
        );
        clearPageImageCache();
        mergeLiveChapter(result.chapter);
        clearRetouchHistory();
        pushStatus(`인페인팅 되돌리기 완료: ${result.pagesChanged}페이지`);
      } catch (error) {
        console.error(error);
        failInpaintingJob(setJobState, pushStatus, "되돌리기 실패", formatErrorMessage(error, "인페인팅 결과를 되돌리지 못했습니다."));
      }
    },
    [askConfirm, clearPageImageCache, clearRetouchHistory, currentChapter, jobActive, mergeLiveChapter, pushStatus, selectedPage, setJobState]
  );

  const exportInpaintingResults = useCallback(
    async (scope: InpaintingScope) => {
      if (!currentChapter || jobActive) {
        return;
      }
      if (scope === "page" && !selectedPage) {
        pushStatus("출력할 페이지가 선택되어 있지 않습니다.");
        return;
      }
      if (dirty) {
        await saveNow();
      }
      const targetTotal = scope === "page" ? 1 : currentChapter.pages.length;
      try {
        setJobState({
          id: "pending-export",
          kind: "inpainting",
          status: "starting",
          progressText: "PNG 출력 준비 중",
          phase: "finalizing",
          progressCurrent: 0,
          progressTotal: targetTotal,
          pageTotal: targetTotal,
          detail: scope === "page" ? selectedPage?.name : `${currentChapter.pages.length}페이지`
        });
        const request =
          scope === "page"
            ? { chapterId: currentChapter.id, scope, pageId: selectedPage!.id }
            : { chapterId: currentChapter.id, scope };
        const result = await window.mangaApi.exportInpaintingResults(request);
        pushStatus(
          result.openError
            ? `PNG 출력은 완료됐지만 폴더를 열지 못했습니다: ${result.outputDir}`
            : `인페인팅 결과를 PNG로 출력했습니다: ${result.pageCount}페이지`
        );
      } catch (error) {
        console.error(error);
        setJobState({
          id: "failed-export",
          kind: "inpainting",
          status: "failed",
          progressText: "PNG 출력 실패",
          detail: formatErrorMessage(error, "인페인팅 결과를 출력하지 못했습니다.")
        });
        pushStatus(formatErrorMessage(error, "인페인팅 결과를 출력하지 못했습니다."));
      }
    },
    [currentChapter, dirty, jobActive, pushStatus, saveNow, selectedPage, setJobState]
  );

  return {
    enterInpaintingMode,
    exitInpaintingMode,
    exportInpaintingResults,
    revertInpainting,
    runDrawnPatternInpainting,
    runInpainting
  };
}
