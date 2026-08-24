import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { inpaintingGateway as mangaGateway } from "../api/inpaintingGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import {
  failInpaintingJob,
  resolveInpaintingTarget,
  saveDirtyChanges,
  type InpaintingScope,
  type UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";

export function useRevertInpaintingAction(
  options: UseInpaintingActionsOptions,
): (scope: InpaintingScope) => Promise<void> {
  const { t } = useTranslation("renderer");
  return useCallback(
    (scope) => runRevertInpainting(options, scope, t),
    [options, t],
  );
}

async function runRevertInpainting(
  options: UseInpaintingActionsOptions,
  scope: InpaintingScope,
  t: TFunction<"renderer">,
): Promise<void> {
  const target = resolveInpaintingTarget(
    options.currentChapter,
    options.selectedPage,
    scope,
  );
  if (!target || options.jobActive) return;
  const confirmed = await options.askConfirm(
    scope === "page"
      ? t("inpainting.revert.pageTitle")
      : t("inpainting.revert.chapterTitle"),
    scope === "page"
      ? t("inpainting.revert.pageMessage")
      : t("inpainting.revert.chapterMessage"),
  );
  if (!confirmed) return;
  options.setPeekOriginal(false);
  try {
    await saveDirtyChanges(options.dirty, options.saveNow);
    const result = await mangaGateway.revertInpainting(
      target.pageId
        ? {
            chapterId: target.chapterId,
            scope: "page",
            pageId: target.pageId,
          }
        : { chapterId: target.chapterId, scope: "chapter" },
    );
    options.clearPageImageCache();
    options.mergeLiveChapter(result.chapter);
    options.clearRetouchHistory();
    if (result.historyTransaction) {
      options.workspaceHistory.recordImageEdit({
        label: t("workspaceHistory.resetOriginal"),
        transactionId: result.historyTransaction.transactionId,
      });
    }
    options.pushStatus(
      t("inpainting.revert.success", { count: result.pagesChanged }),
    );
  } catch (error) {
    failInpaintingJob(
      options.setJobState,
      options.pushStatus,
      t("inpainting.revert.failedTitle"),
      formatErrorMessage(error, t("inpainting.revert.failed")),
    );
  }
}
