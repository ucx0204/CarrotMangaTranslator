import {
  createInverseWarpEvaluator,
  createWarpEvaluator,
  isIdentityWarpTransform,
  isValidWarpTransform,
} from "../../../shared/blockTransforms";
import type { Point, WarpTransform } from "../../../shared/textTypes";

const FILTER_PADDING = 0.08;
const BOUNDS_SAMPLE_COUNT = 24;
const MAX_CACHE_ENTRIES = 48;

type WarpMapBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type WarpDisplacementMap = {
  bounds: WarpMapBounds;
  dataUrl: string;
  height: number;
  scale: number;
  width: number;
};

export type WarpDisplacementPixels = Omit<WarpDisplacementMap, "dataUrl"> & {
  pixels: Uint8ClampedArray;
};

const displacementMapCache = new Map<string, WarpDisplacementMap>();

export function resolveWarpMapRasterSize({
  height,
  preview,
  width,
}: {
  height: number;
  preview: boolean;
  width: number;
}): { width: number; height: number } {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const longest = Math.max(safeWidth, safeHeight);
  const cap = preview ? 112 : 512;
  const floor = preview ? 48 : 192;
  const longestRasterEdge = Math.min(cap, Math.max(floor, Math.ceil(longest)));
  const scale = longestRasterEdge / longest;
  return {
    width: Math.max(32, Math.round(safeWidth * scale)),
    height: Math.max(32, Math.round(safeHeight * scale)),
  };
}

export function getWarpDisplacementMap(
  transform: WarpTransform | null | undefined,
  dimensions: { width: number; height: number },
  preview: boolean,
): WarpDisplacementMap | null {
  if (
    !transform ||
    isIdentityWarpTransform(transform) ||
    !isValidWarpTransform(transform)
  ) {
    return null;
  }
  const rasterSize = resolveWarpMapRasterSize({ ...dimensions, preview });
  const key = createCacheKey(transform, rasterSize, dimensions);
  const cached = displacementMapCache.get(key);
  if (cached) {
    displacementMapCache.delete(key);
    displacementMapCache.set(key, cached);
    return cached;
  }
  const generated = createWarpDisplacementPixels(
    transform,
    rasterSize.width,
    rasterSize.height,
    dimensions,
  );
  const map = {
    bounds: generated.bounds,
    dataUrl: encodePixelsAsPngDataUrl(
      generated.pixels,
      generated.width,
      generated.height,
    ),
    height: generated.height,
    scale: generated.scale,
    width: generated.width,
  };
  displacementMapCache.set(key, map);
  trimCache();
  return map;
}

export function createWarpDisplacementPixels(
  transform: WarpTransform,
  width: number,
  height: number,
  contentDimensions: { width: number; height: number } = {
    width: 1,
    height: 1,
  },
): WarpDisplacementPixels {
  assertWarpDisplacementInputs(transform, width, height, contentDimensions);
  const bounds = resolveWarpMapBounds(transform);
  const inverse = createInverseWarpEvaluator(transform);
  const displacementX = new Float64Array(width * height);
  const displacementY = new Float64Array(width * height);
  let maximumDisplacement = 0;
  for (let row = 0; row < height; row += 1) {
    const y = bounds.top + ((row + 0.5) / height) * bounds.height;
    for (let column = 0; column < width; column += 1) {
      const x = bounds.left + ((column + 0.5) / width) * bounds.width;
      const index = row * width + column;
      const source = inverse.map({ x, y });
      const dx = (source.x - x) * contentDimensions.width;
      const dy = (source.y - y) * contentDimensions.height;
      displacementX[index] = dx;
      displacementY[index] = dy;
      maximumDisplacement = Math.max(
        maximumDisplacement,
        Math.abs(dx),
        Math.abs(dy),
      );
    }
  }

  // feDisplacementMap uses channel - 0.5, so twice the largest signed
  // displacement preserves both axes without clipping either channel.
  const scale = Math.max(1 / 65_535, maximumDisplacement * 2.002);
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < displacementX.length; index += 1) {
    const pixelOffset = index * 4;
    pixels[pixelOffset] = encodeDisplacement(displacementX[index], scale);
    pixels[pixelOffset + 1] = encodeDisplacement(displacementY[index], scale);
    pixels[pixelOffset + 2] = 128;
    pixels[pixelOffset + 3] = 255;
  }
  return { bounds, height, pixels, scale, width };
}

function assertWarpDisplacementInputs(
  transform: WarpTransform,
  width: number,
  height: number,
  contentDimensions: { width: number; height: number },
): void {
  if (!isValidWarpTransform(transform)) {
    throw new RangeError("Cannot render an invalid warp transform.");
  }
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2
  ) {
    throw new RangeError(
      "Warp displacement map dimensions must be integers greater than one.",
    );
  }
  if (
    !Number.isFinite(contentDimensions.width) ||
    !Number.isFinite(contentDimensions.height) ||
    contentDimensions.width <= 0 ||
    contentDimensions.height <= 0
  ) {
    throw new RangeError(
      "Warp content dimensions must be finite and positive.",
    );
  }
}

function resolveWarpMapBounds(transform: WarpTransform): WarpMapBounds {
  const evaluator = createWarpEvaluator(transform);
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  const include = (point: Point): void => {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  };
  for (let row = 0; row <= BOUNDS_SAMPLE_COUNT; row += 1) {
    for (let column = 0; column <= BOUNDS_SAMPLE_COUNT; column += 1) {
      include(
        evaluator.map({
          x: column / BOUNDS_SAMPLE_COUNT,
          y: row / BOUNDS_SAMPLE_COUNT,
        }),
      );
    }
  }
  const paddingX = Math.max(FILTER_PADDING, (right - left) * FILTER_PADDING);
  const paddingY = Math.max(FILTER_PADDING, (bottom - top) * FILTER_PADDING);
  return {
    left: left - paddingX,
    top: top - paddingY,
    width: Math.max(0.01, right - left + paddingX * 2),
    height: Math.max(0.01, bottom - top + paddingY * 2),
  };
}

export async function waitForWarpDisplacementMaps(
  root: ParentNode,
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = performance.now();
  let previousSources = "";
  let stableFrames = 0;
  while (performance.now() - startedAt <= timeoutMs) {
    const maps = Array.from(
      root.querySelectorAll<HTMLImageElement>("img[data-warp-map]"),
    );
    const sources = maps.map((map) => map.currentSrc || map.src).join("\n");
    const decoded = maps.every(
      (map) => map.complete && map.naturalWidth > 0 && map.naturalHeight > 0,
    );
    if (decoded && sources === previousSources) {
      stableFrames += 1;
      if (stableFrames >= 2) return;
    } else {
      stableFrames = 0;
    }
    previousSources = sources;
    await Promise.allSettled(maps.map((map) => map.decode()));
    await nextAnimationFrame();
  }
  const failed = Array.from(
    root.querySelectorAll<HTMLImageElement>("img[data-warp-map]"),
  ).filter(
    (map) => !map.complete || map.naturalWidth < 1 || map.naturalHeight < 1,
  );
  throw new Error(
    `Text warp displacement maps did not stabilize (${failed.length} undecoded).`,
  );
}

function encodePixelsAsPngDataUrl(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): string {
  if (typeof document === "undefined") {
    throw new Error("Warp maps can only be encoded in a browser renderer.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("Warp displacement map canvas is unavailable.");
  const imageData = context.createImageData(width, height);
  imageData.data.set(pixels);
  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

function encodeDisplacement(value: number, scale: number): number {
  const channel = 0.5 + value / scale;
  return Math.round(Math.max(0, Math.min(1, channel)) * 255);
}

function createCacheKey(
  transform: WarpTransform,
  rasterSize: { width: number; height: number },
  contentDimensions: { width: number; height: number },
): string {
  return `${rasterSize.width}x${rasterSize.height}:${contentDimensions.width}x${contentDimensions.height}:${transform.gridSize}:${transform.points
    .map((point) => `${point.x},${point.y}`)
    .join(";")}`;
}

function trimCache(): void {
  while (displacementMapCache.size > MAX_CACHE_ENTRIES) {
    const oldest = displacementMapCache.keys().next().value as
      | string
      | undefined;
    if (!oldest) break;
    displacementMapCache.delete(oldest);
  }
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
