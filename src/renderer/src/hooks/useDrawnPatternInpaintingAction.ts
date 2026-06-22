import { useCallback } from "react";
import { mangaGateway } from "../api/mangaGateway";
import { formatErrorMessage } from "../lib/appHelpers";
import {
  failInpaintingJob,
  refreshLibraryWithStatus,
  saveDirtyChanges,
  type UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";

export function useDrawnPatternInpaintingAction(
  options: UseInpaintingActionsOptions,
): () => Promise<void> {
  return useCallback(async () => {
    await runDrawnPatternInpainting(options);
  }, [options]);
}

async function runDrawnPatternInpainting(
  options: UseInpaintingActionsOptions,
): Promise<void> {
  const { currentChapter, selectedPage } = options;
  if (
    !currentChapter ||
    !selectedPage ||
    options.jobActive ||
    options.patternMaskStrokes.length === 0
  ) {
    return;
  }
  const ready = await prepareDrawnInpainting(options);
  if (!ready) {
    return;
  }
  await runDrawnInpaintingRequest({
    chapterId: currentChapter.id,
    clearPageImageCache: options.clearPageImageCache,
    clearRetouchHistory: options.clearRetouchHistory,
    mergeLiveChapter: options.mergeLiveChapter,
    patternMaskStrokes: options.patternMaskStrokes,
    pushStatus: options.pushStatus,
    refreshLibrary: options.refreshLibrary,
    selectedPageId: selectedPage.id,
    setJobState: options.setJobState,
    setPatternMaskStrokesByPage: options.setPatternMaskStrokesByPage,
  });
}

async function prepareDrawnInpainting(
  options: UseInpaintingActionsOptions,
): Promise<boolean> {
  try {
    await saveDirtyChanges(options.dirty, options.saveNow);
  } catch (error) {
    console.error(error);
    failInpaintingJob(
      options.setJobState,
      options.pushStatus,
      "저장 실패",
      formatErrorMessage(
        error,
        "그린 영역을 지우기 전에 변경사항을 저장하지 못했습니다.",
      ),
    );
    return false;
  }
  const confirmed = await options.askConfirm(
    "그린 영역 지우기",
    "주황색으로 그린 마스크 영역만 Flux로 지웁니다.",
    "글자 위를 넉넉히 문질러 둔 영역을 crop으로 잘라 배경을 복원합니다. 결과는 별도 이미지로 저장되며 원본 페이지는 유지됩니다.",
  );
  if (!confirmed) {
    return false;
  }
  options.setInpaintingTool("none");
  options.setJobState({
    id: "pending-inpainting",
    kind: "inpainting",
    status: "starting",
    progressText: "그린 영역 지우기 준비 중",
    phase: "inpainting_preparing",
    progressCurrent: 0,
    progressTotal: 1,
  });
  return true;
}

async function runDrawnInpaintingRequest({
  chapterId,
  clearPageImageCache,
  clearRetouchHistory,
  mergeLiveChapter,
  patternMaskStrokes,
  pushStatus,
  refreshLibrary,
  selectedPageId,
  setJobState,
  setPatternMaskStrokesByPage,
}: {
  chapterId: string;
  clearPageImageCache: () => void;
  clearRetouchHistory: () => void;
  mergeLiveChapter: UseInpaintingActionsOptions["mergeLiveChapter"];
  patternMaskStrokes: UseInpaintingActionsOptions["patternMaskStrokes"];
  pushStatus: UseInpaintingActionsOptions["pushStatus"];
  refreshLibrary: UseInpaintingActionsOptions["refreshLibrary"];
  selectedPageId: string;
  setJobState: UseInpaintingActionsOptions["setJobState"];
  setPatternMaskStrokesByPage: UseInpaintingActionsOptions["setPatternMaskStrokesByPage"];
}): Promise<void> {
  try {
    const result = await mangaGateway.startInpainting({
      chapterId,
      mode: "page-pattern-drawn",
      pageId: selectedPageId,
      strokes: patternMaskStrokes,
      featherPx: 8,
    });
    if (result.chapter) {
      clearRetouchHistory();
      clearPageImageCache();
      mergeLiveChapter(result.chapter);
    }
    await refreshLibraryWithStatus(refreshLibrary, pushStatus);
    reportDrawnInpaintingResult(result, selectedPageId, {
      pushStatus,
      setPatternMaskStrokesByPage,
    });
  } catch (error) {
    console.error(error);
    failInpaintingJob(
      setJobState,
      pushStatus,
      "작업 실패",
      formatErrorMessage(error, "그린 영역 지우기를 시작하지 못했습니다."),
    );
  }
}

function reportDrawnInpaintingResult(
  result: Awaited<ReturnType<typeof mangaGateway.startInpainting>>,
  selectedPageId: string,
  {
    pushStatus,
    setPatternMaskStrokesByPage,
  }: Pick<
    UseInpaintingActionsOptions,
    "pushStatus" | "setPatternMaskStrokesByPage"
  >,
): void {
  if (result.status === "completed") {
    setPatternMaskStrokesByPage((current) => {
      const next = { ...current };
      delete next[selectedPageId];
      return next;
    });
    pushStatus(
      `그린 영역 지우기 완료: ${result.pagesChanged ?? 0}페이지, ${result.blocksErased ?? 0}영역`,
    );
  } else if (result.status === "failed" && result.error) {
    pushStatus(result.error);
  }
}
