import type { BBox } from "./types";
import { clampBbox } from "./geometry";

export type PageSize = {
  width: number;
  height: number;
};

export type PixelRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export function normalizedRegionToPixelRect(bbox: BBox, pageSize: PageSize, minSizePx = 2): PixelRect {
  const safe = clampBbox(bbox);
  const width = Math.max(1, pageSize.width);
  const height = Math.max(1, pageSize.height);
  const x = Math.max(0, Math.min(width - 1, Math.floor((safe.x / 1000) * width)));
  const y = Math.max(0, Math.min(height - 1, Math.floor((safe.y / 1000) * height)));
  const rawW = Math.ceil((safe.w / 1000) * width);
  const rawH = Math.ceil((safe.h / 1000) * height);
  const w = Math.max(minSizePx, Math.min(width - x, rawW));
  const h = Math.max(minSizePx, Math.min(height - y, rawH));
  return {
    x,
    y,
    w: Math.max(1, Math.min(width - x, w)),
    h: Math.max(1, Math.min(height - y, h))
  };
}

export function mapCropNormalizedBboxToPageBbox(cropRect: PixelRect, pageSize: PageSize, cropBbox: BBox): BBox {
  const safe = clampBbox(cropBbox);
  const pageWidth = Math.max(1, pageSize.width);
  const pageHeight = Math.max(1, pageSize.height);
  const xPx = cropRect.x + (safe.x / 1000) * cropRect.w;
  const yPx = cropRect.y + (safe.y / 1000) * cropRect.h;
  const wPx = (safe.w / 1000) * cropRect.w;
  const hPx = (safe.h / 1000) * cropRect.h;
  return clampBbox({
    x: Math.round((xPx / pageWidth) * 1000),
    y: Math.round((yPx / pageHeight) * 1000),
    w: Math.round((wPx / pageWidth) * 1000),
    h: Math.round((hPx / pageHeight) * 1000)
  });
}

export function isUsableRegionBbox(bbox: BBox, minNormalizedSize = 8): boolean {
  const safe = clampBbox(bbox);
  return safe.w >= minNormalizedSize && safe.h >= minNormalizedSize;
}
