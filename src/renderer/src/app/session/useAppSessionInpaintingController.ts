import type { BlockFormatDefaults } from "../../../../shared/blockFormat";
import type { InpaintingMaskStroke } from "../../../../shared/inpaintingTypes";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { useConfirmDialog } from "../../hooks/useConfirmDialog";
import type { useCurrentChapterUpdater } from "../../hooks/useCurrentChapterUpdater";
import type { useLiveChapterSync } from "../../hooks/useLiveChapterSync";
import { useInpaintingActions } from "../../hooks/useInpaintingActions";
import { useInpaintingContextBridge } from "../../hooks/useInpaintingContextBridge";
import { useInpaintingRetouch } from "../../hooks/useInpaintingRetouch";
import type { useLibraryActions } from "../../hooks/useLibraryActions";
import { usePageNavigationHandlers } from "../../hooks/usePageNavigationHandlers";
import type { useStatusLog } from "../../hooks/useStatusLog";
import type { useTranslationActions } from "../../hooks/useTranslationActions";
import type { WorkspaceHistoryController } from "../../hooks/useWorkspaceHistory";
import { captureWorkspaceMaskSnapshot } from "../../lib/workspaceHistory";
import { useWorkspacePointerHandlers } from "../../hooks/useWorkspacePointerHandlers";
import type { useChapterPersistence } from "../../hooks/useChapterPersistence";
import type { useAppSessionBridgeActions } from "./useAppSessionBridgeActions";
import type { AppSessionCoreState } from "./useAppSessionCoreState";
import type { useAppSessionDerivedState } from "./useAppSessionDerivedState";
import type { useAppSessionUiState } from "./useAppSessionUiState";

type AppSessionInpaintingControllerArgs = {
  askConfirm: ReturnType<typeof useConfirmDialog>["askConfirm"];
  blockFormatDefaults?: BlockFormatDefaults;
  bridgeActions: ReturnType<typeof useAppSessionBridgeActions>;
  core: AppSessionCoreState;
  derivedState: ReturnType<typeof useAppSessionDerivedState>;
  dirty: boolean;
  mergeLiveChapter: ReturnType<typeof useLiveChapterSync>;
  modalOpen: boolean;
  pushStatus: ReturnType<typeof useStatusLog>["pushStatus"];
  refreshLibrary: ReturnType<typeof useLibraryActions>["refreshLibrary"];
  saveNow: ReturnType<typeof useChapterPersistence>["saveNow"];
  translateSelectedRegion: ReturnType<
    typeof useTranslationActions
  >["translateSelectedRegion"];
  uiState: ReturnType<typeof useAppSessionUiState>;
  updateCurrentChapter: ReturnType<typeof useCurrentChapterUpdater>;
  workspaceHistory: WorkspaceHistoryController;
};

export function useAppSessionInpaintingController(
  args: AppSessionInpaintingControllerArgs,
): {
  inpaintingActions: ReturnType<typeof useInpaintingActions>;
  inpaintingBridge: ReturnType<typeof useInpaintingContextBridge>;
  pageNavigationHandlers: ReturnType<typeof usePageNavigationHandlers>;
  pointerHandlers: ReturnType<typeof useWorkspacePointerHandlers>;
} {
  const retouch = useRetouchController(args);
  const inpaintingActions = useInpaintingRunController(args, retouch);
  const pageNavigationHandlers = useNavigationController(args);
  const pointerHandlers = usePointerController(
    args,
    retouch,
    inpaintingActions,
  );
  const inpaintingBridge = useInpaintingBridgeController(
    args,
    retouch,
    inpaintingActions,
  );

  return {
    inpaintingActions,
    inpaintingBridge,
    pageNavigationHandlers,
    pointerHandlers,
  };
}

function useRetouchController({
  core,
  derivedState,
  dirty,
  mergeLiveChapter,
  pushStatus,
  saveNow,
  uiState,
  workspaceHistory,
}: AppSessionInpaintingControllerArgs): ReturnType<
  typeof useInpaintingRetouch
> {
  return useInpaintingRetouch({
    clearPageImageCache: derivedState.clearPageImageCache,
    currentChapter: core.currentChapter,
    currentChapterRef: core.currentChapterRef,
    dirty,
    inpaintingBrushRadius: uiState.inpaintingBrushRadius,
    inpaintingPaintColor: uiState.inpaintingPaintColor,
    jobActive:
      derivedState.jobActive ||
      uiState.translationFlowActive ||
      workspaceHistory.busy,
    mergeLiveChapter,
    pushStatus,
    saveNow,
    selectedPage: derivedState.selectedPage,
    setCurrentChapter: core.setCurrentChapter,
    workspaceHistory,
  });
}

function useInpaintingRunController(
  {
    askConfirm,
    core,
    derivedState,
    dirty,
    mergeLiveChapter,
    pushStatus,
    refreshLibrary,
    saveNow,
    uiState,
    workspaceHistory,
  }: AppSessionInpaintingControllerArgs,
  retouch: ReturnType<typeof useInpaintingRetouch>,
): ReturnType<typeof useInpaintingActions> {
  return useInpaintingActions({
    askConfirm,
    clearPageImageCache: derivedState.clearPageImageCache,
    clearRetouchHistory: retouch.clearRetouchHistory,
    currentChapter: core.currentChapter,
    dirty,
    jobActive:
      derivedState.jobActive ||
      retouch.retouchBusy ||
      uiState.translationFlowActive ||
      workspaceHistory.busy,
    mergeLiveChapter,
    patternMaskStrokes: derivedState.patternMaskStrokes,
    pushStatus,
    refreshLibrary,
    saveNow,
    selectedPage: derivedState.selectedPage,
    setInpaintingTool: uiState.setInpaintingTool,
    setJobState: core.setJobState,
    setPatternMaskStrokesByPage: uiState.setPatternMaskStrokesByPage,
    setPeekOriginal: uiState.setPeekOriginal,
    workspaceHistory,
  });
}

function useNavigationController({
  core,
  modalOpen,
  uiState,
}: AppSessionInpaintingControllerArgs): ReturnType<
  typeof usePageNavigationHandlers
> {
  return usePageNavigationHandlers({
    currentChapterRef: core.currentChapterRef,
    selectedPageIdRef: core.selectedPageIdRef,
    selectedBlockIdRef: core.selectedBlockIdRef,
    workspacePanelRef: core.workspacePanelRef,
    modalOpen,
    onPageChange: () => uiState.selectWorkspaceTool("select"),
    setSelectedPageId: core.setSelectedPageId,
    setSelectedBlockId: core.setSelectedBlockId,
  });
}

function usePointerController(
  {
    blockFormatDefaults,
    core,
    derivedState,
    pushStatus,
    translateSelectedRegion,
    uiState,
    updateCurrentChapter,
    workspaceHistory,
  }: AppSessionInpaintingControllerArgs,
  retouch: ReturnType<typeof useInpaintingRetouch>,
  inpaintingActions: ReturnType<typeof useInpaintingActions>,
): ReturnType<typeof useWorkspacePointerHandlers> {
  const { t } = useTranslation("renderer");
  const onPatternMaskChange = useCallback(
    (
      pageId: string,
      before: InpaintingMaskStroke[],
      after: InpaintingMaskStroke[],
    ) => {
      const chapterId = core.currentChapter?.id;
      if (!chapterId) return;
      workspaceHistory.recordMaskEdit({
        label: t("workspaceHistory.maskEdit"),
        before: captureWorkspaceMaskSnapshot(chapterId, pageId, before),
        after: captureWorkspaceMaskSnapshot(chapterId, pageId, after),
      });
    },
    [core.currentChapter?.id, t, workspaceHistory],
  );
  return useWorkspacePointerHandlers({
    appendRetouchPoint: retouch.appendRetouchPoint,
    applyRetouchPoints: retouch.applyRetouchPoints,
    blockFormatDefaults,
    currentChapter: core.currentChapter,
    imageRef: core.imageRef,
    inpaintingBrushRadius: uiState.inpaintingBrushRadius,
    inpaintingPaintColor: uiState.inpaintingPaintColor,
    inpaintingRetouchDrawingRef: retouch.inpaintingRetouchDrawingRef,
    inpaintingRetouchPointsRef: retouch.inpaintingRetouchPointsRef,
    inpaintingTool: uiState.inpaintingTool,
    inpaintingToolActive: derivedState.inpaintingToolActive,
    jobActive:
      derivedState.jobActive ||
      inpaintingActions.actionBusy ||
      retouch.retouchBusy ||
      uiState.translationFlowActive ||
      workspaceHistory.busy,
    onPatternMaskChange,
    onEscapeTool: () => uiState.selectWorkspaceTool("select"),
    lastInpaintingRetouchPointRef: retouch.lastInpaintingRetouchPointRef,
    pushStatus,
    patternMaskStrokesByPage: uiState.patternMaskStrokesByPage,
    regionSelection: core.regionSelection,
    selectedPage: derivedState.selectedPage,
    selectedPageEditLocked: derivedState.selectedPageEditLocked,
    selectedPageIdRef: core.selectedPageIdRef,
    selectedPageImageDataUrl: derivedState.selectedPageImageDataUrl,
    selectedPageImagePath: derivedState.selectedPageImagePath,
    setInpaintingPaintColor: uiState.setInpaintingPaintColor,
    setInpaintingTool: uiState.setInpaintingTool,
    setPatternMaskStrokesByPage: uiState.setPatternMaskStrokesByPage,
    setRegionSelection: core.setRegionSelection,
    setSelectedBlockId: core.setSelectedBlockId,
    setSelectedBlockIds: core.setSelectedBlockIds,
    stageRef: core.stageRef,
    stageTool: uiState.stageTool,
    translateSelectedRegion,
    updateCurrentChapter,
    workspacePanelRef: core.workspacePanelRef,
  });
}

function useInpaintingBridgeController(
  {
    bridgeActions,
    core,
    derivedState,
    uiState,
    workspaceHistory,
  }: AppSessionInpaintingControllerArgs,
  retouch: ReturnType<typeof useInpaintingRetouch>,
  inpaintingActions: ReturnType<typeof useInpaintingActions>,
): ReturnType<typeof useInpaintingContextBridge> {
  const clearPatternMask = useClearSelectedPatternMask({
    core,
    derivedState,
    uiState,
    workspaceHistory,
  });
  return useInpaintingContextBridge({
    blockCounts: derivedState.blockCounts,
    brushColor: uiState.inpaintingPaintColor,
    brushRadius: uiState.inpaintingBrushRadius,
    canRedo: retouch.retouchRedoStack.length > 0,
    canUndo: retouch.retouchUndoStack.length > 0,
    currentChapter: core.currentChapter,
    inpaintedPageCount: derivedState.inpaintedPageCount,
    jobActive:
      derivedState.jobActive ||
      inpaintingActions.actionBusy ||
      uiState.translationFlowActive ||
      workspaceHistory.busy,
    jobState: core.jobState,
    maskStrokes: derivedState.patternMaskStrokes,
    onCancelJob: bridgeActions.cancelJob,
    onClearPatternMask: clearPatternMask,
    onShowGuide: () => uiState.setInpaintingGuideOpen(true),
    peekAvailable: derivedState.peekAvailable,
    peeking: derivedState.showingOriginalPeek,
    progressSnapshot: derivedState.progressSnapshot,
    redoRetouch: retouch.redoRetouch,
    retouchBusy: retouch.retouchBusy,
    revertInpainting: inpaintingActions.revertInpainting,
    runDrawnPatternInpainting: inpaintingActions.runDrawnPatternInpainting,
    runInpainting: inpaintingActions.runInpainting,
    selectedPage: derivedState.selectedPage,
    setBrushColor: uiState.setInpaintingPaintColor,
    setBrushRadius: uiState.setInpaintingBrushRadius,
    setPeeking: uiState.setPeekOriginal,
    setShowBlockChrome: uiState.setShowBlockChrome,
    setShowTextBlocks: uiState.setShowTextBlocks,
    setTool: uiState.setInpaintingTool,
    showBlockChrome: uiState.showBlockChrome,
    showTextBlocks: uiState.showTextBlocks,
    tool: uiState.inpaintingTool,
    undoRetouch: retouch.undoRetouch,
  });
}

function useClearSelectedPatternMask({
  core,
  derivedState,
  uiState,
  workspaceHistory,
}: Pick<
  AppSessionInpaintingControllerArgs,
  "core" | "derivedState" | "uiState" | "workspaceHistory"
>): () => void {
  const { t } = useTranslation("renderer");
  return useCallback(() => {
    const selectedPage = derivedState.selectedPage;
    const chapterId = core.currentChapter?.id;
    const before = derivedState.patternMaskStrokes;
    if (!selectedPage || !chapterId || before.length === 0) {
      return;
    }
    const next = { ...uiState.patternMaskStrokesByPage };
    delete next[selectedPage.id];
    uiState.setPatternMaskStrokesByPage(next);
    workspaceHistory.recordMaskEdit({
      label: t("workspaceHistory.maskEdit"),
      before: captureWorkspaceMaskSnapshot(chapterId, selectedPage.id, before),
      after: captureWorkspaceMaskSnapshot(chapterId, selectedPage.id, []),
    });
  }, [core.currentChapter?.id, derivedState, t, uiState, workspaceHistory]);
}
