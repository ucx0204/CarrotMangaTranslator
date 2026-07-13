import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { PageImageExportChapterSelection } from "../../../shared/pageImageExportTypes";
import { mangaGateway } from "../api/mangaGateway";
import { formatErrorMessage } from "../lib/appHelpers";
import {
  failExportJob,
  saveDirtyChanges,
  type UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";

export function useExportPageImagesAction({
  currentChapter,
  dirty,
  jobActive,
  pushStatus,
  saveNow,
  setJobState,
}: UseInpaintingActionsOptions): (
  selections: PageImageExportChapterSelection[],
) => Promise<boolean> {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (selections) => {
      if (!currentChapter || jobActive || selections.length === 0) {
        return false;
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
        throw error;
      }

      try {
        const result = await mangaGateway.exportPageImages({
          workId: currentChapter.workId,
          selections,
        });
        if (!result) {
          return false;
        }
        pushStatus(
          result.openError
            ? t("inpainting.export.openFolderFailed", {
                path: result.outputDir,
              })
            : t("inpainting.export.success", { count: result.pageCount }),
        );
        return true;
      } catch (error) {
        console.error(error);
        failExportJob(
          setJobState,
          pushStatus,
          formatErrorMessage(error, t("inpainting.export.failed")),
          t("inpainting.export.failedTitle"),
        );
        throw error;
      }
    },
    [currentChapter, dirty, jobActive, pushStatus, saveNow, setJobState, t],
  );
}
