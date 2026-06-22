import { clamp } from "../../shared/geometry";
import type { PixelRect } from "./maskGeometry";
import { readRgb } from "./rasterMasks";

type Rgb = ReturnType<typeof readRgb>;

export function buildPatternTextMask(
  bitmap: Buffer,
  width: number,
  _height: number,
  rect: PixelRect,
  dilationRadius: number,
): { mask: Uint8Array; count: number } {
  const sample = collectPatternTextSamples(bitmap, width, rect);
  if (sample.luminanceSamples.length < 8) {
    return emptyPatternMask(sample.pixelCount);
  }

  const thresholds = resolvePatternTextThresholds(sample);
  const initial = buildInitialPatternMask(
    bitmap,
    width,
    rect,
    sample,
    thresholds,
  );
  const coverage = initial.count / Math.max(1, sample.pixelCount);
  if (initial.count === 0 || coverage < 0.0015 || coverage > 0.42) {
    return emptyPatternMask(sample.pixelCount);
  }

  const connected = removeTinyMaskComponents(
    initial.mask,
    rect.w,
    rect.h,
    Math.max(4, Math.round(sample.pixelCount * 0.00035)),
  );
  const dilated = dilateMask(connected.mask, rect.w, rect.h, dilationRadius);
  const count = countMaskPixels(dilated);
  const finalCoverage = count / Math.max(1, sample.pixelCount);
  if (connected.count === 0 || finalCoverage > 0.52) {
    return emptyPatternMask(sample.pixelCount);
  }
  return { mask: dilated, count };
}

type PatternTextSample = {
  blueSamples: number[];
  greenSamples: number[];
  luminances: Float32Array;
  luminanceSamples: number[];
  pixelCount: number;
  redSamples: number[];
};

type PatternTextThresholds = {
  brightCutoff: number;
  darkCutoff: number;
  edgeThreshold: number;
  medianColor: Rgb;
};

function collectPatternTextSamples(
  bitmap: Buffer,
  width: number,
  rect: PixelRect,
): PatternTextSample {
  const pixelCount = rect.w * rect.h;
  const sample: PatternTextSample = {
    blueSamples: [],
    greenSamples: [],
    luminances: new Float32Array(pixelCount),
    luminanceSamples: [],
    pixelCount,
    redSamples: [],
  };
  const sampleStep = Math.max(1, Math.floor(Math.max(rect.w, rect.h) / 140));
  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      collectPatternTextSamplePixel(bitmap, width, rect, sample, {
        sampleStep,
        x,
        y,
      });
    }
  }
  return sample;
}

function collectPatternTextSamplePixel(
  bitmap: Buffer,
  width: number,
  rect: PixelRect,
  sample: PatternTextSample,
  point: { sampleStep: number; x: number; y: number },
): void {
  const color = readRgb(bitmap, width, rect.x + point.x, rect.y + point.y);
  const lum = luminance(color);
  sample.luminances[point.y * rect.w + point.x] = lum;
  if (point.x % point.sampleStep !== 0 || point.y % point.sampleStep !== 0) {
    return;
  }
  sample.luminanceSamples.push(lum);
  sample.redSamples.push(color.r);
  sample.greenSamples.push(color.g);
  sample.blueSamples.push(color.b);
}

function resolvePatternTextThresholds(
  sample: PatternTextSample,
): PatternTextThresholds {
  const sortedLum = sample.luminanceSamples.sort((left, right) => left - right);
  const p12 = percentile(sortedLum, 0.12);
  const p25 = percentile(sortedLum, 0.25);
  const p50 = percentile(sortedLum, 0.5);
  const p75 = percentile(sortedLum, 0.75);
  const p88 = percentile(sortedLum, 0.88);
  return {
    brightCutoff: Math.max(p50 + 24, p75 - 6),
    darkCutoff: Math.min(p50 - 18, p25 + 10),
    edgeThreshold: Math.max(18, Math.min(38, (p88 - p12) * 0.2)),
    medianColor: {
      r: median(sample.redSamples),
      g: median(sample.greenSamples),
      b: median(sample.blueSamples),
    },
  };
}

function buildInitialPatternMask(
  bitmap: Buffer,
  width: number,
  rect: PixelRect,
  sample: PatternTextSample,
  thresholds: PatternTextThresholds,
): { mask: Uint8Array; count: number } {
  const mask = new Uint8Array(sample.pixelCount);
  let count = 0;
  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      if (isPatternTextPixel(bitmap, width, rect, sample, thresholds, x, y)) {
        mask[y * rect.w + x] = 1;
        count += 1;
      }
    }
  }
  return { mask, count };
}

function isPatternTextPixel(
  bitmap: Buffer,
  width: number,
  rect: PixelRect,
  sample: PatternTextSample,
  thresholds: PatternTextThresholds,
  x: number,
  y: number,
): boolean {
  const index = y * rect.w + x;
  const lum = sample.luminances[index] ?? 0;
  const color = readRgb(bitmap, width, rect.x + x, rect.y + y);
  const localEdge = localLuminanceEdge(sample.luminances, rect.w, rect.h, x, y);
  const colorOutlier = colorDistance(color, thresholds.medianColor) >= 34;
  const darkStroke = lum <= thresholds.darkCutoff;
  const brightStroke =
    lum >= thresholds.brightCutoff && localEdge >= thresholds.edgeThreshold;
  return (
    (darkStroke || brightStroke) &&
    (localEdge >= thresholds.edgeThreshold || colorOutlier)
  );
}

function emptyPatternMask(pixelCount: number): { mask: Uint8Array; count: 0 } {
  return { mask: new Uint8Array(pixelCount), count: 0 };
}

function countMaskPixels(mask: Uint8Array): number {
  let count = 0;
  for (const value of mask) {
    if (value) {
      count += 1;
    }
  }
  return count;
}

function dilateMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  if (radius <= 0) {
    return mask;
  }
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      dilateMaskPixel(mask, output, width, height, radius, x, y);
    }
  }
  return output;
}

function dilateMaskPixel(
  mask: Uint8Array,
  output: Uint8Array,
  width: number,
  height: number,
  radius: number,
  x: number,
  y: number,
): void {
  if (!mask[y * width + x]) {
    return;
  }
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const nx = x + dx;
      const ny = y + dy;
      if (
        dx * dx + dy * dy <= radius * radius &&
        isInside(nx, ny, width, height)
      ) {
        output[ny * width + nx] = 1;
      }
    }
  }
}

function removeTinyMaskComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea: number,
): { mask: Uint8Array; count: number } {
  const output = new Uint8Array(mask.length);
  const visited = new Uint8Array(mask.length);
  const queue: number[] = [];
  let keptCount = 0;

  for (let index = 0; index < mask.length; index += 1) {
    const component = collectMaskComponent(
      mask,
      visited,
      queue,
      width,
      height,
      index,
    );
    if (component.length < minArea) {
      continue;
    }
    for (const pixel of component) {
      output[pixel] = 1;
    }
    keptCount += component.length;
  }

  return { mask: output, count: keptCount };
}

function collectMaskComponent(
  mask: Uint8Array,
  visited: Uint8Array,
  queue: number[],
  width: number,
  height: number,
  startIndex: number,
): number[] {
  if (!mask[startIndex] || visited[startIndex]) {
    return [];
  }
  queue.length = 0;
  const component: number[] = [];
  visited[startIndex] = 1;
  queue.push(startIndex);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    component.push(current);
    const x = current % width;
    const y = Math.floor(current / width);
    enqueueMaskNeighbors(mask, visited, queue, x, y, width, height);
  }
  return component;
}

function enqueueMaskNeighbors(
  mask: Uint8Array,
  visited: Uint8Array,
  queue: number[],
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  for (const neighbor of maskNeighbors(x, y, width, height)) {
    if (!mask[neighbor] || visited[neighbor]) {
      continue;
    }
    visited[neighbor] = 1;
    queue.push(neighbor);
  }
}

function maskNeighbors(
  x: number,
  y: number,
  width: number,
  height: number,
): number[] {
  const neighbors: number[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const nx = x + dx;
      const ny = y + dy;
      if ((dx !== 0 || dy !== 0) && isInside(nx, ny, width, height)) {
        neighbors.push(ny * width + nx);
      }
    }
  }
  return neighbors;
}

function localLuminanceEdge(
  luminances: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const center = luminances[y * width + x] ?? 0;
  let maxDiff = 0;
  for (const neighbor of maskNeighbors(x, y, width, height)) {
    maxDiff = Math.max(
      maxDiff,
      Math.abs(center - (luminances[neighbor] ?? center)),
    );
  }
  return maxDiff;
}

function isInside(
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  return x >= 0 && x < width && y >= 0 && y < height;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0);
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = clamp(
    Math.round((sortedValues.length - 1) * ratio),
    0,
    sortedValues.length - 1,
  );
  return sortedValues[index] ?? 0;
}

function colorDistance(left: Rgb, right: Rgb): number {
  const dr = left.r - right.r;
  const dg = left.g - right.g;
  const db = left.b - right.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function luminance(color: Rgb): number {
  return color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
}
