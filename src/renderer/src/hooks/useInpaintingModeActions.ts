import { useCallback } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("renderer");
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
        formatErrorMessage(error, t("inpainting.mode.saveBeforeEnterFailed")),
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
    pushStatus(t("inpainting.mode.entered"));
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
    t,
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
  const { t } = useTranslation("renderer");
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
    pushStatus(t("inpainting.mode.exited"));
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
    t,
  ]);
}
