import type { PanelSyncState } from "../../../../shared/panelBridgeTypes";
import type { AppSessionViewModel } from "./appSessionViewModel";

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
    areaTranslateAvailable: Boolean(
      derivedState.selectedPage &&
      derivedState.selectedPageImageDataUrl &&
      !interactionBusy,
    ),
    areaTranslateSelecting: Boolean(core.regionSelection?.active),
    disableChapterApply: interactionBusy,
    editorDisabled: derivedState.selectedPageEditLocked || interactionBusy,
    selectedBlock: derivedState.selectedBlock,
    selectedBlockCount: derivedState.selectedBlockIds.length,
  };
}
