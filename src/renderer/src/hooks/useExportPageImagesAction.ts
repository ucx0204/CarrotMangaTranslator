import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { PageImageExportChapterSelection } from "../../../shared/pageImageExportTypes";
import type { PageJobTargetSnapshot } from "../../../shared/pageRevision";
import { exportGateway as mangaGateway } from "../api/exportGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
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
  expectedTargets?: PageJobTargetSnapshot[],
  options?: { omitText?: boolean },
) => Promise<boolean> {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (selections, expectedTargets, options) => {
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
          expectedTargets,
          ...(options?.omitText ? { omitText: true } : {}),
        });
        if (!result) {
          return false;
        }
        if (result.status === "cancelled") {
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
