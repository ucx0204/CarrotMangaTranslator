import { useCallback, useMemo, useState } from "react";
import {
  clampWorkspaceZoom,
  stepWorkspaceZoom,
  type WorkspaceFitMode,
} from "../../lib/workspaceZoom";

export function useWorkspaceZoomControls() {
  const [workspaceZoom, setWorkspaceZoom] = useState(1);
  const [workspaceFitMode, setWorkspaceFitModeState] =
    useState<WorkspaceFitMode>("contain");
  const zoomInWorkspace = useCallback(
    () => setWorkspaceZoom((zoom) => stepWorkspaceZoom(zoom, "in")),
    [],
  );
  const zoomOutWorkspace = useCallback(
    () => setWorkspaceZoom((zoom) => stepWorkspaceZoom(zoom, "out")),
    [],
  );
  const changeWorkspaceZoom = useCallback(
    (zoom: number) => setWorkspaceZoom(clampWorkspaceZoom(zoom)),
    [],
  );
  const resetWorkspaceZoom = useCallback(() => setWorkspaceZoom(1), []);
  const setWorkspaceFitMode = useCallback((fitMode: WorkspaceFitMode) => {
    setWorkspaceFitModeState(fitMode);
    setWorkspaceZoom(1);
  }, []);
  return useMemo(
    () => ({
      workspaceFitMode,
      workspaceZoom,
      changeWorkspaceZoom,
      zoomInWorkspace,
      zoomOutWorkspace,
      resetWorkspaceZoom,
      setWorkspaceFitMode,
    }),
    [
      workspaceFitMode,
      workspaceZoom,
      changeWorkspaceZoom,
      zoomInWorkspace,
      zoomOutWorkspace,
      resetWorkspaceZoom,
      setWorkspaceFitMode,
    ],
  );
}
