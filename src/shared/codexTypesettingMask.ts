import type { CodexPageRegion } from "./codexTypesettingTypes";
import {
  normalizedRegionToPixelRect,
  type PageSize,
  type PixelRect,
} from "./region";
import type { BBox, Point } from "./textTypes";

/** A rejected permission plan can preserve its source without hiding infrastructure errors. */
export class CodexEraseMaskError extends Error {
  constructor(
    message: string,
    readonly protectedRegionId?: string,
  ) {
    super(message);
  }
}

/** Native pixel context shared by the crop producer and geometry consumer. */
export function codexSourceContextRect(
  region: CodexPageRegion,
  page: PageSize,
): PixelRect {
  const box = normalizedRegionToPixelRect(region.sourceBbox, page);
  const paddingX = Math.max(24, Math.ceil(box.w * 0.5));
  const paddingY = Math.max(24, Math.ceil(box.h * 0.2));
  const x = Math.max(0, box.x - paddingX);
  const y = Math.max(0, box.y - paddingY);
  return {
    x,
    y,
    w: Math.min(page.width, box.x + box.w + paddingX) - x,
    h: Math.min(page.height, box.y + box.h + paddingY) - y,
  };
}

/** Rebase context-local polygons without changing the pixels they authorize. */
export function refineCodexSourceRegion(
  region: CodexPageRegion,
  page: PageSize,
  polygons: Point[][],
): CodexPageRegion {
  const crop = codexSourceContextRect(region, page);
  const native = polygons.map((polygon) =>
    polygon.map(({ x, y }) => ({
      x: crop.x + (x * crop.w) / 1000,
      y: crop.y + (y * crop.h) / 1000,
    })),
  );
  const points = native.flat();
  if (!points.length) return { ...region, erasePolygons: [] };
  const minX = Math.min(...points.map((p) => p.x)),
    maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y)),
    maxY = Math.max(...points.map((p) => p.y));
  if (minX >= maxX || minY >= maxY) return { ...region, erasePolygons: [] };
  // One pixel of framing also tolerates normalized-to-pixel floor/ceil rounding.
  const x = Math.max(0, Math.floor(minX) - 1),
    y = Math.max(0, Math.floor(minY) - 1);
  const right = Math.min(page.width, Math.ceil(maxX) + 1),
    bottom = Math.min(page.height, Math.ceil(maxY) + 1);
  const sourceBbox: BBox = {
    x: (x / page.width) * 1000,
    y: (y / page.height) * 1000,
    w: ((right - x) / page.width) * 1000,
    h: ((bottom - y) / page.height) * 1000,
  };
  const actual = normalizedRegionToPixelRect(sourceBbox, page);
  return {
    ...region,
    sourceBbox,
    erasePolygons: native.map((polygon) =>
      polygon.map((point) => ({
        x: ((point.x - actual.x) / actual.w) * 1000,
        y: ((point.y - actual.y) / actual.h) * 1000,
      })),
    ),
  };
}

/** Permission is fixed in original source coordinates, independently of translation. */
export function createCodexEraseMask(
  region: CodexPageRegion,
  page: PageSize,
  protectedRegions: CodexPageRegion[] = [],
) {
  const bounds = normalizedRegionToPixelRect(region.sourceBbox, page);
  const data = new Uint8Array(bounds.w * bounds.h);
  for (const polygon of region.erasePolygons ?? [])
    fillEnvelope(data, bounds.w, bounds.h, polygon);
  protectCodexOcclusion(data, bounds, region, page);
  if (!data.some(Boolean))
    throw new CodexEraseMaskError(
      "안전한 글자 제거 외곽을 지정하지 못했습니다.",
    );
  for (const protectedRegion of protectedRegions) {
    const rect = normalizedRegionToPixelRect(protectedRegion.sourceBbox, page);
    if (maskIntersects(data, bounds, rect))
      throw new CodexEraseMaskError(
        "제거 외곽이 보존할 원문 영역과 겹칩니다.",
        protectedRegion.id,
      );
  }
  return { bounds, data };
}

function maskIntersects(
  data: Uint8Array,
  bounds: PixelRect,
  rect: PixelRect,
): boolean {
  const left = Math.max(bounds.x, rect.x);
  const right = Math.min(bounds.x + bounds.w, rect.x + rect.w);
  const top = Math.max(bounds.y, rect.y);
  const bottom = Math.min(bounds.y + bounds.h, rect.y + rect.h);
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      if (data[(y - bounds.y) * bounds.w + x - bounds.x]) return true;
    }
  }
  return false;
}

function fillEnvelope(
  data: Uint8Array,
  width: number,
  height: number,
  polygon: Point[],
): void {
  const points = polygon.map(({ x, y }) => ({
    x: (x / 1000) * width,
    y: (y / 1000) * height,
  }));
  for (let row = 0; row < height; row++) {
    const crossings = scanlineCrossings(points, row + 0.5);
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const left = Math.max(0, Math.ceil(crossings[index] - 0.5));
      const right = Math.min(width, Math.ceil(crossings[index + 1] - 0.5));
      if (right > left) data.fill(1, row * width + left, row * width + right);
    }
  }
}

function scanlineCrossings(points: Point[], y: number): number[] {
  const crossings: number[] = [];
  for (const [index, a] of points.entries()) {
    const b = points[(index + 1) % points.length];
    if (a.y > y === b.y > y) continue;
    crossings.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
  }
  return crossings.sort((a, b) => a - b);
}

/** Remove foreground silhouettes from both erasure and expanded feather permissions. */
export function protectCodexOcclusion(
  data: Uint8Array | Float64Array,
  bounds: PixelRect,
  region: CodexPageRegion,
  page: PageSize,
): void {
  if (!region.occlusionPolygons?.length) return;
  const protectedMask = new Uint8Array(data.length);
  for (const polygon of region.occlusionPolygons)
    fillEnvelope(
      protectedMask,
      bounds.w,
      bounds.h,
      polygon.map((point) => ({
        x: (((point.x * page.width) / 1000 - bounds.x) / bounds.w) * 1000,
        y: (((point.y * page.height) / 1000 - bounds.y) / bounds.h) * 1000,
      })),
    );
  for (let index = 0; index < data.length; index++)
    if (protectedMask[index]) data[index] = 0;
}
