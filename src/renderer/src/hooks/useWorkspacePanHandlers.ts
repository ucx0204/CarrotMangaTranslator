import { useCallback, useRef, type PointerEvent, type RefObject } from "react";
import {
  capturePointerSafely,
  releasePointerCaptureSafely,
} from "./workspacePointerCapture";

type UseWorkspacePanHandlersOptions = {
  stageRef: RefObject<HTMLDivElement | null>;
  workspacePanelRef: RefObject<HTMLElement | null>;
};

type PanState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  startScrollTop: number;
};

/** Drag-to-pan for the workspace scroll container, used by the hand tool. */
export function useWorkspacePanHandlers({
  stageRef,
  workspacePanelRef,
}: UseWorkspacePanHandlersOptions): {
  onPanPointerMove: (event: PointerEvent) => boolean;
  onPanPointerUp: (event: PointerEvent) => boolean;
  startPan: (event: PointerEvent) => boolean;
} {
  const panRef = useRef<PanState | null>(null);

  const startPan = useCallback(
    (event: PointerEvent) => {
      const panel = workspacePanelRef.current;
      const stage = stageRef.current;
      if (!panel || !stage || event.button !== 0) {
        return false;
      }
      panRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startScrollLeft: panel.scrollLeft,
        startScrollTop: panel.scrollTop,
      };
      stage.style.cursor = "grabbing";
      capturePointerSafely(stage, event.pointerId);
      return true;
    },
    [stageRef, workspacePanelRef],
  );

  const onPanPointerMove = useCallback(
    (event: PointerEvent) => {
      const pan = panRef.current;
      const panel = workspacePanelRef.current;
      if (!pan || !panel) {
        return false;
      }
      panel.scrollLeft =
        pan.startScrollLeft - (event.clientX - pan.startClientX);
      panel.scrollTop = pan.startScrollTop - (event.clientY - pan.startClientY);
      return true;
    },
    [workspacePanelRef],
  );

  const onPanPointerUp = useCallback(
    (event: PointerEvent) => {
      if (!panRef.current) {
        return false;
      }
      panRef.current = null;
      releasePointerCaptureSafely(stageRef.current, event.pointerId);
      if (stageRef.current) {
        stageRef.current.style.cursor = "";
      }
      return true;
    },
    [stageRef],
  );

  return { onPanPointerMove, onPanPointerUp, startPan };
}
