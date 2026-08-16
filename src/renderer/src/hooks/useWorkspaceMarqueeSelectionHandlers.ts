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
import {
  MAX_RENDER_BBOX_COORDINATE,
  MIN_RENDER_BBOX_COORDINATE,
} from "../../../shared/renderBbox";
import type { BBox, Point } from "../../../shared/textTypes";
import { resolveBlockSelectionBoundary } from "../../../shared/geometry";
import type { WorkspaceInteractionPreviewStore } from "../lib/workspaceInteractionPreview";
import {
  capturePointerSafely,
  releasePointerCaptureSafely,
} from "./workspacePointerCapture";
import { type PointerRect } from "./workspacePointerGeometry";

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
        ? resolveMarqueeImagePoint(event, pointerRect)
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
      const point = resolveMarqueeImagePoint(event, active.pointerRect);
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
      const finalPoint = resolveMarqueeImagePoint(event, active.pointerRect);
      if (finalPoint) active.current = finalPoint;
      const marquee = marqueeToBbox(active);
      const hitIds =
        marquee.w < 3 && marquee.h < 3
          ? []
          : resolveMarqueeHitBlockIds(options.page, marquee);
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

export function resolveMarqueeHitBlockIds(
  page: MangaPage,
  marquee: BBox,
): string[] {
  const pageSize = { width: page.width, height: page.height };
  return page.blocks
    .filter((block) =>
      bboxIntersectsPolygon(
        marquee,
        resolveBlockSelectionBoundary(block, pageSize),
      ),
    )
    .map((block) => block.id);
}

/** Marquee selection may extend into the editable area outside the page. */
export function resolveMarqueeImagePoint(
  point: { clientX: number; clientY: number },
  rect: PointerRect,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: clampMarqueeCoordinate(
      ((point.clientX - rect.left) / rect.width) * 1000,
    ),
    y: clampMarqueeCoordinate(
      ((point.clientY - rect.top) / rect.height) * 1000,
    ),
  };
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

function bboxIntersectsPolygon(bbox: BBox, polygon: readonly Point[]): boolean {
  if (polygon.length < 3) return false;
  const corners = bboxCorners(bbox);
  if (polygon.some((point) => pointInBbox(point, bbox))) return true;
  if (corners.some((point) => pointInPolygon(point, polygon))) return true;
  const bboxEdges = polygonEdges(corners);
  return polygonEdges(polygon).some(([start, end]) =>
    bboxEdges.some(([boxStart, boxEnd]) =>
      segmentsIntersect(start, end, boxStart, boxEnd),
    ),
  );
}

function bboxCorners(bbox: BBox): Point[] {
  return [
    { x: bbox.x, y: bbox.y },
    { x: bbox.x + bbox.w, y: bbox.y },
    { x: bbox.x + bbox.w, y: bbox.y + bbox.h },
    { x: bbox.x, y: bbox.y + bbox.h },
  ];
}

function polygonEdges(
  polygon: readonly Point[],
): Array<readonly [Point, Point]> {
  return polygon.map((point, index) => [
    point,
    polygon[(index + 1) % polygon.length] ?? point,
  ]);
}

function pointInBbox(point: Point, bbox: BBox): boolean {
  return (
    point.x >= bbox.x &&
    point.x <= bbox.x + bbox.w &&
    point.y >= bbox.y &&
    point.y <= bbox.y + bbox.h
  );
}

function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index, index += 1
  ) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    if (!currentPoint || !previousPoint) continue;
    if (pointOnSegment(point, previousPoint, currentPoint)) return true;
    const crosses =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y) +
          currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = crossProduct(a, b, c);
  const abD = crossProduct(a, b, d);
  const cdA = crossProduct(c, d, a);
  const cdB = crossProduct(c, d, b);
  if (haveOppositeSigns(abC, abD) && haveOppositeSigns(cdA, cdB)) {
    return true;
  }
  return (
    collinearPointTouchesSegment(abC, c, a, b) ||
    collinearPointTouchesSegment(abD, d, a, b) ||
    collinearPointTouchesSegment(cdA, a, c, d) ||
    collinearPointTouchesSegment(cdB, b, c, d)
  );
}

function haveOppositeSigns(left: number, right: number): boolean {
  return (left > 0 && right < 0) || (left < 0 && right > 0);
}

function collinearPointTouchesSegment(
  cross: number,
  point: Point,
  start: Point,
  end: Point,
): boolean {
  return nearZero(cross) && pointOnSegment(point, start, end);
}

function pointOnSegment(point: Point, start: Point, end: Point): boolean {
  if (!nearZero(crossProduct(start, end, point))) return false;
  return (
    point.x >= Math.min(start.x, end.x) - Number.EPSILON &&
    point.x <= Math.max(start.x, end.x) + Number.EPSILON &&
    point.y >= Math.min(start.y, end.y) - Number.EPSILON &&
    point.y <= Math.max(start.y, end.y) + Number.EPSILON
  );
}

function crossProduct(a: Point, b: Point, point: Point): number {
  return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
}

function nearZero(value: number): boolean {
  return Math.abs(value) <= 1e-7;
}

function clampMarqueeCoordinate(value: number): number {
  if (!Number.isFinite(value)) return MIN_RENDER_BBOX_COORDINATE;
  return Math.min(
    MAX_RENDER_BBOX_COORDINATE,
    Math.max(MIN_RENDER_BBOX_COORDINATE, value),
  );
}
