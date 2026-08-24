import { useCallback } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { inpaintingGateway } from "../api/inpaintingGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import {
  failInpaintingJob,
  refreshLibraryWithStatus,
  saveDirtyChangesOrReportFailure,
  type UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";

export function useRunBubbleLayoutAction(
  options: UseInpaintingActionsOptions,
): (blockId?: string) => Promise<void> {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (blockId) => runBubbleLayout(options, blockId, t),
    [options, t],
  );
}

async function runBubbleLayout(
  options: UseInpaintingActionsOptions,
  blockId: string | undefined,
  t: TFunction<"renderer">,
): Promise<void> {
  const chapter = options.currentChapter;
  const page = options.selectedPage;
  if (!chapter || !page || options.jobActive) return;
  if (!isBubbleLayoutTargetAvailable(page.blocks, blockId)) {
    options.pushStatus(t("inpainting.bubbleLayout.requiresBlocks"));
    return;
  }
  if (!(await prepareBubbleLayout(options, t))) return;
  try {
    const result = await inpaintingGateway.startInpainting({
      chapterId: chapter.id,
      mode: "page-bubble-layout",
      pageId: page.id,
      policy: "balanced",
      blockId,
    });
    if (result.chapter) {
      options.clearRetouchHistory();
      options.clearPageImageCache();
      options.mergeLiveChapter(result.chapter);
    }
    if (result.historyTransaction) {
      options.workspaceHistory.recordImageEdit({
        label: t("workspaceHistory.bubbleLayout"),
        transactionId: result.historyTransaction.transactionId,
      });
    }
    if (result.status === "completed") {
      reportBubbleLayoutCompleted(options, t, blockId, result.blocksErased);
    } else if (result.status === "failed") {
      reportBubbleLayoutFailed(options, t, result.error);
    }
    void refreshLibraryWithStatus(
      options.refreshLibrary,
      options.pushStatus,
      t("library.refreshAfterJobFailed"),
    );
  } catch (error) {
    failInpaintingJob(
      options.setJobState,
      options.pushStatus,
      t("inpainting.bubbleLayout.failedTitle"),
      formatErrorMessage(error, t("inpainting.bubbleLayout.failed")),
    );
  }
}

function reportBubbleLayoutFailed(
  options: UseInpaintingActionsOptions,
  t: TFunction<"renderer">,
  error: string | undefined,
): void {
  failInpaintingJob(
    options.setJobState,
    options.pushStatus,
    t("inpainting.bubbleLayout.failedTitle"),
    error?.trim() || t("inpainting.bubbleLayout.failed"),
  );
}

function reportBubbleLayoutCompleted(
  options: UseInpaintingActionsOptions,
  t: TFunction<"renderer">,
  blockId: string | undefined,
  blocksChanged: number | undefined,
): void {
  if (blockId && blocksChanged === 0) {
    options.pushStatus(t("inpainting.bubbleLayout.selectedBlockNoMatch"));
    return;
  }
  options.setShowBlockChrome(false);
  options.pushStatus(t(resolveBubbleLayoutSuccessKey(blockId)));
}

function isBubbleLayoutTargetAvailable(
  blocks: Array<{ id: string }>,
  blockId: string | undefined,
): boolean {
  return (
    blocks.length > 0 &&
    (!blockId || blocks.some((block) => block.id === blockId))
  );
}

function resolveBubbleLayoutSuccessKey(
  blockId: string | undefined,
):
  | "inpainting.bubbleLayout.selectedBlockSuccess"
  | "inpainting.bubbleLayout.success" {
  return blockId
    ? "inpainting.bubbleLayout.selectedBlockSuccess"
    : "inpainting.bubbleLayout.success";
}

async function prepareBubbleLayout(
  options: UseInpaintingActionsOptions,
  t: TFunction<"renderer">,
): Promise<boolean> {
  const saved = await saveDirtyChangesOrReportFailure(
    options.dirty,
    options.saveNow,
    (error) =>
      failInpaintingJob(
        options.setJobState,
        options.pushStatus,
        t("inpainting.common.saveFailedTitle"),
        formatErrorMessage(error, t("inpainting.erase.saveFailed")),
      ),
  );
  if (!saved) return false;
  options.setPeekOriginal(false);
  options.setJobState({
    id: "pending-bubble-layout",
    kind: "inpainting",
    status: "starting",
    progressText: t("inpainting.bubbleLayout.preparing"),
    phase: "inpainting_preparing",
  });
  return true;
}
