import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { inpaintingGateway as mangaGateway } from "../api/inpaintingGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import { captureWorkspaceMaskSnapshot } from "../lib/workspaceHistory";
import {
  failInpaintingJob,
  refreshLibraryWithStatus,
  saveDirtyChanges,
  type UseInpaintingActionsOptions,
} from "./inpaintingActionTypes";

export function useDrawnPatternInpaintingAction(
  options: UseInpaintingActionsOptions,
): () => Promise<void> {
  const { t } = useTranslation("renderer");
  return useCallback(async () => {
    await runDrawnPatternInpainting(options, t);
  }, [options, t]);
}

async function runDrawnPatternInpainting(
  options: UseInpaintingActionsOptions,
  t: TFunction<"renderer">,
): Promise<void> {
  const { currentChapter, selectedPage } = options;
  if (
    !currentChapter ||
    !selectedPage ||
    options.jobActive ||
    options.patternMaskStrokes.length === 0
  ) {
    return;
  }
  const ready = await prepareDrawnInpainting(options, t);
  if (!ready) {
    return;
  }
  await runDrawnInpaintingRequest({
    chapterId: currentChapter.id,
    clearPageImageCache: options.clearPageImageCache,
    clearRetouchHistory: options.clearRetouchHistory,
    mergeLiveChapter: options.mergeLiveChapter,
    patternMaskStrokes: options.patternMaskStrokes,
    pushStatus: options.pushStatus,
    refreshLibrary: options.refreshLibrary,
    selectedPageId: selectedPage.id,
    setJobState: options.setJobState,
    setPatternMaskStrokesByPage: options.setPatternMaskStrokesByPage,
    workspaceHistory: options.workspaceHistory,
    t,
  });
}

async function prepareDrawnInpainting(
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
      formatErrorMessage(error, t("inpainting.drawn.saveFailed")),
    );
    return false;
  }
  const confirmed = await options.askConfirm(
    t("inpainting.drawn.title"),
    t("inpainting.drawn.message"),
    t("inpainting.drawn.detail"),
  );
  if (!confirmed) {
    return false;
  }
  options.setPeekOriginal(false);
  options.setInpaintingTool("none");
  options.setJobState({
    id: "pending-inpainting",
    kind: "inpainting",
    status: "starting",
    progressText: t("inpainting.drawn.preparing"),
    phase: "inpainting_preparing",
    progressCurrent: 0,
    progressTotal: 1,
  });
  return true;
}

async function runDrawnInpaintingRequest({
  chapterId,
  clearPageImageCache,
  clearRetouchHistory,
  mergeLiveChapter,
  patternMaskStrokes,
  pushStatus,
  refreshLibrary,
  selectedPageId,
  setJobState,
  setPatternMaskStrokesByPage,
  workspaceHistory,
  t,
}: {
  chapterId: string;
  clearPageImageCache: () => void;
  clearRetouchHistory: () => void;
  mergeLiveChapter: UseInpaintingActionsOptions["mergeLiveChapter"];
  patternMaskStrokes: UseInpaintingActionsOptions["patternMaskStrokes"];
  pushStatus: UseInpaintingActionsOptions["pushStatus"];
  refreshLibrary: UseInpaintingActionsOptions["refreshLibrary"];
  selectedPageId: string;
  setJobState: UseInpaintingActionsOptions["setJobState"];
  setPatternMaskStrokesByPage: UseInpaintingActionsOptions["setPatternMaskStrokesByPage"];
  workspaceHistory: UseInpaintingActionsOptions["workspaceHistory"];
  t: TFunction<"renderer">;
}): Promise<void> {
  try {
    const result = await mangaGateway.startInpainting({
      chapterId,
      mode: "page-pattern-drawn",
      pageId: selectedPageId,
      strokes: patternMaskStrokes,
      featherPx: 8,
    });
    if (result.chapter) {
      clearRetouchHistory();
      clearPageImageCache();
      mergeLiveChapter(result.chapter);
    }
    if (result.historyTransaction) {
      workspaceHistory.recordImageEdit({
        label: t("workspaceHistory.drawnInpainting"),
        transactionId: result.historyTransaction.transactionId,
        mask: {
          before: captureWorkspaceMaskSnapshot(
            chapterId,
            selectedPageId,
            patternMaskStrokes,
          ),
          after: captureWorkspaceMaskSnapshot(
            chapterId,
            selectedPageId,
            result.status === "completed" ? [] : patternMaskStrokes,
          ),
        },
      });
    }
    void refreshLibraryWithStatus(
      refreshLibrary,
      pushStatus,
      t("library.refreshAfterJobFailed"),
    );
    reportDrawnInpaintingResult(result, selectedPageId, t, {
      pushStatus,
      setJobState,
      setPatternMaskStrokesByPage,
    });
  } catch (error) {
    console.error(error);
    failInpaintingJob(
      setJobState,
      pushStatus,
      t("inpainting.common.jobFailedTitle"),
      formatErrorMessage(error, t("inpainting.drawn.startFailed")),
    );
  }
}

function reportDrawnInpaintingResult(
  result: Awaited<ReturnType<typeof mangaGateway.startInpainting>>,
  selectedPageId: string,
  t: TFunction<"renderer">,
  {
    pushStatus,
    setJobState,
    setPatternMaskStrokesByPage,
  }: Pick<
    UseInpaintingActionsOptions,
    "pushStatus" | "setJobState" | "setPatternMaskStrokesByPage"
  >,
): void {
  if (result.status === "completed") {
    setPatternMaskStrokesByPage((current) => {
      const next = { ...current };
      delete next[selectedPageId];
      return next;
    });
    pushStatus(
      t("inpainting.drawn.success", {
        pages: result.pagesChanged ?? 0,
        regions: result.blocksErased ?? 0,
      }),
    );
  } else if (result.status === "failed") {
    if (result.error) console.error(result.error);
    failInpaintingJob(
      setJobState,
      pushStatus,
      t("inpainting.common.jobFailedTitle"),
      result.error?.trim() || t("inpainting.drawn.failed"),
    );
  }
}
