import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { InpaintingPostprocessOptions } from "../../../shared/inpaintingTypes";
import type { AutoInpaintingChapterSelection } from "../lib/autoInpaintingSelection";
import { inpaintingGateway as mangaGateway } from "../api/inpaintingGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import {
  refreshLibraryWithStatus,
  saveDirtyChanges,
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
    let previewStaged = false;
    const outcome = await runInpaintingSelectionsSequentially({
      workId: options.currentChapter.workId,
      selections,
      postprocess,
      shouldCancel: () => options.flowCancellationRef?.current === true,
      onResult: async (result, selection) => {
        previewStaged =
          (await applySelectionResult(result, selection, options, t)) ||
          previewStaged;
      },
    });
    if (previewStaged) {
      const message = t("inpainting.preview.ready");
      options.setJobState({
        id: "inpainting-preview-ready",
        kind: "inpainting",
        status: "completed",
        progressText: message,
        phase: "inpainting_done",
      });
      options.pushStatus(message);
      return;
    }
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

async function applySelectionResult(
  result: Awaited<ReturnType<typeof mangaGateway.startInpainting>>,
  selection: AutoInpaintingChapterSelection,
  options: UseInpaintingActionsOptions,
  t: TFunction<"renderer">,
): Promise<boolean> {
  const currentChapter = result.chapters?.find(
    (chapter) => chapter.id === options.currentChapter?.id,
  );
  const previewPageId =
    selection.mode === "page-set" && selection.pageIds.length === 1
      ? selection.pageIds[0]
      : undefined;
  if (
    currentChapter &&
    previewPageId &&
    (result.status === "completed" || result.status === "partial") &&
    options.stageInpaintingPreview
  ) {
    const staged = await options.stageInpaintingPreview({
      result,
      afterChapter: currentChapter,
      pageId: previewPageId,
      label: t("workspaceHistory.autoInpainting"),
    });
    if (staged) return true;
  }
  if (currentChapter) {
    options.clearRetouchHistory();
    options.clearPageImageCache();
    options.mergeLiveChapter(currentChapter);
  }
  if (result.historyTransaction) {
    options.workspaceHistory.recordImageEdit({
      label: t("workspaceHistory.autoInpainting"),
      transactionId: result.historyTransaction.transactionId,
      chapterId: selection.chapterId,
    });
  }
  return false;
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
  try {
    await saveDirtyChanges(options.dirty, options.saveNow);
  } catch (error) {
    console.error(error);
    reportSelectionFailure(
      formatErrorMessage(error, t("inpainting.erase.saveFailed")),
      options,
      t,
      t("inpainting.common.saveFailedTitle"),
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
