import type { PanelSyncState } from "../../../../shared/panelBridgeTypes";
import type { AppSessionViewModel } from "./appSessionViewModel";
import { isWorkspaceImageReadyForSelectedPage } from "./appSessionSelectors";

export function buildPanelSyncState({
  blockEditingActions,
  core,
  derivedState,
  inpaintingBridge,
  uiState,
  workspaceHistory,
}: Pick<
  AppSessionViewModel,
  | "blockEditingActions"
  | "core"
  | "derivedState"
  | "inpaintingBridge"
  | "uiState"
  | "workspaceHistory"
>): PanelSyncState {
  const interactionBusy =
    inpaintingBridge.contextValue.jobActive ||
    uiState.translationFlowActive ||
    workspaceHistory.busy;
  return {
    areaTranslateAvailable:
      isWorkspaceImageReadyForSelectedPage({
        selectedPage: derivedState.selectedPage,
        workspaceImageDataUrl: derivedState.workspaceImageDataUrl,
        workspaceImagePageId: derivedState.workspaceImagePageId,
      }) && !interactionBusy,
    areaTranslateSelecting: Boolean(core.regionSelection?.active),
    disableChapterApply: interactionBusy,
    editorDisabled:
      derivedState.selectedPageEditLocked || workspaceHistory.busy,
    blockStylePresets: blockEditingActions.stylePresetSummaries,
    selectedBlock: derivedState.selectedBlock,
    selectedBlockCount: derivedState.selectedBlockIds.length,
    transformMode:
      uiState.stageTool === "perspective" ||
      uiState.stageTool === "curve" ||
      uiState.stageTool === "warp"
        ? uiState.stageTool
        : "select",
    selectedPageSize: derivedState.selectedPage
      ? {
          width: derivedState.selectedPage.width,
          height: derivedState.selectedPage.height,
        }
      : null,
  };
}
