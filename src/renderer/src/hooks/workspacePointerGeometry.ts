import type {
  BBox,
  CurveLayout,
  PerspectiveTransform,
  Point,
  TranslationBlock,
} from "../../../shared/textTypes";
import type {
  DragMode,
  PerspectiveHandle,
  ResizeHandle,
} from "../lib/workspaceInteractionTypes";
type CurveHandle = "start" | "control" | "end";

export type DragState = {
  mode: DragMode;
  blockId: string;
  startX: number;
  startY: number;
  startBbox: BBox;
  startBlock: TranslationBlock;
  pointerId?: number;
};

export type PointerRect = Pick<DOMRect, "left" | "top" | "width" | "height">;

export function describeDragBbox(
  mode: DragMode,
  bbox: BBox,
  page: { width: number; height: number },
): string {
  if (isResizeDragMode(mode)) {
    const widthPx = Math.round((bbox.w / 1000) * page.width);
    const heightPx = Math.round((bbox.h / 1000) * page.height);
    return `${widthPx} × ${heightPx}px`;
  }
  const xPx = Math.round((bbox.x / 1000) * page.width);
  const yPx = Math.round((bbox.y / 1000) * page.height);
  return `${xPx}, ${yPx}`;
}

export function resolveDraggedBbox(
  drag: DragState,
  point: { clientX: number; clientY: number; shiftKey?: boolean },
  rect: PointerRect,
  page = { width: rect.width, height: rect.height },
): BBox {
  if (drag.mode === "move") {
    return resolveMovedBbox(drag, point, rect);
  }
  return resolveResizedBbox(drag, point, rect, page);
}

function resolveMovedBbox(
  drag: DragState,
  point: { clientX: number; clientY: number },
  rect: PointerRect,
): BBox {
  const dx = ((point.clientX - drag.startX) / Math.max(1, rect.width)) * 1000;
  const dy = ((point.clientY - drag.startY) / Math.max(1, rect.height)) * 1000;
  return {
    ...drag.startBbox,
    x: drag.startBbox.x + dx,
    y: drag.startBbox.y + dy,
  };
}

function resolveResizedBbox(
  drag: DragState,
  point: { clientX: number; clientY: number; shiftKey?: boolean },
  rect: PointerRect,
  page: { width: number; height: number },
): BBox {
  const handle =
    drag.mode === "resize" ? "se" : resizeHandleFromMode(drag.mode);
  if (!handle) return drag.startBbox;
  const startPx = bboxToPagePixels(drag.startBbox, page);
  const delta = pointerDeltaInBlockAxes(drag, point);
  const pageDelta = {
    x: (delta.x / Math.max(1, rect.width)) * page.width,
    y: (delta.y / Math.max(1, rect.height)) * page.height,
  };
  const edges = resizeEdges(
    startPx,
    pageDelta,
    handle,
    Boolean(point.shiftKey && isCornerResizeHandle(handle)),
  );
  const centerShift = rotatePoint(
    { x: edges.shiftX, y: edges.shiftY },
    drag.startBlock.rotationDeg ?? 0,
  );
  const center = {
    x: startPx.x + startPx.w / 2 + centerShift.x,
    y: startPx.y + startPx.h / 2 + centerShift.y,
  };
  return pagePixelsToBbox(
    {
      x: center.x - edges.width / 2,
      y: center.y - edges.height / 2,
      w: edges.width,
      h: edges.height,
    },
    page,
  );
}

function resizeEdges(
  bbox: BBox,
  delta: Point,
  handle: ResizeHandle,
  lockAspect: boolean,
): { width: number; height: number; shiftX: number; shiftY: number } {
  const { east, north, south, west } = resolveResizeDirections(handle);
  const rawWidth = resizeDimension(bbox.w, delta.x, east, west);
  const rawHeight = resizeDimension(bbox.h, delta.y, south, north);
  const locked = lockAspect
    ? resolveAspectLockedSize(bbox, rawWidth, rawHeight)
    : null;
  const width = locked?.width ?? Math.max(4, rawWidth);
  const height = locked?.height ?? Math.max(4, rawHeight);
  const usedX = resolveResizeShift(bbox.w, width, east, west);
  const usedY = resolveResizeShift(bbox.h, height, south, north);
  return {
    width,
    height,
    shiftX: usedX / 2,
    shiftY: usedY / 2,
  };
}

function resolveResizeDirections(handle: ResizeHandle): {
  east: boolean;
  north: boolean;
  south: boolean;
  west: boolean;
} {
  return {
    east: handle.includes("e"),
    north: handle.includes("n"),
    south: handle.includes("s"),
    west: handle.includes("w"),
  };
}

function resizeDimension(
  size: number,
  delta: number,
  growsAtEnd: boolean,
  growsAtStart: boolean,
): number {
  if (growsAtEnd) return size + delta;
  if (growsAtStart) return size - delta;
  return size;
}

function resolveResizeShift(
  startSize: number,
  size: number,
  growsAtEnd: boolean,
  growsAtStart: boolean,
): number {
  if (growsAtEnd) return size - startSize;
  if (growsAtStart) return startSize - size;
  return 0;
}

function resolveAspectLockedSize(
  bbox: BBox,
  rawWidth: number,
  rawHeight: number,
): { width: number; height: number } {
  const widthScale = rawWidth / Math.max(1, bbox.w);
  const heightScale = rawHeight / Math.max(1, bbox.h);
  const scale =
    Math.abs(widthScale - 1) >= Math.abs(heightScale - 1)
      ? widthScale
      : heightScale;
  const minimumScale = Math.max(
    4 / Math.max(1, bbox.w),
    4 / Math.max(1, bbox.h),
  );
  const safeScale = Math.max(minimumScale, scale);
  return { width: bbox.w * safeScale, height: bbox.h * safeScale };
}

export function resolveDraggedRotationWithSnap(
  drag: DragState,
  point: { clientX: number; clientY: number; shiftKey?: boolean },
  rect: PointerRect,
): { rotationDeg: number; snapped: boolean } {
  const center = bboxCenterClient(drag.startBbox, rect);
  const startAngle = pointAngleDeg({ x: drag.startX, y: drag.startY }, center);
  const currentAngle = pointAngleDeg(
    { x: point.clientX, y: point.clientY },
    center,
  );
  const raw = normalizeAngle(
    (drag.startBlock.rotationDeg ?? 0) + currentAngle - startAngle,
  );
  if (point.shiftKey) {
    return {
      rotationDeg: normalizeAngle(Math.round(raw / 15) * 15),
      snapped: true,
    };
  }
  const nearest45 = Math.round(raw / 45) * 45;
  const snapped = angularDistance(raw, nearest45) <= 2.5;
  return {
    rotationDeg: snapped ? normalizeAngle(nearest45) : roundAngle(raw),
    snapped,
  };
}

export function resolveDraggedPerspective(
  drag: DragState,
  point: { clientX: number; clientY: number },
  transform: PerspectiveTransform,
  rect: PointerRect,
): PerspectiveTransform {
  const handle = perspectiveHandleFromMode(drag.mode);
  if (!handle) return transform;
  const delta = pointerDeltaInBlockAxes(drag, point);
  const size = blockDisplaySize(drag.startBbox, rect);
  const local = { x: delta.x / size.width, y: delta.y / size.height };
  const corners = transform.corners.map((corner) => ({
    ...corner,
  })) as PerspectiveTransform["corners"];
  for (const index of perspectiveCornerIndexes(handle)) {
    corners[index] = {
      x: corners[index].x + local.x,
      y: corners[index].y + local.y,
    };
  }
  return { version: 1, corners };
}

export function resolveDraggedCurveLayout(
  drag: DragState,
  point: { clientX: number; clientY: number },
  layout: CurveLayout,
  rect: PointerRect,
): CurveLayout {
  const handle = curveHandleFromMode(drag.mode);
  if (!handle) return layout;
  const delta = pointerDeltaInBlockAxes(drag, point);
  const size = blockDisplaySize(drag.startBbox, rect);
  const current = layout.path[handle];
  return {
    ...layout,
    path: {
      ...layout.path,
      [handle]: {
        x: clampLocalPoint(current.x + delta.x / size.width),
        y: clampLocalPoint(current.y + delta.y / size.height),
      },
    },
  };
}

export function resolveNormalizedImagePoint(
  point: { clientX: number; clientY: number },
  rect: PointerRect,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: clampNormalized(((point.clientX - rect.left) / rect.width) * 1000),
    y: clampNormalized(((point.clientY - rect.top) / rect.height) * 1000),
  };
}

export function isResizeDragMode(mode: DragMode): boolean {
  return mode === "resize" || mode.startsWith("resize-");
}

export function describeTransformPoint(point: Point): string {
  return `${Math.round(point.x * 100)}%, ${Math.round(point.y * 100)}%`;
}

function pointerDeltaInBlockAxes(
  drag: DragState,
  point: { clientX: number; clientY: number },
): Point {
  return rotatePoint(
    { x: point.clientX - drag.startX, y: point.clientY - drag.startY },
    -(drag.startBlock.rotationDeg ?? 0),
  );
}

function perspectiveCornerIndexes(handle: PerspectiveHandle): number[] {
  const mapping: Record<PerspectiveHandle, number[]> = {
    tl: [0],
    top: [0, 1],
    tr: [1],
    right: [1, 2],
    br: [2],
    bottom: [2, 3],
    bl: [3],
    left: [3, 0],
  };
  return mapping[handle];
}

function resizeHandleFromMode(mode: DragMode): ResizeHandle | null {
  return mode.startsWith("resize-") ? (mode.slice(7) as ResizeHandle) : null;
}

function isCornerResizeHandle(handle: ResizeHandle): boolean {
  return handle.length === 2;
}

function perspectiveHandleFromMode(mode: DragMode): PerspectiveHandle | null {
  return mode.startsWith("perspective-")
    ? (mode.slice(12) as PerspectiveHandle)
    : null;
}

function curveHandleFromMode(mode: DragMode): CurveHandle | null {
  return mode.startsWith("curve-") ? (mode.slice(6) as CurveHandle) : null;
}

function blockDisplaySize(
  bbox: BBox,
  rect: PointerRect,
): { width: number; height: number } {
  return {
    width: Math.max(1, (bbox.w / 1000) * rect.width),
    height: Math.max(1, (bbox.h / 1000) * rect.height),
  };
}

function bboxCenterClient(bbox: BBox, rect: PointerRect): Point {
  return {
    x: rect.left + ((bbox.x + bbox.w / 2) / 1000) * rect.width,
    y: rect.top + ((bbox.y + bbox.h / 2) / 1000) * rect.height,
  };
}

function bboxToPagePixels(
  bbox: BBox,
  page: { width: number; height: number },
): BBox {
  return {
    x: (bbox.x * page.width) / 1000,
    y: (bbox.y * page.height) / 1000,
    w: (bbox.w * page.width) / 1000,
    h: (bbox.h * page.height) / 1000,
  };
}

function pagePixelsToBbox(
  bbox: BBox,
  page: { width: number; height: number },
): BBox {
  return {
    x: (bbox.x * 1000) / Math.max(1, page.width),
    y: (bbox.y * 1000) / Math.max(1, page.height),
    w: (bbox.w * 1000) / Math.max(1, page.width),
    h: (bbox.h * 1000) / Math.max(1, page.height),
  };
}

function rotatePoint(point: Point, angleDeg: number): Point {
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

function pointAngleDeg(point: Point, center: Point): number {
  return (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI;
}

function normalizeAngle(value: number): number {
  const normalized = ((((value + 180) % 360) + 360) % 360) - 180;
  return normalized === -180 && value > 0 ? 180 : normalized;
}

function roundAngle(value: number): number {
  return Math.round(value * 10) / 10;
}

function angularDistance(a: number, b: number): number {
  return Math.abs(normalizeAngle(a - b));
}

function clampLocalPoint(value: number): number {
  return Math.max(-1, Math.min(2, value));
}

function clampNormalized(value: number): number {
  return Math.max(0, Math.min(1000, value));
}
