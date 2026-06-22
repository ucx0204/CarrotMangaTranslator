import { useCallback } from "react";
import { mangaGateway } from "../api/mangaGateway";
import { formatErrorMessage } from "../lib/appHelpers";
import type { UseInpaintingActionsOptions } from "./inpaintingActionTypes";

export function useInpaintingModeActions(
  options: UseInpaintingActionsOptions,
): {
  enterInpaintingMode: () => Promise<void>;
  exitInpaintingMode: () => void;
} {
  return {
    enterInpaintingMode: useEnterInpaintingMode(options),
    exitInpaintingMode: useExitInpaintingMode(options),
  };
}

function useEnterInpaintingMode({
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
  setShowTextBlocks,
}: UseInpaintingActionsOptions): () => Promise<void> {
  const enterInpaintingMode = useCallback(async () => {
    if (!currentChapter || jobActive) {
      return;
    }
    try {
      if (dirty) {
        await saveNow();
      }
    } catch (error) {
      console.error(error);
      pushStatus(
        formatErrorMessage(
          error,
          "인페인팅 모드로 들어가기 전에 변경사항을 저장하지 못했습니다.",
        ),
      );
      return;
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
    setShowTextBlocks,
  ]);

  return enterInpaintingMode;
}

function useExitInpaintingMode({
  jobActive,
  pushStatus,
  setInpaintingGuideOpen,
  setInpaintingMode,
  setInpaintingTool,
  setPatternMaskStrokesByPage,
  setPeekOriginal,
  setRegionSelection,
  setSelectedBlockId,
}: UseInpaintingActionsOptions): () => void {
  return useCallback(() => {
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
    void mangaGateway
      .disposeInpaintingEngine()
      .catch((error) => console.error(error));
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
    setSelectedBlockId,
  ]);
}
