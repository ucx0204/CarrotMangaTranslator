import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { mangaGateway } from "../api/mangaGateway";
import { formatErrorMessage } from "../lib/appHelpers";
import {
  failExportJob,
  resolveInpaintingTarget,
  saveDirtyChanges,
  type InpaintingScope,
  type UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";

export function useExportInpaintingResultsAction({
  currentChapter,
  dirty,
  jobActive,
  pushStatus,
  saveNow,
  selectedPage,
  setJobState,
}: UseInpaintingActionsOptions): (scope: InpaintingScope) => Promise<void> {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (scope) => {
      const target = resolveInpaintingTarget(
        currentChapter,
        selectedPage,
        scope,
      );
      if (jobActive || !target) {
        if (scope === "page" && currentChapter) {
          pushStatus(t("inpainting.export.noPage"));
        }
        return;
      }
      try {
        await saveDirtyChanges(dirty, saveNow);
      } catch (error) {
        console.error(error);
        failExportJob(
          setJobState,
          pushStatus,
          formatErrorMessage(error, t("inpainting.export.saveFailed")),
          t("inpainting.export.failedTitle"),
        );
        return;
      }
      setPendingExportJob({
        currentChapter,
        scope,
        selectedPage,
        setJobState,
        t,
      });
      try {
        const result = await mangaGateway.exportInpaintingResults(
          target.pageId
            ? {
                chapterId: target.chapterId,
                scope: "page",
                pageId: target.pageId,
              }
            : { chapterId: target.chapterId, scope: "chapter" },
        );
        reportExportResult(result, pushStatus, t);
      } catch (error) {
        console.error(error);
        failExportJob(
          setJobState,
          pushStatus,
          formatErrorMessage(error, t("inpainting.export.failed")),
          t("inpainting.export.failedTitle"),
        );
      }
    },
    [
      currentChapter,
      dirty,
      jobActive,
      pushStatus,
      saveNow,
      selectedPage,
      setJobState,
      t,
    ],
  );
}

function reportExportResult(
  result: Awaited<ReturnType<typeof mangaGateway.exportInpaintingResults>>,
  pushStatus: UseInpaintingActionsOptions["pushStatus"],
  t: TFunction<"renderer">,
): void {
  pushStatus(
    result.openError
      ? t("inpainting.export.openFolderFailed", { path: result.outputDir })
      : t("inpainting.export.success", { count: result.pageCount }),
  );
}

function setPendingExportJob({
  currentChapter,
  scope,
  selectedPage,
  setJobState,
  t,
}: Pick<
  UseInpaintingActionsOptions,
  "currentChapter" | "selectedPage" | "setJobState"
> & {
  scope: InpaintingScope;
  t: TFunction<"renderer">;
}): void {
  if (!currentChapter) {
    return;
  }
  const targetTotal = scope === "page" ? 1 : currentChapter.pages.length;
  setJobState({
    id: "pending-export",
    kind: "inpainting",
    status: "starting",
    progressText: t("inpainting.export.preparing"),
    phase: "finalizing",
    progressCurrent: 0,
    progressTotal: targetTotal,
    pageTotal: targetTotal,
    detail:
      scope === "page"
        ? selectedPage?.name
        : t("common.pageCount", { count: currentChapter.pages.length }),
  });
}
