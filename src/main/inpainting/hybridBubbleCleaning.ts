import type { PixelRect } from "./maskGeometry";
import { readRgb } from "./rasterMasks";

type Rgb = { r: number; g: number; b: number };

export type FlatBubbleFill = {
  color: Rgb;
  kind: "black" | "white";
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
