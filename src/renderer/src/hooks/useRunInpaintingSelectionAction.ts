import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { InpaintingPostprocessOptions } from "../../../shared/inpaintingTypes";
import type { AutoInpaintingChapterSelection } from "../lib/autoInpaintingSelection";
import { inpaintingGateway as mangaGateway } from "../api/inpaintingGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import {
  refreshLibraryWithStatus,
  saveDirtyChangesOrReportFailure,
  type UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";
import {
  runInpaintingSelectionsSequentially,
  type SequentialInpaintingResult,
} from "./inpaintingSelectionFlow";

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
  if (options.flowCancellationRef) {
    options.flowCancellationRef.current = false;
  }
  options.setFlowActive(true);
  try {
    const ready = await prepareSelectedInpainting(options, t);
    if (!ready) return;
    if (options.flowCancellationRef?.current) {
      reportSelectionResult(cancelledSelectionResult(), options, t);
      return;
    }
    const outcome = await runInpaintingSelectionsSequentially({
      workId: options.currentChapter.workId,
      selections,
      postprocess,
      shouldCancel: () => options.flowCancellationRef?.current === true,
      onResult: (result, selection) =>
        applySelectionResult(result, selection.chapterId, options, t),
    });
    hideEditChromeAfterBubbleLayout(outcome.status, postprocess, options);
    void refreshLibraryWithStatus(
      options.refreshLibrary,
      options.pushStatus,
      t("library.refreshAfterJobFailed"),
    );
    reportSelectionResult(outcome, options, t);
  } catch (error) {
    console.error(error);
    reportSelectionFailure(
      formatErrorMessage(error, t("inpainting.erase.startFailed")),
      options,
      t,
    );
  } finally {
    options.setFlowActive(false);
  }
}

function cancelledSelectionResult(): SequentialInpaintingResult {
  return {
    status: "cancelled",
    pagesChanged: 0,
    blocksErased: 0,
    pagesIncomplete: 0,
    blocksIncomplete: 0,
  };
}

function applySelectionResult(
  result: Awaited<ReturnType<typeof mangaGateway.startInpainting>>,
  chapterId: string,
  options: UseInpaintingActionsOptions,
  t: TFunction<"renderer">,
): void {
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
      chapterId,
    });
  }
}

function hideEditChromeAfterBubbleLayout(
  status: SequentialInpaintingResult["status"],
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
  const saved = await saveDirtyChangesOrReportFailure(
    options.dirty,
    options.saveNow,
    (error) =>
      reportSelectionFailure(
        formatErrorMessage(error, t("inpainting.erase.saveFailed")),
        options,
        t,
        t("inpainting.common.saveFailedTitle"),
      ),
  );
  if (!saved) return false;
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
  result: SequentialInpaintingResult,
  options: UseInpaintingActionsOptions,
  t: TFunction<"renderer">,
): void {
  if (result.status === "completed") {
    const message = t("inpainting.erase.success", {
      pages: result.pagesChanged ?? 0,
      blocks: result.blocksErased ?? 0,
    });
    options.setJobState({
      id: "inpainting-flow-completed",
      kind: "inpainting",
      status: "completed",
      progressText: message,
      phase: "inpainting_done",
    });
    options.pushStatus(message);
    return;
  }
  if (result.status === "partial") {
    const message = t("inpainting.erase.partial", {
      incompleteBlocks: result.blocksIncomplete,
    });
    options.setJobState({
      id: "inpainting-flow-partial",
      kind: "inpainting",
      status: "partial",
      progressText: message,
      detail: message,
      phase: "partial",
    });
    options.pushStatus(message);
    return;
  }
  if (result.status === "failed") {
    reportSelectionFailure(
      result.error?.trim() || t("inpainting.erase.failed"),
      options,
      t,
    );
    return;
  }
  if (result.status === "cancelled") {
    options.setJobState({
      id: "inpainting-flow-cancelled",
      kind: "inpainting",
      status: "cancelled",
      progressText: t("job.phase.cancelled"),
      phase: "cancelled",
    });
  }
}

function reportSelectionFailure(
  message: string,
  options: UseInpaintingActionsOptions,
  t: TFunction<"renderer">,
  progressText = t("inpainting.common.jobFailedTitle"),
): void {
  options.setJobState({
    id: "inpainting-flow-failed",
    kind: "inpainting",
    status: "failed",
    progressText,
    detail: message,
    phase: "failed",
  });
  options.pushStatus(message);
}
