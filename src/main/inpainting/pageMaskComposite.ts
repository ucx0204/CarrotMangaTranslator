import { projectWindowMask } from "./bubbleLayoutConstraintMask";
import type { InpaintingWindowMask } from "./inpaintingEngine";
import { expandRect } from "./maskGeometry";

export function compositeGeneratedPageWithWindowMasks(options: {
  bitmap: Buffer;
  compositeConstraints?: Array<InpaintingWindowMask | null>;
  compositeFeatherPx?: number[];
  compositeMasks: InpaintingWindowMask[];
  generated: Buffer;
  height: number;
  width: number;
}): void {
  assertCompositeOptions(options);
  const alpha = new Float32Array(options.width * options.height);
  for (const [index, core] of options.compositeMasks.entries()) {
    accumulateWindowAlpha(alpha, options, core, index);
  }
  blendGeneratedPage(options.bitmap, options.generated, alpha);
}

function accumulateWindowAlpha(
  pageAlpha: Float32Array,
  options: Parameters<typeof compositeGeneratedPageWithWindowMasks>[0],
  core: InpaintingWindowMask,
  index: number,
): void {
  const prepared = prepareWindowComposite(options, core, index);
  accumulateProjectedAlpha(pageAlpha, options.width, prepared);
}

function prepareWindowComposite(
  options: Parameters<typeof compositeGeneratedPageWithWindowMasks>[0],
  core: InpaintingWindowMask,
  index: number,
) {
  const featherPx = Math.max(
    0,
    Math.round(options.compositeFeatherPx?.[index] ?? 0),
  );
  const constraint = options.compositeConstraints?.[index] ?? null;
  const bounds =
    constraint?.bounds ??
    expandRect(core.bounds, options.width, options.height, featherPx);
  const localCore = projectWindowMask(core, bounds);
  const localConstraint = constraint
    ? projectWindowMask(constraint, bounds)
    : null;
  return {
    bounds,
    distances: distanceToMask(localCore, bounds.w, bounds.h),
    featherPx,
    localConstraint,
    localCore,
  };
}

function accumulateProjectedAlpha(
  pageAlpha: Float32Array,
  pageWidth: number,
  prepared: ReturnType<typeof prepareWindowComposite>,
): void {
  const { bounds, distances, featherPx, localConstraint, localCore } = prepared;
  for (let localY = 0; localY < bounds.h; localY += 1) {
    for (let localX = 0; localX < bounds.w; localX += 1) {
      const localIndex = localY * bounds.w + localX;
      if (localConstraint && !localConstraint[localIndex]) continue;
      const value = resolveFeatherAlpha(
        localCore[localIndex] ?? 0,
        distances[localIndex] ?? Number.POSITIVE_INFINITY,
        featherPx,
      );
      if (value <= 0) continue;
      const pageIndex = (bounds.y + localY) * pageWidth + bounds.x + localX;
      pageAlpha[pageIndex] = Math.max(pageAlpha[pageIndex] ?? 0, value);
    }
  }
}

function resolveFeatherAlpha(
  core: number,
  distance: number,
  featherPx: number,
): number {
  if (core) return 1;
  if (featherPx <= 0 || !Number.isFinite(distance)) return 0;
  return clampUnit(1 - distance / featherPx);
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function distanceToMask(
  mask: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const far = width + height + 1;
  const distances = Float32Array.from(mask, (value) => (value ? 0 : far));
  runDistancePass(distances, width, height, false);
  runDistancePass(distances, width, height, true);
  return distances;
}

function runDistancePass(
  distances: Float32Array,
  width: number,
  height: number,
  reverse: boolean,
): void {
  const yStart = reverse ? height - 1 : 0;
  const yEnd = reverse ? -1 : height;
  const yStep = reverse ? -1 : 1;
  const xStart = reverse ? width - 1 : 0;
  const xEnd = reverse ? -1 : width;
  const xStep = reverse ? -1 : 1;
  for (let y = yStart; y !== yEnd; y += yStep) {
    for (let x = xStart; x !== xEnd; x += xStep) {
      updateDistanceAt(distances, width, height, x, y, reverse);
    }
  }
}

function updateDistanceAt(
  distances: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  reverse: boolean,
): void {
  const index = y * width + x;
  const step = reverse ? 1 : -1;
  let distance = distances[index] ?? Number.POSITIVE_INFINITY;
  distance = Math.min(
    distance,
    readDistance(distances, width, height, x + step, y) + 1,
    readDistance(distances, width, height, x, y + step) + 1,
    readDistance(distances, width, height, x + step, y + step) + Math.SQRT2,
    readDistance(distances, width, height, x - step, y + step) + Math.SQRT2,
  );
  distances[index] = distance;
}

function readDistance(
  distances: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return Number.POSITIVE_INFINITY;
  }
  return distances[y * width + x] ?? Number.POSITIVE_INFINITY;
}

function blendGeneratedPage(
  bitmap: Buffer,
  generated: Buffer,
  alpha: Float32Array,
): void {
  for (let index = 0; index < alpha.length; index += 1) {
    const value = alpha[index] ?? 0;
    if (value <= 0) continue;
    const offset = index * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      bitmap[offset + channel] = Math.round(
        (bitmap[offset + channel] ?? 0) * (1 - value) +
          (generated[offset + channel] ?? 0) * value,
      );
    }
    bitmap[offset + 3] = 255;
  }
}

function assertCompositeOptions(options: {
  bitmap: Buffer;
  compositeConstraints?: Array<InpaintingWindowMask | null>;
  compositeFeatherPx?: number[];
  compositeMasks: InpaintingWindowMask[];
  generated: Buffer;
  height: number;
  width: number;
}): void {
  const expectedBytes = options.width * options.height * 4;
  if (
    options.bitmap.length < expectedBytes ||
    options.generated.length < expectedBytes
  ) {
    throw new Error("Generated-page composite bitmap size drifted.");
  }
  if (
    (options.compositeConstraints &&
      options.compositeConstraints.length !== options.compositeMasks.length) ||
    (options.compositeFeatherPx &&
      options.compositeFeatherPx.length !== options.compositeMasks.length)
  ) {
    throw new Error("Generated-page composite mask inventory drifted.");
  }
}
