import { bboxToPixels, clamp } from "../../shared/geometry";
import type { BBox, MangaPage, TranslationBlock } from "../../shared/types";

export type PixelRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export function mergeMaskIntoPage(pageMask: Uint8Array, pageWidth: number, rect: PixelRect, rectMask: Uint8Array): void {
  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      if (rectMask[y * rect.w + x]) {
        pageMask[(rect.y + y) * pageWidth + rect.x + x] = 1;
      }
    }
  }
}

export function mergeFilledRectIntoPage(pageMask: Uint8Array, pageWidth: number, rect: PixelRect): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    const start = y * pageWidth + rect.x;
    pageMask.fill(1, start, start + rect.w);
  }
}

export function mergeRects(rects: PixelRect[]): PixelRect[] {
  const sorted = [...rects].sort((left, right) => left.y - right.y || left.x - right.x);
  const merged: PixelRect[] = [];
  for (const rect of sorted) {
    const existing = merged.find((candidate) => rectsTouchOrOverlap(candidate, rect));
    if (existing) {
      const x1 = Math.min(existing.x, rect.x);
      const y1 = Math.min(existing.y, rect.y);
      const x2 = Math.max(existing.x + existing.w, rect.x + rect.w);
      const y2 = Math.max(existing.y + existing.h, rect.y + rect.h);
      existing.x = x1;
      existing.y = y1;
      existing.w = x2 - x1;
      existing.h = y2 - y1;
    } else {
      merged.push({ ...rect });
    }
  }
  return merged;
}

export function rectHasMask(mask: Uint8Array, pageWidth: number, rect: PixelRect): boolean {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      if (mask[y * pageWidth + x]) {
        return true;
      }
    }
  }
  return false;
}

export function hasUsableBbox(bbox: BBox): boolean {
  return Number.isFinite(bbox.x) && Number.isFinite(bbox.y) && Number.isFinite(bbox.w) && Number.isFinite(bbox.h) && bbox.w > 0 && bbox.h > 0;
}

export function bboxToPixelRect(bbox: BBox, page: MangaPage): PixelRect {
  const pixelBbox = bboxToPixels(bbox, page.width, page.height);
  const x1 = clamp(Math.floor(pixelBbox.x), 0, Math.max(0, page.width - 1));
  const y1 = clamp(Math.floor(pixelBbox.y), 0, Math.max(0, page.height - 1));
  const x2 = clamp(Math.ceil(pixelBbox.x + pixelBbox.w), x1 + 1, page.width);
  const y2 = clamp(Math.ceil(pixelBbox.y + pixelBbox.h), y1 + 1, page.height);
  return {
    x: x1,
    y: y1,
    w: Math.max(1, x2 - x1),
    h: Math.max(1, y2 - y1)
  };
}

export function resolvePatternBlockMarginPx(block: TranslationBlock, page: MangaPage): number {
  const rect = bboxToPixelRect(block.bbox, page);
  const byBox = Math.round(Math.max(rect.w, rect.h) * 0.12);
  const byFont = Math.round((block.fontSizePx || 20) * 0.45);
  return clamp(Math.max(8, byBox, byFont), 8, 42);
}

export function resolvePatternRegionPaddingPx(block: TranslationBlock, page: MangaPage): number {
  const rect = bboxToPixelRect(block.bbox, page);
  const byBox = Math.round(Math.max(rect.w, rect.h) * 0.04);
  const byFont = Math.round((block.fontSizePx || 20) * 0.18);
  return clamp(Math.max(2, byBox, byFont), 2, 14);
}

export function resolvePatternWindowMarginPx(block: TranslationBlock, page: MangaPage): number {
  const rect = bboxToPixelRect(block.bbox, page);
  const byBox = Math.round(Math.max(rect.w, rect.h) * 0.32);
  const byFont = Math.round((block.fontSizePx || 20) * 2.8);
  return clamp(Math.max(96, byBox, byFont), 96, 240);
}

export function resolvePatternDilationRadius(block: TranslationBlock): number {
  return clamp(Math.round((block.fontSizePx || 20) / 7), 2, 9);
}

export function expandRect(rect: PixelRect, imageWidth: number, imageHeight: number, margin: number): PixelRect {
  const x1 = clamp(rect.x - margin, 0, Math.max(0, imageWidth - 1));
  const y1 = clamp(rect.y - margin, 0, Math.max(0, imageHeight - 1));
  const x2 = clamp(rect.x + rect.w + margin, x1 + 1, imageWidth);
  const y2 = clamp(rect.y + rect.h + margin, y1 + 1, imageHeight);
  return {
    x: x1,
    y: y1,
    w: Math.max(1, x2 - x1),
    h: Math.max(1, y2 - y1)
  };
}

export function alignRectToMultiple(rect: PixelRect, imageWidth: number, imageHeight: number, multiple: number): PixelRect {
  const targetW = Math.min(imageWidth, Math.max(multiple, Math.ceil(rect.w / multiple) * multiple));
  const targetH = Math.min(imageHeight, Math.max(multiple, Math.ceil(rect.h / multiple) * multiple));
  const centerX = rect.x + rect.w / 2;
  const centerY = rect.y + rect.h / 2;
  const x = clamp(Math.round(centerX - targetW / 2), 0, Math.max(0, imageWidth - targetW));
  const y = clamp(Math.round(centerY - targetH / 2), 0, Math.max(0, imageHeight - targetH));
  return {
    x,
    y,
    w: targetW,
    h: targetH
  };
}

export function resolveFluxProcessSize(width: number, height: number, maxPixels: number, multiple: number): { width: number; height: number } {
  let scale = 1;
  if (width * height > maxPixels) {
    scale = Math.sqrt(maxPixels / Math.max(1, width * height));
  }
  const scaledWidth = Math.max(multiple, Math.round((width * scale) / multiple) * multiple);
  const scaledHeight = Math.max(multiple, Math.round((height * scale) / multiple) * multiple);
  return {
    width: scaledWidth,
    height: scaledHeight
  };
}

function rectsTouchOrOverlap(left: PixelRect, right: PixelRect): boolean {
  return left.x <= right.x + right.w && left.x + left.w >= right.x && left.y <= right.y + right.h && left.y + left.h >= right.y;
}
