import { useCallback, useMemo } from "react";
import type { RegionAnalysisRequest } from "../../../shared/analysisTypes";
import { createPageRevision } from "../../../shared/pageRevision";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { BBox } from "../../../shared/textTypes";
import { isUsableRegionBbox } from "../../../shared/region";
import { analysisGateway } from "../api/analysisGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import type { NotificationPort } from "../lib/notificationPort";
import type { UseTranslationActionsOptions } from "./translationActionTypes";
import {
  failAnalysisJob,
  handleTranslateRegionResult,
  mergeTranslatedRegionResult,
  refreshLibraryWithWarning,
  regionTranslationStartingState,
} from "./translationActionUtils";

type RegionTranslationContext = Pick<
  UseTranslationActionsOptions,
  | "recordImageEdit"
  | "beforeTranslate"
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
): (bbox: BBox, request?: Partial<RegionAnalysisRequest>) => Promise<boolean> {
  const { t } = useTranslation("renderer");
  const context = useRegionTranslationContext(options, notificationPort, t);
  return useCallback(
    (bbox: BBox, request?: Partial<RegionAnalysisRequest>) =>
      translateSelectedRegion(bbox, context, request),
    [context],
  );
}

function useRegionTranslationContext(
  {
    recordImageEdit,
    beforeTranslate,
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
      recordImageEdit,
      beforeTranslate,
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
      recordImageEdit,
      beforeTranslate,
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
  request?: Partial<RegionAnalysisRequest>,
): Promise<boolean> {
  const { currentChapter, selectedPage } = context;
  if (!currentChapter || !selectedPage || context.jobActive) return false;
  if (!isUsableRegionBbox(bbox, 10)) {
    context.pushStatus(context.t("regionTranslation.tooSmall"));
    return false;
  }
  try {
    await prepareSelectedRegionTranslation(context, request);
    const result = await analysisGateway.translateRegion({
      ...request,
      pageRevision: createPageRevision(
        context.currentChapterRef.current?.pages.find(
          (page) => page.id === selectedPage.id,
        ) ?? selectedPage,
      ),
      chapterId: currentChapter.id,
      pageId: selectedPage.id,
      bbox,
    });
    if (result.status === "completed" && result.history)
      context.recordImageEdit({
        label: context.t("regionTranslation.title"),
        transactionId: result.history.transactionId,
        chapterId: currentChapter.id,
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
    return result.status === "completed";
  } catch (error) {
    context.notificationPort.error(
      formatErrorMessage(error, context.t("regionTranslation.startFailed")),
    );
    failAnalysisJob(
      context.setJobState,
      context.pushStatus,
      context.t("regionTranslation.failedTitle"),
      formatErrorMessage(error, context.t("regionTranslation.startFailed")),
    );
    return false;
  }
}

async function prepareSelectedRegionTranslation(
  context: RegionTranslationContext,
  request?: Partial<RegionAnalysisRequest>,
) {
  await context.saveNow();
  context.setJobState(regionTranslationStartingState(context.t));
  if (!request?.codexTypesetting) await context.beforeTranslate?.();
}
