import { useEffect, type RefObject } from "react";
import { useEventCallback } from "./useEventCallback";

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
  const invokeZoomIn = useEventCallback(zoomIn);
  const invokeZoomOut = useEventCallback(zoomOut);
  useEffect(() => {
    const panel = workspacePanelRef.current;
    if (!panel) {
      return;
    }
    let frameId: number | null = null;
    let pendingDelta = 0;
    const applyZoom = (): void => {
      frameId = null;
      const delta = pendingDelta;
      pendingDelta = 0;
      if (delta < 0) {
        invokeZoomIn();
      } else if (delta > 0) {
        invokeZoomOut();
      }
    };
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) {
        return;
      }
      event.preventDefault();
      pendingDelta += event.deltaY;
      if (frameId === null) {
        frameId = requestAnimationFrame(applyZoom);
      }
    };
    panel.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      panel.removeEventListener("wheel", onWheel);
    };
  }, [invokeZoomIn, invokeZoomOut, workspacePanelRef]);
}
