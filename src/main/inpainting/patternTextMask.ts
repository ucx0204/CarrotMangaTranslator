import { clamp } from "../../shared/geometry";
import type { PixelRect } from "./maskGeometry";
import {
  finalizeDetectedTextMask,
  localLuminanceEdge,
} from "./patternMaskMorphology";
import { readRgb } from "./rasterMasks";

type Rgb = ReturnType<typeof readRgb>;

type PatternTextMaskResult = {
  count: number;
  mask: Uint8Array;
  strategy: "adaptive" | "otsu" | "none";
};

type PatternTextMaskOptions = {
  focusRect?: PixelRect;
};

export function buildPatternTextMask(
  bitmap: Buffer,
  width: number,
  _height: number,
  rect: PixelRect,
  dilationRadius: number,
  options: PatternTextMaskOptions = {},
): PatternTextMaskResult {
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
  const adaptive = finalizeDetectedTextMask({
    initial,
    luminances: sample.luminances,
    pixelCount: sample.pixelCount,
    rect,
    focusRect: options.focusRect,
    dilationRadius,
    edgeThreshold: thresholds.edgeThreshold,
  });
  if (adaptive) {
    return { ...adaptive, strategy: "adaptive" };
  }

  const otsuInitial = buildOtsuPatternMask(sample, rect);
  if (!otsuInitial) {
    return emptyPatternMask(sample.pixelCount);
  }
  const otsu = finalizeDetectedTextMask({
    initial: otsuInitial,
    luminances: sample.luminances,
    pixelCount: sample.pixelCount,
    rect,
    focusRect: options.focusRect,
    dilationRadius,
    edgeThreshold: 12,
  });
  return otsu
    ? { ...otsu, strategy: "otsu" }
    : emptyPatternMask(sample.pixelCount);
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

function buildOtsuPatternMask(
  sample: PatternTextSample,
  rect: PixelRect,
): { mask: Uint8Array; count: number } | null {
  const threshold = resolveOtsuThreshold(sample.luminances);
  const sorted = [...sample.luminanceSamples].sort(
    (left, right) => left - right,
  );
  const medianLuminance = percentile(sorted, 0.5);
  const separation = Math.abs(
    percentile(sorted, 0.95) - percentile(sorted, 0.05),
  );
  if (threshold === null || separation < 4) {
    return null;
  }

  const lightBackground = medianLuminance >= 128;
  const minimumEdge = Math.max(4, Math.min(12, separation * 0.35));
  const mask = new Uint8Array(sample.pixelCount);
  let count = 0;
  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      const index = y * rect.w + x;
      const value = sample.luminances[index] ?? medianLuminance;
      const candidate = lightBackground
        ? value <= threshold
        : value > threshold;
      const separatedFromBackground =
        Math.abs(value - medianLuminance) >= Math.max(3, separation * 0.25);
      if (
        candidate &&
        (separatedFromBackground ||
          localLuminanceEdge(sample.luminances, rect.w, rect.h, x, y) >=
            minimumEdge)
      ) {
        mask[index] = 1;
        count += 1;
      }
    }
  }
  return { mask, count };
}

function resolveOtsuThreshold(luminances: Float32Array): number | null {
  if (luminances.length === 0) {
    return null;
  }
  const histogram = new Uint32Array(256);
  let totalSum = 0;
  for (const value of luminances) {
    const bucket = clamp(Math.round(value), 0, 255);
    histogram[bucket] += 1;
    totalSum += bucket;
  }

  let backgroundCount = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let bestThreshold = 0;
  for (let threshold = 0; threshold < 255; threshold += 1) {
    backgroundCount += histogram[threshold] ?? 0;
    if (backgroundCount === 0) {
      continue;
    }
    const foregroundCount = luminances.length - backgroundCount;
    if (foregroundCount === 0) {
      break;
    }
    backgroundSum += threshold * (histogram[threshold] ?? 0);
    const backgroundMean = backgroundSum / backgroundCount;
    const foregroundMean = (totalSum - backgroundSum) / foregroundCount;
    const variance =
      backgroundCount *
      foregroundCount *
      (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = threshold;
    }
  }
  return bestVariance > 0 ? bestThreshold : null;
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

function emptyPatternMask(pixelCount: number): PatternTextMaskResult {
  return { mask: new Uint8Array(pixelCount), count: 0, strategy: "none" };
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
