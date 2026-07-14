import type { PanelSyncState } from "../../../../shared/panelBridgeTypes";
import type { AppSessionViewModel } from "./appSessionViewModel";
import { isWorkspaceImageReadyForSelectedPage } from "./appSessionSelectors";

export function buildPanelSyncState({
  core,
  derivedState,
  inpaintingBridge,
  uiState,
  workspaceHistory,
}: Pick<
  AppSessionViewModel,
  "core" | "derivedState" | "inpaintingBridge" | "uiState" | "workspaceHistory"
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
    editorDisabled: derivedState.selectedPageEditLocked || interactionBusy,
    selectedBlock: derivedState.selectedBlock,
    selectedBlockCount: derivedState.selectedBlockIds.length,
  };
}
