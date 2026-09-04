import type { AppSessionViewModel } from "./appSessionViewModel";

export function isWorkspaceJobActive(
  derivedState: AppSessionViewModel["derivedState"],
  workspaceHistory: AppSessionViewModel["workspaceHistory"],
  libraryDrop: AppSessionViewModel["libraryDrop"],
): boolean {
  return (
    derivedState.selectedPageEditLocked ||
    workspaceHistory.busy ||
    libraryDrop.busy
  );
}

export function isChapterMutationBlocked(model: AppSessionViewModel): boolean {
  return [
    model.derivedState.jobActive || model.derivedState.selectedPageEditLocked,
    model.inpaintingBridge?.contextValue.jobActive,
    model.inpaintingActions?.actionBusy,
    model.uiState.translationFlowActive,
    model.workspaceHistory.busy,
    model.libraryDrop?.busy,
    model.operationActivity?.active,
    model.importShareModal?.importBusy,
  ].some(Boolean);
}
