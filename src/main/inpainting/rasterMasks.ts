import { clamp } from "../../shared/geometry";
import type { InpaintingMaskStroke, InpaintingPoint } from "../../shared/types";
import type { PixelRect } from "./maskGeometry";

type Rgb = {
  r: number;
  g: number;
  b: number;
};

export function sanitizeMaskStrokes(strokes: InpaintingMaskStroke[], width: number, height: number): InpaintingMaskStroke[] {
  return strokes
    .map((stroke) => ({
      radiusPx: clamp(Math.round(stroke.radiusPx), 2, 180),
      points: sanitizePoints(stroke.points, width, height)
    }))
    .filter((stroke) => stroke.points.length > 0)
    .slice(0, 200);
}

export function buildMaskFromStrokes(strokes: InpaintingMaskStroke[], width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const stroke of strokes) {
    for (let index = 0; index < stroke.points.length; index += 1) {
      const previous = stroke.points[index - 1] ?? stroke.points[index];
      const current = stroke.points[index];
      for (const point of interpolatePoints(previous, current, Math.max(1, stroke.radiusPx * 0.35))) {
        drawMaskCircle(mask, width, height, point, stroke.radiusPx);
      }
    }
  }
  return mask;
}

export function maskComponents(mask: Uint8Array, width: number, height: number, minArea: number): Array<{ rect: PixelRect; area: number }> {
  const visited = new Uint8Array(mask.length);
  const queue: number[] = [];
  const components: Array<{ rect: PixelRect; area: number }> = [];
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || visited[index]) {
      continue;
    }
    queue.length = 0;
    visited[index] = 1;
    queue.push(index);
    let area = 0;
    let x1 = width;
    let y1 = height;
    let x2 = 0;
    let y2 = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      const x = current % width;
      const y = Math.floor(current / width);
      area += 1;
      x1 = Math.min(x1, x);
      y1 = Math.min(y1, y);
      x2 = Math.max(x2, x + 1);
      y2 = Math.max(y2, y + 1);
      for (const neighbor of maskNeighbors(x, y, width, height)) {
        if (mask[neighbor] && !visited[neighbor]) {
          visited[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }
    if (area >= minArea) {
      components.push({
        area,
        rect: {
          x: x1,
          y: y1,
          w: Math.max(1, x2 - x1),
          h: Math.max(1, y2 - y1)
        }
      });
    }
  }
  return components.sort((left, right) => right.area - left.area);
}

export function buildPatternTextMask(
  bitmap: Buffer,
  width: number,
  _height: number,
  rect: PixelRect,
  dilationRadius: number
): { mask: Uint8Array; count: number } {
  const pixelCount = rect.w * rect.h;
  const luminances = new Float32Array(pixelCount);
  const luminanceSamples: number[] = [];
  const redSamples: number[] = [];
  const greenSamples: number[] = [];
  const blueSamples: number[] = [];
  const sampleStep = Math.max(1, Math.floor(Math.max(rect.w, rect.h) / 140));

  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      const color = readRgb(bitmap, width, rect.x + x, rect.y + y);
      const lum = luminance(color);
      luminances[y * rect.w + x] = lum;
      if (x % sampleStep === 0 && y % sampleStep === 0) {
        luminanceSamples.push(lum);
        redSamples.push(color.r);
        greenSamples.push(color.g);
        blueSamples.push(color.b);
      }
    }
  }

  if (luminanceSamples.length < 8) {
    return { mask: new Uint8Array(pixelCount), count: 0 };
  }

  const sortedLum = luminanceSamples.sort((left, right) => left - right);
  const p12 = percentile(sortedLum, 0.12);
  const p25 = percentile(sortedLum, 0.25);
  const p50 = percentile(sortedLum, 0.5);
  const p75 = percentile(sortedLum, 0.75);
  const p88 = percentile(sortedLum, 0.88);
  const medianColor = {
    r: median(redSamples),
    g: median(greenSamples),
    b: median(blueSamples)
  };
  const darkCutoff = Math.min(p50 - 18, p25 + 10);
  const brightCutoff = Math.max(p50 + 24, p75 - 6);
  const edgeThreshold = Math.max(18, Math.min(38, (p88 - p12) * 0.2));
  const mask = new Uint8Array(pixelCount);
  let initialCount = 0;

  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      const index = y * rect.w + x;
      const lum = luminances[index] ?? 0;
      const color = readRgb(bitmap, width, rect.x + x, rect.y + y);
      const localEdge = localLuminanceEdge(luminances, rect.w, rect.h, x, y);
      const colorOutlier = colorDistance(color, medianColor) >= 34;
      const darkStroke = lum <= darkCutoff;
      const brightStroke = lum >= brightCutoff && localEdge >= edgeThreshold;
      if ((darkStroke || brightStroke) && (localEdge >= edgeThreshold || colorOutlier)) {
        mask[index] = 1;
        initialCount += 1;
      }
    }
  }

  const coverage = initialCount / Math.max(1, pixelCount);
  if (initialCount === 0 || coverage < 0.0015 || coverage > 0.42) {
    return { mask: new Uint8Array(pixelCount), count: 0 };
  }

  const connected = removeTinyMaskComponents(mask, rect.w, rect.h, Math.max(4, Math.round(pixelCount * 0.00035)));
  const dilated = dilateMask(connected.mask, rect.w, rect.h, dilationRadius);
  let count = 0;
  for (const value of dilated) {
    if (value) {
      count += 1;
    }
  }

  const finalCoverage = count / Math.max(1, pixelCount);
  if (connected.count === 0 || finalCoverage > 0.52) {
    return { mask: new Uint8Array(pixelCount), count: 0 };
  }
  return { mask: dilated, count };
}

export function readRgb(bitmap: Buffer, width: number, x: number, y: number): Rgb {
  const offset = (y * width + x) * 4;
  return {
    b: bitmap[offset] ?? 0,
    g: bitmap[offset + 1] ?? 0,
    r: bitmap[offset + 2] ?? 0
  };
}

export function applyRetouchCircle(
  bitmap: Buffer,
  originalBitmap: Buffer,
  width: number,
  height: number,
  point: InpaintingPoint,
  radius: number,
  mode: "paint" | "restore",
  paintColor: Rgb | null
): void {
  const cx = clamp(Math.round(point.x), 0, Math.max(0, width - 1));
  const cy = clamp(Math.round(point.y), 0, Math.max(0, height - 1));
  const x1 = clamp(cx - radius, 0, Math.max(0, width - 1));
  const y1 = clamp(cy - radius, 0, Math.max(0, height - 1));
  const x2 = clamp(cx + radius, x1, Math.max(0, width - 1));
  const y2 = clamp(cy + radius, y1, Math.max(0, height - 1));
  for (let y = y1; y <= y2; y += 1) {
    for (let x = x1; x <= x2; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > radius * radius) {
        continue;
      }
      if (mode === "paint" && paintColor) {
        writeRgb(bitmap, width, x, y, paintColor);
      } else {
        copyPixel(originalBitmap, bitmap, width, x, y);
      }
    }
  }
}

export function sanitizePoints(points: InpaintingPoint[], width: number, height: number): InpaintingPoint[] {
  return points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({
      x: clamp(Math.round(point.x), 0, Math.max(0, width - 1)),
      y: clamp(Math.round(point.y), 0, Math.max(0, height - 1))
    }))
    .slice(0, 1200);
}

export function interpolatePoints(from: InpaintingPoint, to: InpaintingPoint, step: number): InpaintingPoint[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const count = Math.max(1, Math.ceil(distance / Math.max(1, step)));
  const points: InpaintingPoint[] = [];
  for (let index = 0; index <= count; index += 1) {
    const ratio = index / count;
    points.push({
      x: from.x + dx * ratio,
      y: from.y + dy * ratio
    });
  }
  return points;
}

export function parseHexColor(value?: string): Rgb {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(value ?? "");
  if (!match) {
    return { r: 255, g: 255, b: 255 };
  }
  return {
    r: Number.parseInt(match[1], 16),
    g: Number.parseInt(match[2], 16),
    b: Number.parseInt(match[3], 16)
  };
}

export function rgbToHex(color: Rgb): string {
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function drawMaskCircle(mask: Uint8Array, width: number, height: number, point: InpaintingPoint, radius: number): void {
  const cx = clamp(Math.round(point.x), 0, Math.max(0, width - 1));
  const cy = clamp(Math.round(point.y), 0, Math.max(0, height - 1));
  const x1 = clamp(cx - radius, 0, Math.max(0, width - 1));
  const y1 = clamp(cy - radius, 0, Math.max(0, height - 1));
  const x2 = clamp(cx + radius, x1, Math.max(0, width - 1));
  const y2 = clamp(cy + radius, y1, Math.max(0, height - 1));
  for (let y = y1; y <= y2; y += 1) {
    for (let x = x1; x <= x2; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) {
        mask[y * width + x] = 1;
      }
    }
  }
}

function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) {
    return mask;
  }
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) {
        continue;
      }
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (dx * dx + dy * dy > radius * radius) {
            continue;
          }
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            output[ny * width + nx] = 1;
          }
        }
      }
    }
  }
  return output;
}

function removeTinyMaskComponents(mask: Uint8Array, width: number, height: number, minArea: number): { mask: Uint8Array; count: number } {
  const output = new Uint8Array(mask.length);
  const visited = new Uint8Array(mask.length);
  const queue: number[] = [];
  let keptCount = 0;

  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || visited[index]) {
      continue;
    }

    queue.length = 0;
    const component: number[] = [];
    visited[index] = 1;
    queue.push(index);

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      component.push(current);
      const x = current % width;
      const y = Math.floor(current / width);
      for (const neighbor of maskNeighbors(x, y, width, height)) {
        if (mask[neighbor] && !visited[neighbor]) {
          visited[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }

    if (component.length >= minArea) {
      for (const pixel of component) {
        output[pixel] = 1;
      }
      keptCount += component.length;
    }
  }

  return { mask: output, count: keptCount };
}

function maskNeighbors(x: number, y: number, width: number, height: number): number[] {
  const neighbors: number[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        neighbors.push(ny * width + nx);
      }
    }
  }
  return neighbors;
}

function localLuminanceEdge(luminances: Float32Array, width: number, height: number, x: number, y: number): number {
  const center = luminances[y * width + x] ?? 0;
  let maxDiff = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
        continue;
      }
      maxDiff = Math.max(maxDiff, Math.abs(center - (luminances[ny * width + nx] ?? center)));
    }
  }
  return maxDiff;
}

function toHex(value: number): string {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
}

function writeRgb(bitmap: Buffer, width: number, x: number, y: number, color: Rgb): void {
  const offset = (y * width + x) * 4;
  bitmap[offset] = color.b;
  bitmap[offset + 1] = color.g;
  bitmap[offset + 2] = color.r;
  bitmap[offset + 3] = 255;
}

function copyPixel(source: Buffer, target: Buffer, width: number, x: number, y: number): void {
  const offset = (y * width + x) * 4;
  target[offset] = source[offset] ?? 0;
  target[offset + 1] = source[offset + 1] ?? 0;
  target[offset + 2] = source[offset + 2] ?? 0;
  target[offset + 3] = source[offset + 3] ?? 255;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0);
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = clamp(Math.round((sortedValues.length - 1) * ratio), 0, sortedValues.length - 1);
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
