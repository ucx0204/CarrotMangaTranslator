import type { BBox, TranslationBlock } from "./textTypes";

type PageSize = Readonly<{ width: number; height: number }>;
type BBoxSpace = NonNullable<TranslationBlock["bboxSpace"]>;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function clampBbox(bbox: BBox): BBox {
  const x = clamp(bbox.x, 0, 999);
  const y = clamp(bbox.y, 0, 999);
  const w = clamp(bbox.w, 1, 1000 - x);
  const h = clamp(bbox.h, 1, 1000 - y);
  return { x, y, w, h };
}

export function pixelsToBbox(bbox: BBox, width: number, height: number): BBox {
  return clampBbox({
    x: (bbox.x / Math.max(1, width)) * 1000,
    y: (bbox.y / Math.max(1, height)) * 1000,
    w: (bbox.w / Math.max(1, width)) * 1000,
    h: (bbox.h / Math.max(1, height)) * 1000,
  });
}

export function normalizeBboxTo1000(
  bbox: BBox,
  pageSize?: PageSize | null,
  bboxSpace?: BBoxSpace,
): BBox {
  if (bboxSpace === "pixels" && pageSize) {
    return pixelsToBbox(bbox, pageSize.width, pageSize.height);
  }
  return clampBbox(bbox);
}
