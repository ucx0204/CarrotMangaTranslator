import type { AppSessionViewProps } from "./AppSessionView";
import type { AppSessionViewModel } from "./appSessionViewModel";

export function createWorkspaceViewProps(
  uiState: AppSessionViewModel["uiState"],
): Pick<
  AppSessionViewProps["workspaceProps"],
  | "onChangeWorkspaceFitMode"
  | "onResetWorkspaceZoom"
  | "onZoomInWorkspace"
  | "onZoomOutWorkspace"
  | "showBlockChrome"
  | "showTextBlocks"
  | "workspaceFitMode"
  | "workspaceZoom"
> {
  return {
    onChangeWorkspaceFitMode: uiState.setWorkspaceFitMode,
    onResetWorkspaceZoom: uiState.resetWorkspaceZoom,
    onZoomInWorkspace: uiState.zoomInWorkspace,
    onZoomOutWorkspace: uiState.zoomOutWorkspace,
    showBlockChrome: uiState.showBlockChrome,
    showTextBlocks: uiState.showTextBlocks,
    workspaceFitMode: uiState.workspaceFitMode,
    workspaceZoom: uiState.workspaceZoom,
  };
}
