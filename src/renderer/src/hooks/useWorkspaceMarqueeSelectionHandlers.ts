import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { BBox } from "../../../shared/textTypes";
import type { WorkspaceInteractionPreviewStore } from "../lib/workspaceInteractionPreview";
import {
  capturePointerSafely,
  releasePointerCaptureSafely,
} from "./workspacePointerCapture";
import {
  resolveNormalizedImagePoint,
  type PointerRect,
} from "./workspacePointerGeometry";

type ActiveMarquee = {
  additive: boolean;
  current: { x: number; y: number };
  initialIds: string[];
  pointerId: number;
  pointerRect: PointerRect;
  start: { x: number; y: number };
};

type Options = {
  active: boolean;
  getImagePointerRect: () => PointerRect | null;
  interactionPreviewStore: WorkspaceInteractionPreviewStore;
  page: MangaPage | null;
  selectedBlockId: string | null;
  selectedBlockIds: string[];
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  setSelectedBlockIds: Dispatch<SetStateAction<string[]>>;
  stageRef: RefObject<HTMLDivElement | null>;
};

export function useWorkspaceMarqueeSelectionHandlers(options: Options): {
  cancelMarqueeSelection: () => boolean;
  onMarqueePointerDown: (event: PointerEvent) => boolean;
  onMarqueePointerMove: (event: PointerEvent) => boolean;
  onMarqueePointerUp: (event: PointerEvent) => boolean;
} {
  const activeRef = useRef<ActiveMarquee | null>(null);
  return {
    cancelMarqueeSelection: useCancelMarquee(options, activeRef),
    onMarqueePointerDown: useMarqueePointerDown(options, activeRef),
    onMarqueePointerMove: useMarqueePointerMove(options, activeRef),
    onMarqueePointerUp: useMarqueePointerUp(options, activeRef),
  };
}

function useCancelMarquee(
  { interactionPreviewStore, stageRef }: Options,
  activeRef: MutableRefObject<ActiveMarquee | null>,
): () => boolean {
  return useCallback(() => {
    const active = activeRef.current;
    if (!active) return false;
    releasePointerCaptureSafely(stageRef.current, active.pointerId);
    activeRef.current = null;
    interactionPreviewStore.set({ selectionMarqueeRect: null });
    return true;
  }, [activeRef, interactionPreviewStore, stageRef]);
}

function useMarqueePointerDown(
  options: Options,
  activeRef: MutableRefObject<ActiveMarquee | null>,
): (event: PointerEvent) => boolean {
  return useCallback(
    (event) => {
      if (!options.active || !options.page || event.button !== 0) return false;
      const pointerRect = options.getImagePointerRect();
      const point = pointerRect
        ? resolveNormalizedImagePoint(event, pointerRect)
        : null;
      if (!pointerRect || !point || !options.stageRef.current) return false;
      event.preventDefault();
      activeRef.current = {
        additive: event.ctrlKey || event.metaKey,
        current: point,
        initialIds: options.selectedBlockIds,
        pointerId: event.pointerId,
        pointerRect,
        start: point,
      };
      options.interactionPreviewStore.set({
        selectionMarqueeRect: marqueeToBbox(activeRef.current),
      });
      capturePointerSafely(options.stageRef.current, event.pointerId);
      return true;
    },
    [activeRef, options],
  );
}

function useMarqueePointerMove(
  { interactionPreviewStore }: Options,
  activeRef: MutableRefObject<ActiveMarquee | null>,
): (event: PointerEvent) => boolean {
  return useCallback(
    (event) => {
      const active = activeRef.current;
      if (!active) return false;
      const point = resolveNormalizedImagePoint(event, active.pointerRect);
      if (point) active.current = point;
      interactionPreviewStore.queue({
        selectionMarqueeRect: marqueeToBbox(active),
      });
      return true;
    },
    [activeRef, interactionPreviewStore],
  );
}

function useMarqueePointerUp(
  options: Options,
  activeRef: MutableRefObject<ActiveMarquee | null>,
): (event: PointerEvent) => boolean {
  return useCallback(
    (event) => {
      const active = activeRef.current;
      if (!active) return false;
      releasePointerCaptureSafely(options.stageRef.current, active.pointerId);
      activeRef.current = null;
      options.interactionPreviewStore.set({ selectionMarqueeRect: null });
      if (event.type === "pointercancel" || !options.page) return true;
      const finalPoint = resolveNormalizedImagePoint(event, active.pointerRect);
      if (finalPoint) active.current = finalPoint;
      const marquee = marqueeToBbox(active);
      const hitIds =
        marquee.w < 3 && marquee.h < 3
          ? []
          : options.page.blocks
              .filter((block) => bboxesIntersect(marquee, block.bbox))
              .map((block) => block.id);
      const nextIds = active.additive
        ? [...new Set([...active.initialIds, ...hitIds])]
        : hitIds;
      const primaryId =
        (options.selectedBlockId && nextIds.includes(options.selectedBlockId)
          ? options.selectedBlockId
          : (hitIds[hitIds.length - 1] ?? nextIds[0])) ?? null;
      options.setSelectedBlockId(primaryId);
      options.setSelectedBlockIds(nextIds);
      return true;
    },
    [activeRef, options],
  );
}

function marqueeToBbox(selection: {
  current: { x: number; y: number };
  start: { x: number; y: number };
}): BBox {
  const x = Math.min(selection.start.x, selection.current.x);
  const y = Math.min(selection.start.y, selection.current.y);
  return {
    x,
    y,
    w: Math.abs(selection.current.x - selection.start.x),
    h: Math.abs(selection.current.y - selection.start.y),
  };
}

function bboxesIntersect(left: BBox, right: BBox): boolean {
  return (
    left.x <= right.x + right.w &&
    left.x + left.w >= right.x &&
    left.y <= right.y + right.h &&
    left.y + left.h >= right.y
  );
}
