import type { BBox } from "./textTypes";

/**
 * Manual text placement is intentionally wider than the 0..1000 source-image
 * coordinate space. The hard limits protect persisted/IPC data from runaway
 * geometry while still allowing a text box up to four page extents wide/high.
 */
export const MIN_RENDER_BBOX_COORDINATE = -4000;
export const MAX_RENDER_BBOX_COORDINATE = 5000;
export const MAX_RENDER_BBOX_SIZE = 4000;
export const MIN_VISIBLE_RENDER_BBOX_EXTENT = 8;

export function clampRenderBbox(bbox: BBox): BBox {
  return {
    x: clampFinite(
      bbox.x,
      MIN_RENDER_BBOX_COORDINATE,
      MAX_RENDER_BBOX_COORDINATE,
    ),
    y: clampFinite(
      bbox.y,
      MIN_RENDER_BBOX_COORDINATE,
      MAX_RENDER_BBOX_COORDINATE,
    ),
    w: clampFinite(bbox.w, 1, MAX_RENDER_BBOX_SIZE),
    h: clampFinite(bbox.h, 1, MAX_RENDER_BBOX_SIZE),
  };
}

function clampFinite(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
