import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { AutoInpaintingChapterSelection } from "../lib/autoInpaintingSelection";
import { mangaGateway } from "../api/mangaGateway";
import { formatErrorMessage } from "../lib/appHelpers";
import {
  failInpaintingJob,
  refreshLibraryWithStatus,
  saveDirtyChanges,
  type UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";

export function useRunInpaintingSelectionAction(
  options: UseInpaintingActionsOptions,
): (selections: AutoInpaintingChapterSelection[]) => Promise<void> {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (selections) => runSelectedInpainting(options, selections, t),
    [options, t],
  );
}

async function runSelectedInpainting(
  options: UseInpaintingActionsOptions,
  selections: AutoInpaintingChapterSelection[],
  t: TFunction<"renderer">,
): Promise<void> {
  if (!options.currentChapter || options.jobActive || selections.length === 0) {
    return;
  }
  const ready = await prepareSelectedInpainting(options, t);
  if (!ready) {
    return;
  }
  try {
    const result = await mangaGateway.startInpainting({
      mode: "selection-pattern",
      workId: options.currentChapter.workId,
      selections,
    });
    const currentChapter = result.chapters?.find(
      (chapter) => chapter.id === options.currentChapter?.id,
    );
    if (currentChapter) {
      options.clearRetouchHistory();
      options.clearPageImageCache();
      options.mergeLiveChapter(currentChapter);
    }
    if (result.historyTransaction) {
      options.workspaceHistory.recordImageEdit({
        label: t("workspaceHistory.autoInpainting"),
        transactionId: result.historyTransaction.transactionId,
      });
    }
    void refreshLibraryWithStatus(
      options.refreshLibrary,
      options.pushStatus,
      t("library.refreshAfterJobFailed"),
    );
    reportSelectionResult(result, options.pushStatus, t);
  } catch (error) {
    console.error(error);
    failInpaintingJob(
      options.setJobState,
      options.pushStatus,
      t("inpainting.common.jobFailedTitle"),
      formatErrorMessage(error, t("inpainting.erase.startFailed")),
    );
  }
}

async function prepareSelectedInpainting(
  options: UseInpaintingActionsOptions,
  t: TFunction<"renderer">,
): Promise<boolean> {
  try {
    await saveDirtyChanges(options.dirty, options.saveNow);
  } catch (error) {
    console.error(error);
    failInpaintingJob(
      options.setJobState,
      options.pushStatus,
      t("inpainting.common.saveFailedTitle"),
      formatErrorMessage(error, t("inpainting.erase.saveFailed")),
    );
    return false;
  }
  options.setPeekOriginal(false);
  options.setJobState({
    id: "pending-inpainting",
    kind: "inpainting",
    status: "starting",
    progressText: t("inpainting.erase.preparing"),
    phase: "inpainting_preparing",
  });
  return true;
}

function reportSelectionResult(
  result: Awaited<ReturnType<typeof mangaGateway.startInpainting>>,
  pushStatus: (line: string) => void,
  t: TFunction<"renderer">,
): void {
  if (result.status === "completed") {
    pushStatus(
      t("inpainting.erase.success", {
        pages: result.pagesChanged ?? 0,
        blocks: result.blocksErased ?? 0,
      }),
    );
  } else if (result.status === "failed") {
    pushStatus(t("inpainting.erase.failed"));
  }
}
