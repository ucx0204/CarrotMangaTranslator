import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { formatErrorMessage } from "../lib/errorPresentation";
import { libraryGateway } from "../api/libraryGateway";
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
  const latestRequestIdRef = useRef(0);
  return useCallback(
    async (chapterId) => {
      const requestId = ++latestRequestIdRef.current;
      const isLatestRequest = () => latestRequestIdRef.current === requestId;
      try {
        await performOpenChapterRequest({
          askConfirm,
          chapterId,
          clearDirtyTracking,
          clearPendingInpaintingMasks,
          currentChapterRef,
          dirty,
          hasPendingInpaintingMask,
          isLatestRequest,
          onChapterOpened,
          resetSaveBaseline,
          saveNow,
          setCurrentChapter,
          setSelectedBlockId,
          setSelectedPageId,
          t,
        });
      } catch (error) {
        if (isLatestRequest()) {
          pushStatus(formatErrorMessage(error, t("library.openChapterFailed")));
        }
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

type PerformOpenChapterRequestOptions = Pick<
  OpenChapterOptions,
  | "askConfirm"
  | "clearDirtyTracking"
  | "clearPendingInpaintingMasks"
  | "currentChapterRef"
  | "dirty"
  | "hasPendingInpaintingMask"
  | "onChapterOpened"
  | "resetSaveBaseline"
  | "saveNow"
  | "setCurrentChapter"
  | "setSelectedBlockId"
  | "setSelectedPageId"
> & {
  chapterId: string;
  isLatestRequest: () => boolean;
  t: TFunction<"renderer">;
};

async function performOpenChapterRequest(
  options: PerformOpenChapterRequestOptions,
): Promise<void> {
  if (options.currentChapterRef.current?.id === options.chapterId) {
    return;
  }
  if (!(await confirmPendingMaskDiscard(options))) {
    return;
  }
  if (!(await saveDirtyChapter(options))) {
    return;
  }
  const chapter = await libraryGateway.openChapter(options.chapterId);
  if (!options.isLatestRequest()) {
    return;
  }
  options.clearDirtyTracking();
  options.currentChapterRef.current = chapter;
  options.resetSaveBaseline(chapter);
  options.setCurrentChapter(chapter);
  options.setSelectedPageId(chapter.pages[0]?.id ?? null);
  options.setSelectedBlockId(null);
  options.clearPendingInpaintingMasks?.();
  options.onChapterOpened?.();
}

async function confirmPendingMaskDiscard(
  options: PerformOpenChapterRequestOptions,
): Promise<boolean> {
  if (!options.hasPendingInpaintingMask) {
    return true;
  }
  const confirmed = await options.askConfirm(
    options.t("inpainting.maskDiscard.title"),
    options.t("inpainting.maskDiscard.message"),
    options.t("inpainting.maskDiscard.detail"),
  );
  return confirmed && options.isLatestRequest();
}

async function saveDirtyChapter(
  options: PerformOpenChapterRequestOptions,
): Promise<boolean> {
  if (!options.dirty) {
    return true;
  }
  await options.saveNow();
  return options.isLatestRequest();
}
