import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { BBox } from "../../../shared/textTypes";
import { isUsableRegionBbox } from "../../../shared/region";
import { analysisGateway } from "../api/analysisGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import type { NotificationPort } from "../lib/notificationPort";
import type {
  TranslationActions,
  UseTranslationActionsOptions,
} from "./translationActionTypes";
import {
  failAnalysisJob,
  handleTranslateRegionResult,
  mergeTranslatedRegionResult,
  refreshLibraryWithWarning,
  regionTranslationStartingState,
} from "./translationActionUtils";

type RegionTranslationContext = Pick<
  UseTranslationActionsOptions,
  | "beforeTranslate"
  | "clearStatusLines"
  | "currentChapter"
  | "currentChapterRef"
  | "jobActive"
  | "mergeLiveChapter"
  | "pushStatus"
  | "refreshLibrary"
  | "saveNow"
  | "selectedPage"
  | "setJobState"
  | "setSelectedBlockId"
  | "syncSavedPageVersion"
> & {
  notificationPort: NotificationPort;
  t: TFunction<"renderer">;
};

export function useTranslateSelectedRegionAction(
  options: UseTranslationActionsOptions,
  notificationPort: NotificationPort,
): TranslationActions["translateSelectedRegion"] {
  const { t } = useTranslation("renderer");
  const context = useRegionTranslationContext(options, notificationPort, t);
  return useCallback(
    (bbox: BBox) => translateSelectedRegion(bbox, context),
    [context],
  );
}

function useRegionTranslationContext(
  {
    beforeTranslate,
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
  }: UseTranslationActionsOptions,
  notificationPort: NotificationPort,
  t: TFunction<"renderer">,
): RegionTranslationContext {
  return useMemo(
    () => ({
      beforeTranslate,
      clearStatusLines,
      currentChapter,
      currentChapterRef,
      jobActive,
      mergeLiveChapter,
      notificationPort,
      pushStatus,
      refreshLibrary,
      saveNow,
      selectedPage,
      setJobState,
      setSelectedBlockId,
      syncSavedPageVersion,
      t,
    }),
    [
      beforeTranslate,
      clearStatusLines,
      currentChapter,
      currentChapterRef,
      jobActive,
      mergeLiveChapter,
      notificationPort,
      pushStatus,
      refreshLibrary,
      saveNow,
      selectedPage,
      setJobState,
      setSelectedBlockId,
      syncSavedPageVersion,
      t,
    ],
  );
}

async function translateSelectedRegion(
  bbox: BBox,
  context: RegionTranslationContext,
): Promise<void> {
  const { currentChapter, selectedPage } = context;
  if (!currentChapter || !selectedPage || context.jobActive) return;
  if (!isUsableRegionBbox(bbox, 10)) {
    context.pushStatus(context.t("regionTranslation.tooSmall"));
    return;
  }
  try {
    await context.saveNow();
    context.clearStatusLines();
    context.setJobState(regionTranslationStartingState(context.t));
    await context.beforeTranslate?.();
    const result = await analysisGateway.translateRegion({
      chapterId: currentChapter.id,
      pageId: selectedPage.id,
      bbox,
    });
    mergeTranslatedRegionResult(result, {
      currentChapterRef: context.currentChapterRef,
      mergeLiveChapter: context.mergeLiveChapter,
      selectedPageId: selectedPage.id,
      syncSavedPageVersion: context.syncSavedPageVersion,
    });
    await refreshLibraryWithWarning(
      context.refreshLibrary,
      context.pushStatus,
      context.t,
      context.notificationPort,
    );
    handleTranslateRegionResult(
      result,
      {
        pushStatus: context.pushStatus,
        setJobState: context.setJobState,
        setSelectedBlockId: context.setSelectedBlockId,
      },
      context.t,
    );
  } catch (error) {
    failAnalysisJob(
      context.setJobState,
      context.pushStatus,
      context.t("regionTranslation.failedTitle"),
      formatErrorMessage(error, context.t("regionTranslation.startFailed")),
    );
  }
}
