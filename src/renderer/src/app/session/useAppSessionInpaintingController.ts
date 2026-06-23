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
import { useWorkspacePointerHandlers } from "../../hooks/useWorkspacePointerHandlers";
import type { useChapterPersistence } from "../../hooks/useChapterPersistence";
import type { useAppSessionBridgeActions } from "./useAppSessionBridgeActions";
import type { AppSessionCoreState } from "./useAppSessionCoreState";
import type { useAppSessionDerivedState } from "./useAppSessionDerivedState";
import type { useAppSessionUiState } from "./useAppSessionUiState";
import type { useInpaintingGuidePreference } from "./useInpaintingGuidePreference";

type AppSessionInpaintingControllerArgs = {
  askConfirm: ReturnType<typeof useConfirmDialog>["askConfirm"];
  bridgeActions: ReturnType<typeof useAppSessionBridgeActions>;
  core: AppSessionCoreState;
  derivedState: ReturnType<typeof useAppSessionDerivedState>;
  dirty: boolean;
  hideInpaintingGuide: ReturnType<
    typeof useInpaintingGuidePreference
  >["hideInpaintingGuide"];
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
  const pointerHandlers = usePointerController(args, retouch);
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
  mergeLiveChapter,
  pushStatus,
  uiState,
}: AppSessionInpaintingControllerArgs): ReturnType<
  typeof useInpaintingRetouch
> {
  return useInpaintingRetouch({
    clearPageImageCache: derivedState.clearPageImageCache,
    currentChapter: core.currentChapter,
    currentChapterRef: core.currentChapterRef,
    inpaintingBrushRadius: uiState.inpaintingBrushRadius,
    inpaintingPaintColor: uiState.inpaintingPaintColor,
    inpaintingToolActive: derivedState.inpaintingToolActive,
    jobActive: derivedState.jobActive,
    mergeLiveChapter,
    pushStatus,
    selectedPage: derivedState.selectedPage,
    setCurrentChapter: core.setCurrentChapter,
  });
}

function useInpaintingRunController(
  {
    askConfirm,
    core,
    derivedState,
    dirty,
    hideInpaintingGuide,
    mergeLiveChapter,
    pushStatus,
    refreshLibrary,
    saveNow,
    uiState,
  }: AppSessionInpaintingControllerArgs,
  retouch: ReturnType<typeof useInpaintingRetouch>,
): ReturnType<typeof useInpaintingActions> {
  return useInpaintingActions({
    askConfirm,
    clearPageImageCache: derivedState.clearPageImageCache,
    clearRetouchHistory: retouch.clearRetouchHistory,
    currentChapter: core.currentChapter,
    dirty,
    hideInpaintingGuide,
    jobActive: derivedState.jobActive,
    mergeLiveChapter,
    patternMaskStrokes: derivedState.patternMaskStrokes,
    pushStatus,
    refreshLibrary,
    saveNow,
    selectedPage: derivedState.selectedPage,
    setInpaintingGuideOpen: uiState.setInpaintingGuideOpen,
    setInpaintingMode: uiState.setInpaintingMode,
    setInpaintingTool: uiState.setInpaintingTool,
    setJobState: core.setJobState,
    setPatternMaskStrokesByPage: uiState.setPatternMaskStrokesByPage,
    setPeekOriginal: uiState.setPeekOriginal,
    setRegionSelection: core.setRegionSelection,
    setSelectedBlockId: core.setSelectedBlockId,
    setShowBlockChrome: uiState.setShowBlockChrome,
    setShowTextBlocks: uiState.setShowTextBlocks,
  });
}

function useNavigationController({
  core,
  modalOpen,
}: AppSessionInpaintingControllerArgs): ReturnType<
  typeof usePageNavigationHandlers
> {
  return usePageNavigationHandlers({
    currentChapterRef: core.currentChapterRef,
    selectedPageIdRef: core.selectedPageIdRef,
    selectedBlockIdRef: core.selectedBlockIdRef,
    workspacePanelRef: core.workspacePanelRef,
    modalOpen,
    setSelectedPageId: core.setSelectedPageId,
    setSelectedBlockId: core.setSelectedBlockId,
  });
}

function usePointerController(
  {
    core,
    derivedState,
    pushStatus,
    translateSelectedRegion,
    uiState,
    updateCurrentChapter,
  }: AppSessionInpaintingControllerArgs,
  retouch: ReturnType<typeof useInpaintingRetouch>,
): ReturnType<typeof useWorkspacePointerHandlers> {
  return useWorkspacePointerHandlers({
    appendRetouchPoint: retouch.appendRetouchPoint,
    applyRetouchPoints: retouch.applyRetouchPoints,
    currentChapter: core.currentChapter,
    imageRef: core.imageRef,
    inpaintingBrushRadius: uiState.inpaintingBrushRadius,
    inpaintingRetouchDrawingRef: retouch.inpaintingRetouchDrawingRef,
    inpaintingRetouchPointsRef: retouch.inpaintingRetouchPointsRef,
    inpaintingTool: uiState.inpaintingTool,
    inpaintingToolActive: derivedState.inpaintingToolActive,
    jobActive: derivedState.jobActive,
    lastInpaintingRetouchPointRef: retouch.lastInpaintingRetouchPointRef,
    pushStatus,
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
    setRetouchCursorPoint: retouch.setRetouchCursorPoint,
    setRetouchPreview: retouch.setRetouchPreview,
    setSelectedBlockId: core.setSelectedBlockId,
    setSelectedBlockIds: core.setSelectedBlockIds,
    stageRef: core.stageRef,
    translateSelectedRegion,
    updateCurrentChapter,
  });
}

function useInpaintingBridgeController(
  {
    bridgeActions,
    core,
    derivedState,
    uiState,
  }: AppSessionInpaintingControllerArgs,
  retouch: ReturnType<typeof useInpaintingRetouch>,
  inpaintingActions: ReturnType<typeof useInpaintingActions>,
): ReturnType<typeof useInpaintingContextBridge> {
  return useInpaintingContextBridge({
    blockCounts: derivedState.blockCounts,
    brushColor: uiState.inpaintingPaintColor,
    brushRadius: uiState.inpaintingBrushRadius,
    canRedo: retouch.retouchRedoStack.length > 0,
    canUndo: retouch.retouchUndoStack.length > 0,
    currentChapter: core.currentChapter,
    exportInpaintingResults: inpaintingActions.exportInpaintingResults,
    inpaintedPageCount: derivedState.inpaintedPageCount,
    jobActive: derivedState.jobActive,
    jobState: core.jobState,
    maskStrokes: derivedState.patternMaskStrokes,
    onCancelJob: bridgeActions.cancelJob,
    onClearPatternMask: () => clearSelectedPatternMask(derivedState, uiState),
    onShowGuide: () => uiState.setInpaintingGuideOpen(true),
    peekAvailable: derivedState.peekAvailable,
    peeking: derivedState.showingOriginalPeek,
    progressSnapshot: derivedState.progressSnapshot,
    redoRetouch: retouch.redoRetouch,
    retouchBusy: retouch.retouchBusy,
    retouchCursorPoint: retouch.retouchCursorPoint,
    retouchPreview: retouch.retouchPreview,
    revertInpainting: inpaintingActions.revertInpainting,
    runDrawnPatternInpainting: inpaintingActions.runDrawnPatternInpainting,
    runInpainting: inpaintingActions.runInpainting,
    selectedPage: derivedState.selectedPage,
    selectedPageOriginalImageDataUrl:
      derivedState.selectedPageOriginalImageDataUrl,
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

function clearSelectedPatternMask(
  derivedState: ReturnType<typeof useAppSessionDerivedState>,
  uiState: ReturnType<typeof useAppSessionUiState>,
): void {
  const selectedPage = derivedState.selectedPage;
  if (!selectedPage) {
    return;
  }
  uiState.setPatternMaskStrokesByPage((current) => {
    const next = { ...current };
    delete next[selectedPage.id];
    return next;
  });
}
