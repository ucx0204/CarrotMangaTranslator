import type { BBox } from "../../../shared/textTypes";

export type DragMode = "move" | "resize";

export type DragState = {
  mode: DragMode;
  blockId: string;
  startX: number;
  startY: number;
  startBbox: BBox;
};

export type DragHud = {
  mode: DragMode;
  label: string;
};

export type PointerRect = Pick<DOMRect, "left" | "top" | "width" | "height">;

export function describeDragBbox(
  mode: DragMode,
  bbox: BBox,
  page: { width: number; height: number },
): string {
  if (mode === "resize") {
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
  point: { clientX: number; clientY: number },
  rect: PointerRect,
): BBox {
  const dx = ((point.clientX - drag.startX) / Math.max(1, rect.width)) * 1000;
  const dy = ((point.clientY - drag.startY) / Math.max(1, rect.height)) * 1000;
  return drag.mode === "move"
    ? {
        ...drag.startBbox,
        x: drag.startBbox.x + dx,
        y: drag.startBbox.y + dy,
      }
    : {
        ...drag.startBbox,
        w: drag.startBbox.w + dx,
        h: drag.startBbox.h + dy,
      };
}

export function resolveNormalizedImagePoint(
  point: { clientX: number; clientY: number },
  rect: PointerRect,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return {
    x: clampNormalized(((point.clientX - rect.left) / rect.width) * 1000),
    y: clampNormalized(((point.clientY - rect.top) / rect.height) * 1000),
  };
}

function clampNormalized(value: number): number {
  return Math.max(0, Math.min(1000, value));
}
