import { clamp } from "../../shared/geometry";
import type { InpaintingMaskStroke, InpaintingPoint } from "../../shared/types";
import type { PixelRect } from "./maskGeometry";

type Rgb = {
  r: number;
  g: number;
  b: number;
};

export function sanitizeMaskStrokes(
  strokes: InpaintingMaskStroke[],
  width: number,
  height: number,
): InpaintingMaskStroke[] {
  return strokes
    .map((stroke) => ({
      radiusPx: clamp(Math.round(stroke.radiusPx), 2, 180),
      points: sanitizePoints(stroke.points, width, height),
    }))
    .filter((stroke) => stroke.points.length > 0)
    .slice(0, 200);
}

export function buildMaskFromStrokes(
  strokes: InpaintingMaskStroke[],
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const stroke of strokes) {
    for (let index = 0; index < stroke.points.length; index += 1) {
      const previous = stroke.points[index - 1] ?? stroke.points[index];
      const current = stroke.points[index];
      for (const point of interpolatePoints(
        previous,
        current,
        Math.max(1, stroke.radiusPx * 0.35),
      )) {
        drawMaskCircle(mask, width, height, point, stroke.radiusPx);
      }
    }
  }
  return mask;
}

export function maskComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea: number,
): Array<{ rect: PixelRect; area: number }> {
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
      enqueueUnvisitedMaskNeighbors(mask, visited, queue, x, y, width, height);
    }
    if (area >= minArea) {
      components.push({
        area,
        rect: {
          x: x1,
          y: y1,
          w: Math.max(1, x2 - x1),
          h: Math.max(1, y2 - y1),
        },
      });
    }
  }
  return components.sort((left, right) => right.area - left.area);
}

function enqueueUnvisitedMaskNeighbors(
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

export function readRgb(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number,
): Rgb {
  const offset = (y * width + x) * 4;
  return {
    b: bitmap[offset] ?? 0,
    g: bitmap[offset + 1] ?? 0,
    r: bitmap[offset + 2] ?? 0,
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
  paintColor: Rgb | null,
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

export function sanitizePoints(
  points: InpaintingPoint[],
  width: number,
  height: number,
): InpaintingPoint[] {
  return points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({
      x: clamp(Math.round(point.x), 0, Math.max(0, width - 1)),
      y: clamp(Math.round(point.y), 0, Math.max(0, height - 1)),
    }))
    .slice(0, 1200);
}

export function interpolatePoints(
  from: InpaintingPoint,
  to: InpaintingPoint,
  step: number,
): InpaintingPoint[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const count = Math.max(1, Math.ceil(distance / Math.max(1, step)));
  const points: InpaintingPoint[] = [];
  for (let index = 0; index <= count; index += 1) {
    const ratio = index / count;
    points.push({
      x: from.x + dx * ratio,
      y: from.y + dy * ratio,
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
    b: Number.parseInt(match[3], 16),
  };
}

export function rgbToHex(color: Rgb): string {
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function drawMaskCircle(
  mask: Uint8Array,
  width: number,
  height: number,
  point: InpaintingPoint,
  radius: number,
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
      if (dx * dx + dy * dy <= radius * radius) {
        mask[y * width + x] = 1;
      }
    }
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

function toHex(value: number): string {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
}

function writeRgb(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number,
  color: Rgb,
): void {
  const offset = (y * width + x) * 4;
  bitmap[offset] = color.b;
  bitmap[offset + 1] = color.g;
  bitmap[offset + 2] = color.r;
  bitmap[offset + 3] = 255;
}

function copyPixel(
  source: Buffer,
  target: Buffer,
  width: number,
  x: number,
  y: number,
): void {
  const offset = (y * width + x) * 4;
  target[offset] = source[offset] ?? 0;
  target[offset + 1] = source[offset + 1] ?? 0;
  target[offset + 2] = source[offset + 2] ?? 0;
  target[offset + 3] = source[offset + 3] ?? 255;
}
