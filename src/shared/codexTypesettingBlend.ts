import type { CodexPageRegion } from "./codexTypesettingTypes";
import {
  createCodexEraseMask,
  protectCodexOcclusion,
  CodexEraseMaskError,
} from "./codexTypesettingMask";
import {
  normalizedRegionToPixelRect,
  type PageSize,
  type PixelRect,
} from "./region";

function blendRadii(page: PageSize) {
  // Native-width scaled starting point from the user-approved 836px/844px crops.
  // The separate visual background stage must still approve every actual splice.
  const core = Math.max(2, Math.min(16, Math.round(page.width / 100)));
  return { core, feather: Math.max(1, Math.round(core / 2)) };
}

/** Conservative restoration footprint, including the entire possible outer blend. */
export function codexBackgroundSupportRect(
  region: CodexPageRegion,
  page: PageSize,
): PixelRect {
  const box = normalizedRegionToPixelRect(region.sourceBbox, page);
  if (region.background !== "artwork" || region.action === "keep") return box;
  const { core, feather } = blendRadii(page);
  const padding = core + feather;
  const x = Math.max(0, box.x - padding),
    y = Math.max(0, box.y - padding);
  return {
    x,
    y,
    w: Math.min(page.width, box.x + box.w + padding) - x,
    h: Math.min(page.height, box.y + box.h + padding) - y,
  };
}

/** Dilate the actual glyph permission; feather only outside that opaque core. */
export function createCodexBackgroundBlend(
  region: CodexPageRegion,
  page: PageSize,
  protectedRegions: CodexPageRegion[],
) {
  const mask = createCodexEraseMask(region, page, protectedRegions);
  const envelope = maskEnvelope(mask);
  const bounds = codexBackgroundSupportRect(region, page);
  const { core, feather } = blendRadii(page);
  const radius = core + feather;
  const horizontal = horizontalMaskDistances(mask, bounds, radius);
  const data = new Float64Array(bounds.w * bounds.h);
  for (let y = 0; y < bounds.h; y++) {
    for (let x = 0; x < bounds.w; x++) {
      const distance = distanceToContour(horizontal, bounds, x, y, radius);
      const t = Math.max(0, Math.min(1, (distance - core) / feather));
      data[y * bounds.w + x] = 1 - t * t * (3 - 2 * t);
    }
  }
  protectCodexOcclusion(data, bounds, region, page);
  protectBlend(data, bounds, protectedRegions, page);
  return { bounds, data, coreRadius: core, featherRadius: feather, envelope };
}

// Exact Euclidean distance, truncated to the bounded outer support (at most 24px).
// Unlike a box envelope this preserves spaces between disconnected glyphs.
export function horizontalMaskDistances(
  mask: { bounds: PixelRect; data: Uint8Array },
  bounds: PixelRect,
  radius: number,
) {
  const distances = new Float64Array(bounds.w * bounds.h).fill(radius * radius);
  for (let y = 0; y < mask.bounds.h; y++) {
    const row =
      (y + mask.bounds.y - bounds.y) * bounds.w + mask.bounds.x - bounds.x;
    for (let x = 0; x < mask.bounds.w; x++)
      if (mask.data[y * mask.bounds.w + x]) distances[row + x] = 0;
  }
  for (let y = 0; y < bounds.h; y++) {
    let distance = radius;
    const row = y * bounds.w;
    for (let x = 0; x < bounds.w; x++) {
      distance = distances[row + x] === 0 ? 0 : Math.min(radius, distance + 1);
      distances[row + x] = distance * distance;
    }
    distance = radius;
    for (let x = bounds.w - 1; x >= 0; x--) {
      distance = distances[row + x] === 0 ? 0 : Math.min(radius, distance + 1);
      distances[row + x] = Math.min(distances[row + x], distance * distance);
    }
  }
  return distances;
}

export function distanceToContour(
  horizontal: Float64Array,
  bounds: PixelRect,
  x: number,
  y: number,
  radius: number,
) {
  let squared = radius * radius;
  for (
    let row = Math.max(0, y - radius);
    row <= Math.min(bounds.h - 1, y + radius);
    row++
  )
    squared = Math.min(
      squared,
      horizontal[row * bounds.w + x] + (row - y) ** 2,
    );
  return Math.sqrt(squared);
}

function maskEnvelope(mask: ReturnType<typeof createCodexEraseMask>) {
  let x = mask.bounds.w,
    y = mask.bounds.h,
    right = -1,
    bottom = -1;
  for (let at = 0; at < mask.data.length; at++) {
    if (!mask.data[at]) continue;
    x = Math.min(x, at % mask.bounds.w);
    y = Math.min(y, Math.floor(at / mask.bounds.w));
    right = Math.max(right, at % mask.bounds.w);
    bottom = Math.max(bottom, Math.floor(at / mask.bounds.w));
  }
  return {
    x: x + mask.bounds.x,
    y: y + mask.bounds.y,
    right: right + mask.bounds.x,
    bottom: bottom + mask.bounds.y,
  };
}

function protectBlend(
  data: Float64Array,
  bounds: PixelRect,
  regions: CodexPageRegion[],
  page: PageSize,
) {
  for (const region of regions) {
    const box = normalizedRegionToPixelRect(region.sourceBbox, page);
    for (
      let y = Math.max(bounds.y, box.y);
      y < Math.min(bounds.y + bounds.h, box.y + box.h);
      y++
    ) {
      const left = Math.max(bounds.x, box.x),
        right = Math.min(bounds.x + bounds.w, box.x + box.w);
      if (right <= left) continue;
      const start = (y - bounds.y) * bounds.w + left - bounds.x;
      if (data.subarray(start, start + right - left).some(Boolean))
        throw new CodexEraseMaskError(
          "확장된 배경 접합이 보존할 원문 영역과 겹칩니다.",
          region.id,
        );
    }
  }
}
