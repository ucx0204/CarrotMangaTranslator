import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  InpaintingPostprocessOptions,
  StartInpaintingRequest,
} from "../../../shared/inpaintingTypes";
import type { AutoInpaintingChapterSelection } from "../lib/autoInpaintingSelection";
import { inpaintingGateway as mangaGateway } from "../api/inpaintingGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import {
  failInpaintingJob,
  refreshLibraryWithStatus,
  saveDirtyChanges,
  type UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";

export function useRunInpaintingSelectionAction(
  options: UseInpaintingActionsOptions,
): (
  selections: AutoInpaintingChapterSelection[],
  postprocess?: InpaintingPostprocessOptions,
) => Promise<void> {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (selections, postprocess) =>
      runSelectedInpainting(options, selections, postprocess, t),
    [options, t],
  );
}

async function runSelectedInpainting(
  options: UseInpaintingActionsOptions,
  selections: AutoInpaintingChapterSelection[],
  postprocess: InpaintingPostprocessOptions | undefined,
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
    const request = createSelectionInpaintingRequest(
      options.currentChapter.workId,
      selections,
      postprocess,
    );
    const result = await mangaGateway.startInpainting(request);
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
    hideEditChromeAfterBubbleLayout(result.status, postprocess, options);
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

function createSelectionInpaintingRequest(
  workId: string,
  selections: AutoInpaintingChapterSelection[],
  postprocess: InpaintingPostprocessOptions | undefined,
): StartInpaintingRequest {
  const request: StartInpaintingRequest = {
    mode: "selection-pattern",
    workId,
    selections,
  };
  if (postprocess) request.postprocess = postprocess;
  return request;
}

function hideEditChromeAfterBubbleLayout(
  status: "completed" | "cancelled" | "failed",
  postprocess: InpaintingPostprocessOptions | undefined,
  options: UseInpaintingActionsOptions,
): void {
  if (status === "completed" && postprocess?.bubbleLayout?.enabled) {
    options.setShowBlockChrome(false);
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
