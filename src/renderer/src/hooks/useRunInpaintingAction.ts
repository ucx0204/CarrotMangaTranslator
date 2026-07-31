import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { inpaintingGateway as mangaGateway } from "../api/inpaintingGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import {
  failInpaintingJob,
  refreshLibraryWithStatus,
  resolveInpaintingTarget,
  saveDirtyChanges,
  type InpaintingScope,
  type UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";

export function useRunInpaintingAction(
  options: UseInpaintingActionsOptions,
): (scope: InpaintingScope, blockId?: string) => Promise<void> {
  const { t } = useTranslation("renderer");
  return useCallback(
    async (scope, blockId) => {
      await runPatternInpainting(options, scope, blockId, t);
    },
    [options, t],
  );
}

async function runPatternInpainting(
  options: UseInpaintingActionsOptions,
  scope: InpaintingScope,
  blockId: string | undefined,
  t: TFunction<"renderer">,
): Promise<void> {
  const target = resolveInpaintingTarget(
    options.currentChapter,
    options.selectedPage,
    scope,
  );
  if (!target || options.jobActive) {
    return;
  }
  if (
    blockId &&
    (!target.page || !target.page.blocks.some((block) => block.id === blockId))
  ) {
    return;
  }
  const ready = await preparePatternInpainting(options, scope, blockId, t);
  if (!ready) {
    return;
  }
  try {
    const result = await mangaGateway.startInpainting(
      target.pageId
        ? {
            chapterId: target.chapterId,
            mode: "page-pattern",
            pageId: target.pageId,
            ...(blockId ? { blockId } : {}),
          }
        : { chapterId: target.chapterId, mode: "chapter-pattern-pending" },
    );
    if (result.chapter) {
      options.clearRetouchHistory();
      options.clearPageImageCache();
      options.mergeLiveChapter(result.chapter);
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
    reportPatternInpaintingResult(result, options, t);
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

async function preparePatternInpainting(
  options: UseInpaintingActionsOptions,
  scope: InpaintingScope,
  blockId: string | undefined,
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
  const confirmed = await confirmPatternInpainting(
    options.askConfirm,
    scope,
    blockId,
    t,
  );
  if (!confirmed) {
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

function confirmPatternInpainting(
  askConfirm: UseInpaintingActionsOptions["askConfirm"],
  scope: InpaintingScope,
  blockId: string | undefined,
  t: TFunction<"renderer">,
): Promise<boolean> {
  const scopeLabel = t(
    blockId
      ? "inpainting.erase.selectedBlock"
      : scope === "page"
        ? "inpainting.erase.currentPage"
        : "inpainting.erase.pendingPages",
  );
  return askConfirm(
    t("inpainting.erase.title"),
    t("inpainting.erase.message", { scope: scopeLabel }),
    t("inpainting.erase.detail"),
  );
}

function reportPatternInpaintingResult(
  result: Awaited<ReturnType<typeof mangaGateway.startInpainting>>,
  options: Pick<UseInpaintingActionsOptions, "pushStatus" | "setJobState">,
  t: TFunction<"renderer">,
): void {
  if (result.status === "completed") {
    options.pushStatus(
      t("inpainting.erase.success", {
        pages: result.pagesChanged ?? 0,
        blocks: result.blocksErased ?? 0,
      }),
    );
  } else if (result.status === "failed") {
    if (result.error) console.error(result.error);
    failInpaintingJob(
      options.setJobState,
      options.pushStatus,
      t("inpainting.common.jobFailedTitle"),
      result.error?.trim() || t("inpainting.erase.failed"),
    );
  }
}
