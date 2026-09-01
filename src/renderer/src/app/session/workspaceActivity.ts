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
