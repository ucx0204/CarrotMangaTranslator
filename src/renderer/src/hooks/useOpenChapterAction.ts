import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { formatErrorMessage } from "../lib/appHelpers";
import { libraryGateway } from "./libraryGateway";
import type { UseLibraryActionsOptions } from "./libraryActionTypes";

type OpenChapterOptions = Pick<
  UseLibraryActionsOptions,
  | "clearDirtyTracking"
  | "clearPendingInpaintingMasks"
  | "currentChapterRef"
  | "dirty"
  | "hasPendingInpaintingMask"
  | "askConfirm"
  | "onChapterOpened"
  | "pushStatus"
  | "resetSaveBaseline"
  | "saveNow"
  | "setCurrentChapter"
  | "setSelectedBlockId"
  | "setSelectedPageId"
>;

export function useOpenChapterAction({
  askConfirm,
  clearDirtyTracking,
  clearPendingInpaintingMasks,
  currentChapterRef,
  dirty,
  hasPendingInpaintingMask,
  onChapterOpened,
  pushStatus,
  resetSaveBaseline,
  saveNow,
  setCurrentChapter,
  setSelectedBlockId,
  setSelectedPageId,
}: OpenChapterOptions): (chapterId: string) => Promise<void> {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (chapterId) => {
      if (currentChapterRef.current?.id === chapterId) {
        return;
      }
      try {
        if (hasPendingInpaintingMask) {
          const confirmed = await askConfirm(
            t("inpainting.maskDiscard.title"),
            t("inpainting.maskDiscard.message"),
            t("inpainting.maskDiscard.detail"),
          );
          if (!confirmed) {
            return;
          }
        }
        if (dirty) {
          await saveNow();
        }
        const chapter = await libraryGateway.openChapter(chapterId);
        clearDirtyTracking();
        currentChapterRef.current = chapter;
        resetSaveBaseline(chapter);
        setCurrentChapter(chapter);
        setSelectedPageId(chapter.pages[0]?.id ?? null);
        setSelectedBlockId(null);
        clearPendingInpaintingMasks?.();
        onChapterOpened?.();
      } catch (error) {
        console.error(error);
        pushStatus(formatErrorMessage(error, t("library.openChapterFailed")));
      }
    },
    [
      clearDirtyTracking,
      clearPendingInpaintingMasks,
      currentChapterRef,
      dirty,
      hasPendingInpaintingMask,
      askConfirm,
      onChapterOpened,
      pushStatus,
      resetSaveBaseline,
      saveNow,
      setCurrentChapter,
      setSelectedBlockId,
      setSelectedPageId,
      t,
    ],
  );
}
