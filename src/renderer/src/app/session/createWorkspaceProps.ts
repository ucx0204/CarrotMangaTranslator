import type { AppSessionViewProps } from "./AppSessionView";
import type { AppSessionViewModel } from "./appSessionViewModel";
import { isWorkspaceImageReadyForSelectedPage } from "./appSessionSelectors";
import { createOriginalImageOpacityProps } from "./createOriginalImageOpacityProps";
import { createWorkspaceSoundEffectReviewProps } from "./createSoundEffectReviewViewProps";
import { createWorkspaceViewProps } from "./createWorkspaceViewProps";
import { isWorkspaceJobActive } from "./workspaceActivity";

export function createWorkspaceProps({
  blockEditingActions,
  commandRegistry,
  core,
  derivedState,
  inpaintingBridge,
  libraryActions,
  pointerHandlers,
  settingsDialog,
  uiState,
  translationActions,
  workspaceHistory,
  libraryDrop,
}: AppSessionViewModel): AppSessionViewProps["workspaceProps"] {
  return {
    ...createWorkspaceViewProps(uiState),
    commandLabels: commandRegistry.labels,
    wheelZoomSensitivityPercent:
      settingsDialog.settings?.ui?.wheelZoomSensitivityPercent ?? 1,
    interactionPreviewStore: pointerHandlers.interactionPreviewStore,
    imageRef: core.imageRef,
    brushColor: uiState.inpaintingPaintColor,
    jobActive: isWorkspaceJobActive(
      derivedState,
      workspaceHistory,
      libraryDrop,
    ),
    jobState: core.jobState,
    maskStrokes: derivedState.patternMaskStrokes,
    lastRetouchTool: uiState.lastRetouchTool,
    ...createOriginalImageOpacityProps({ derivedState, uiState }),
    ...createWorkspaceInteractionProps({
      blockEditingActions,
      core,
      pointerHandlers,
      uiState,
    }),
    onOpenBatchImport: commandRegistry.byId["open-batch"].run,
    onOpenSettings: commandRegistry.byId["open-settings"].run,
    onOpenShareImport: commandRegistry.byId["open-share-import"].run,
    onOpenTranslationSource: commandRegistry.byId["open-translate-source"].run,
    progressSnapshot: derivedState.progressSnapshot,
    regionSelectionActive: Boolean(core.regionSelection?.active),
    regionTranslationAvailable: isWorkspaceImageReadyForSelectedPage({
      selectedPage: derivedState.selectedPage,
      workspaceImageDataUrl: derivedState.workspaceImageDataUrl,
      workspaceImagePageId: derivedState.workspaceImagePageId,
    }),
    regionSelectionRect: derivedState.regionSelectionRect,
    retouchCursor: inpaintingBridge.retouchCursor,
    retouchOriginalImageDataUrl: derivedState.selectedPageOriginalImageDataUrl,
    selectedBlockId: core.selectedBlockId,
    selectedBlockIds: derivedState.selectedBlockIds,
    selectedPage: derivedState.selectedPage,
    selectedPageImageDataUrl: derivedState.workspaceImageDataUrl,
    selectedPageImageLoading: derivedState.workspaceImageLoading,
    selectedPageImagePageId: derivedState.workspaceImagePageId,
    showBlockChrome: uiState.showBlockChrome,
    showTextBlocks: uiState.showTextBlocks,
    ...createWorkspaceSoundEffectReviewProps({
      derivedState,
      libraryActions,
      settingsDialog,
      uiState,
      translationActions,
    }),
    showingOriginalPeek: derivedState.showingOriginalPeek,
    stageRef: core.stageRef,
    stageSize: derivedState.stageSize,
    stageTool: uiState.stageTool,
    stageToolbarHidden: uiState.stageToolbarHidden,
    workspacePanelRef: core.workspacePanelRef,
    workspaceZoomControllerRef: core.workspaceZoomControllerRef,
  };
}

function createWorkspaceInteractionProps({
  blockEditingActions,
  core,
  pointerHandlers,
  uiState,
}: Pick<
  AppSessionViewModel,
  "blockEditingActions" | "core" | "pointerHandlers" | "uiState"
>) {
  return {
    onBlockPointerDown: pointerHandlers.onBlockPointerDown,
    onWarpTransformCommit: (
      blockId: Parameters<typeof blockEditingActions.updateBlock>[0],
      transform: Parameters<
        typeof blockEditingActions.updateBlock
      >[1]["warpTransform"],
    ) => blockEditingActions.updateBlock(blockId, { warpTransform: transform }),
    onApplyBubbleLayoutDraft: pointerHandlers.applyBubbleLayoutDraft,
    onCancelBubbleLayoutDraft: pointerHandlers.cancelBubbleLayoutDraft,
    onSelectStageTool: (
      tool: Parameters<typeof uiState.selectWorkspaceTool>[0],
    ) => {
      core.setRegionSelection(null);
      uiState.selectWorkspaceTool(tool);
    },
    onToggleRegionTranslation: pointerHandlers.startRegionTranslationSelection,
    onStagePointerDown: pointerHandlers.onStagePointerDown,
    onStagePointerLeave: pointerHandlers.onStagePointerLeave,
    onStagePointerMove: pointerHandlers.onStagePointerMove,
    onStagePointerUp: pointerHandlers.onStagePointerUp,
    onUndoBubbleLayoutPoint: pointerHandlers.undoBubbleLayoutPoint,
    onToggleStageToolbarHidden: () =>
      uiState.setStageToolbarHidden((hidden) => !hidden),
  };
}
