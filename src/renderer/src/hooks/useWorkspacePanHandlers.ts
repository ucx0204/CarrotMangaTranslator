import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent,
  type RefObject,
} from "react";
import {
  capturePointerSafely,
  releasePointerCaptureSafely,
} from "./workspacePointerCapture";

type UseWorkspacePanHandlersOptions = {
  active?: boolean;
  stageRef: RefObject<HTMLDivElement | null>;
  workspacePanelRef: RefObject<HTMLElement | null>;
};

type PanState = {
  frameId: number | null;
  latestClientX: number;
  latestClientY: number;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  startScrollTop: number;
};

/** Drag-to-pan for the workspace scroll container, used by the hand tool. */
export function useWorkspacePanHandlers({
  active = true,
  stageRef,
  workspacePanelRef,
}: UseWorkspacePanHandlersOptions): {
  onPanPointerMove: (event: PointerEvent) => boolean;
  onPanPointerUp: (event: PointerEvent) => boolean;
  startPan: (event: PointerEvent) => boolean;
} {
  const panRef = useRef<PanState | null>(null);
  usePanCleanup(panRef, stageRef);

  const startPan = useCallback(
    (event: PointerEvent) => {
      const panel = workspacePanelRef.current;
      const stage = stageRef.current;
      if (!panel || !stage || event.button !== 0) {
        return false;
      }
      panRef.current = {
        frameId: null,
        latestClientX: event.clientX,
        latestClientY: event.clientY,
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
      pan.latestClientX = event.clientX;
      pan.latestClientY = event.clientY;
      if (pan.frameId === null) {
        pan.frameId = requestAnimationFrame(() => {
          const active = panRef.current;
          if (!active) return;
          active.frameId = null;
          applyPanPosition(active, workspacePanelRef.current);
        });
      }
      return true;
    },
    [workspacePanelRef],
  );

  const finishPan = useFinishPan(panRef, stageRef, workspacePanelRef);

  const onPanPointerUp = useCallback(
    (event: PointerEvent) => {
      const pan = panRef.current;
      if (!pan) return false;
      pan.latestClientX = event.clientX;
      pan.latestClientY = event.clientY;
      return finishPan();
    },
    [finishPan],
  );

  useLayoutEffect(() => {
    if (!active) finishPan();
  }, [active, finishPan]);

  return { onPanPointerMove, onPanPointerUp, startPan };
}

function useFinishPan(
  panRef: RefObject<PanState | null>,
  stageRef: RefObject<HTMLDivElement | null>,
  workspacePanelRef: RefObject<HTMLElement | null>,
): () => boolean {
  return useCallback(() => {
    const pan = panRef.current;
    if (!pan) return false;
    if (pan.frameId !== null) cancelAnimationFrame(pan.frameId);
    applyPanPosition(pan, workspacePanelRef.current);
    panRef.current = null;
    releasePointerCaptureSafely(stageRef.current, pan.pointerId);
    if (stageRef.current) stageRef.current.style.cursor = "";
    return true;
  }, [panRef, stageRef, workspacePanelRef]);
}

function usePanCleanup(
  panRef: RefObject<PanState | null>,
  stageRef: RefObject<HTMLDivElement | null>,
): void {
  useEffect(
    () => () => {
      const pan = panRef.current;
      if (pan?.frameId !== null && pan?.frameId !== undefined) {
        cancelAnimationFrame(pan.frameId);
      }
      if (pan) {
        releasePointerCaptureSafely(stageRef.current, pan.pointerId);
      }
      if (stageRef.current) stageRef.current.style.cursor = "";
      panRef.current = null;
    },
    [panRef, stageRef],
  );
}

function applyPanPosition(pan: PanState, panel: HTMLElement | null): void {
  if (!panel) return;
  panel.scrollLeft =
    pan.startScrollLeft - (pan.latestClientX - pan.startClientX);
  panel.scrollTop = pan.startScrollTop - (pan.latestClientY - pan.startClientY);
}
