import type { PixelRect } from "./maskGeometry";
import { readRgb } from "./rasterMasks";

type Rgb = { r: number; g: number; b: number };

type LinearChannel = { x: number; y: number; offset: number };

export type FlatBubbleFill = {
  color: Rgb;
  kind: "black" | "white";
};

export type LightweightBubbleFill = {
  channels: { r: LinearChannel; g: LinearChannel; b: LinearChannel };
  inlierRatio: number;
  rmse: number;
  sampleCount: number;
};

export function resolveFlatBubbleFill(
  bitmap: Buffer,
  pageWidth: number,
  rect: PixelRect,
  textMask: Uint8Array,
  constraintMask?: Uint8Array,
): FlatBubbleFill | null {
  const samples: Rgb[] = [];
  const step = Math.max(1, Math.floor(Math.max(rect.w, rect.h) / 80));
  for (let y = 0; y < rect.h; y += step) {
    for (let x = 0; x < rect.w; x += step) {
      const index = y * rect.w + x;
      if (textMask[index] || (constraintMask && !constraintMask[index])) {
        continue;
      }
      samples.push(readRgb(bitmap, pageWidth, rect.x + x, rect.y + y));
    }
  }
  if (samples.length < 12) {
    return null;
  }
  const color = medianColor(samples);
  const luminance = color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
  const kind = luminance >= 205 ? "white" : luminance <= 50 ? "black" : null;
  if (!kind) {
    return null;
  }
  const closeSamples = samples.filter(
    (sample) => colorDistance(sample, color) <= 34,
  ).length;
  return closeSamples / samples.length >= 0.78 ? { color, kind } : null;
}

export function applyFlatBubbleFill(
  bitmap: Buffer,
  pageWidth: number,
  rect: PixelRect,
  mask: Uint8Array,
  color: Rgb,
): void {
  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      if (!mask[y * rect.w + x]) {
        continue;
      }
      const offset = ((rect.y + y) * pageWidth + rect.x + x) * 4;
      bitmap[offset] = color.b;
      bitmap[offset + 1] = color.g;
      bitmap[offset + 2] = color.r;
      bitmap[offset + 3] = 255;
    }
  }
}

export function resolveLightweightBubbleFill(
  bitmap: Buffer,
  pageWidth: number,
  rect: PixelRect,
  textMask: Uint8Array,
  constraintMask?: Uint8Array,
): LightweightBubbleFill | null {
  const samples = collectPlaneSamples(
    bitmap,
    pageWidth,
    rect,
    textMask,
    constraintMask,
  );
  if (samples.length < 24) return null;

  const initial = fitRgbPlane(samples);
  if (!initial) return null;
  const residuals = samples.map((sample) =>
    planeResidual(initial, sample.x, sample.y, sample.color),
  );
  const medianResidual = median([...residuals]);
  const inlierThreshold = Math.max(10, medianResidual * 2.5);
  const inliers = samples.filter(
    (_, index) =>
      (residuals[index] ?? Number.POSITIVE_INFINITY) <= inlierThreshold,
  );
  const inlierRatio = inliers.length / samples.length;
  if (inliers.length < 24 || inlierRatio < 0.78) return null;

  const channels = fitRgbPlane(inliers);
  if (!channels || !planeStaysWithinBubbleRange(channels)) return null;
  const acceptedResiduals = inliers.map((sample) =>
    planeResidual(channels, sample.x, sample.y, sample.color),
  );
  const rmse = Math.sqrt(
    acceptedResiduals.reduce((sum, value) => sum + value * value, 0) /
      acceptedResiduals.length,
  );
  const sortedResiduals = [...acceptedResiduals].sort(
    (left, right) => left - right,
  );
  const p90 = sortedResiduals[Math.floor(sortedResiduals.length * 0.9)] ?? 0;
  if (rmse > 9 || p90 > 15) return null;

  return {
    channels,
    inlierRatio,
    rmse,
    sampleCount: samples.length,
  };
}

export function applyLightweightBubbleFill(
  bitmap: Buffer,
  pageWidth: number,
  rect: PixelRect,
  mask: Uint8Array,
  fill: LightweightBubbleFill,
): void {
  const widthScale = Math.max(1, rect.w - 1);
  const heightScale = Math.max(1, rect.h - 1);
  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      if (!mask[y * rect.w + x]) continue;
      const normalizedX = x / widthScale;
      const normalizedY = y / heightScale;
      const offset = ((rect.y + y) * pageWidth + rect.x + x) * 4;
      bitmap[offset] = predictChannel(
        fill.channels.b,
        normalizedX,
        normalizedY,
      );
      bitmap[offset + 1] = predictChannel(
        fill.channels.g,
        normalizedX,
        normalizedY,
      );
      bitmap[offset + 2] = predictChannel(
        fill.channels.r,
        normalizedX,
        normalizedY,
      );
      bitmap[offset + 3] = 255;
    }
  }
}

type PlaneSample = { x: number; y: number; color: Rgb };

function collectPlaneSamples(
  bitmap: Buffer,
  pageWidth: number,
  rect: PixelRect,
  textMask: Uint8Array,
  constraintMask?: Uint8Array,
): PlaneSample[] {
  const samples: PlaneSample[] = [];
  const step = Math.max(1, Math.floor(Math.max(rect.w, rect.h) / 80));
  const widthScale = Math.max(1, rect.w - 1);
  const heightScale = Math.max(1, rect.h - 1);
  for (let y = 0; y < rect.h; y += step) {
    for (let x = 0; x < rect.w; x += step) {
      const index = y * rect.w + x;
      if (textMask[index] || (constraintMask && !constraintMask[index])) {
        continue;
      }
      samples.push({
        x: x / widthScale,
        y: y / heightScale,
        color: readRgb(bitmap, pageWidth, rect.x + x, rect.y + y),
      });
    }
  }
  return samples;
}

function fitRgbPlane(
  samples: PlaneSample[],
): LightweightBubbleFill["channels"] | null {
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const sample of samples) {
    sx += sample.x;
    sy += sample.y;
    sxx += sample.x * sample.x;
    sxy += sample.x * sample.y;
    syy += sample.y * sample.y;
  }
  const matrix = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, samples.length],
  ];
  const fitChannel = (channel: keyof Rgb): LinearChannel | null => {
    let sxv = 0;
    let syv = 0;
    let sv = 0;
    for (const sample of samples) {
      const value = sample.color[channel];
      sxv += sample.x * value;
      syv += sample.y * value;
      sv += value;
    }
    const solved = solveThreeByThree(matrix, [sxv, syv, sv]);
    return solved ? { x: solved[0], y: solved[1], offset: solved[2] } : null;
  };
  const r = fitChannel("r");
  const g = fitChannel("g");
  const b = fitChannel("b");
  return r && g && b ? { r, g, b } : null;
}

function solveThreeByThree(
  source: number[][],
  right: number[],
): [number, number, number] | null {
  const matrix = source.map((row, index) => [...row, right[index] ?? 0]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) {
        pivot = row;
      }
    }
    if (Math.abs(matrix[pivot][column]) < 1e-8) return null;
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const divisor = matrix[column][column];
    for (let index = column; index < 4; index += 1) {
      matrix[column][index] /= divisor;
    }
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let index = column; index < 4; index += 1) {
        matrix[row][index] -= factor * matrix[column][index];
      }
    }
  }
  return [matrix[0][3], matrix[1][3], matrix[2][3]];
}

function planeResidual(
  channels: LightweightBubbleFill["channels"],
  x: number,
  y: number,
  color: Rgb,
): number {
  return Math.hypot(
    predictRaw(channels.r, x, y) - color.r,
    predictRaw(channels.g, x, y) - color.g,
    predictRaw(channels.b, x, y) - color.b,
  );
}

function planeStaysWithinBubbleRange(
  channels: LightweightBubbleFill["channels"],
): boolean {
  const corners = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const;
  for (const channel of Object.values(channels)) {
    const values = corners.map(([x, y]) => predictRaw(channel, x, y));
    if (Math.min(...values) < -8 || Math.max(...values) > 263) return false;
    if (Math.max(...values) - Math.min(...values) > 110) return false;
  }
  return true;
}

function predictRaw(channel: LinearChannel, x: number, y: number): number {
  return channel.x * x + channel.y * y + channel.offset;
}

function predictChannel(channel: LinearChannel, x: number, y: number): number {
  return Math.max(0, Math.min(255, Math.round(predictRaw(channel, x, y))));
}

function medianColor(samples: Rgb[]): Rgb {
  return {
    r: median(samples.map((sample) => sample.r)),
    g: median(samples.map((sample) => sample.g)),
    b: median(samples.map((sample) => sample.b)),
  };
}

function median(values: number[]): number {
  values.sort((left, right) => left - right);
  return values[Math.floor(values.length / 2)] ?? 0;
}

function colorDistance(left: Rgb, right: Rgb): number {
  return Math.hypot(left.r - right.r, left.g - right.g, left.b - right.b);
}
