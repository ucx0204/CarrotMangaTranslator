import { useEffect, type RefObject } from "react";

type UseWorkspaceWheelZoomOptions = {
  workspacePanelRef: RefObject<HTMLElement | null>;
  zoomIn: () => void;
  zoomOut: () => void;
};

/**
 * Ctrl+wheel (and trackpad pinch, which browsers report as ctrl+wheel) zooms
 * the workspace image. Registered non-passive so the browser-native page zoom
 * can be prevented.
 */
export function useWorkspaceWheelZoom({
  workspacePanelRef,
  zoomIn,
  zoomOut,
}: UseWorkspaceWheelZoomOptions): void {
  useEffect(() => {
    const panel = workspacePanelRef.current;
    if (!panel) {
      return;
    }
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) {
        return;
      }
      event.preventDefault();
      if (event.deltaY < 0) {
        zoomIn();
      } else if (event.deltaY > 0) {
        zoomOut();
      }
    };
    panel.addEventListener("wheel", onWheel, { passive: false });
    return () => panel.removeEventListener("wheel", onWheel);
  }, [workspacePanelRef, zoomIn, zoomOut]);
}
