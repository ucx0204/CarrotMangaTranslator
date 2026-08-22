import type { PixelRect } from "./maskGeometry";

type BinaryMask = { count: number; mask: Uint8Array };

export function finalizeDetectedTextMask({
  initial,
  luminances,
  pixelCount,
  rect,
  focusRect,
  dilationRadius,
  edgeThreshold,
}: {
  initial: BinaryMask;
  luminances: Float32Array;
  pixelCount: number;
  rect: PixelRect;
  focusRect?: PixelRect;
  dilationRadius: number;
  edgeThreshold: number;
}): BinaryMask | null {
  const coverage = initial.count / Math.max(1, pixelCount);
  if (initial.count === 0 || coverage < 0.0015 || coverage > 0.42) {
    return null;
  }
  const connected = removeTinyMaskComponents(
    initial.mask,
    rect.w,
    rect.h,
    Math.max(4, Math.round(pixelCount * 0.00035)),
    rect,
    focusRect,
  );
  const dilated = dilateBinaryMaskDisk(
    connected.mask,
    rect.w,
    rect.h,
    dilationRadius,
  );
  const protectedMask = protectOutlineFringe({
    connectedMask: connected.mask,
    dilatedMask: dilated,
    edgeThreshold,
    focusRect,
    luminances,
    rect,
  });
  const count = countMaskPixels(protectedMask);
  if (connected.count === 0 || count / Math.max(1, pixelCount) > 0.52) {
    return null;
  }
  return { mask: protectedMask, count };
}

export function localLuminanceEdge(
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

function countMaskPixels(mask: Uint8Array): number {
  let count = 0;
  for (const value of mask) {
    if (value) {
      count += 1;
    }
  }
  return count;
}

export function dilateBinaryMaskDisk(
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
  rect: PixelRect,
  focusRect?: PixelRect,
): BinaryMask {
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
    if (
      component.length < minArea ||
      !componentBelongsToFocus(component, width, rect, focusRect)
    ) {
      continue;
    }
    for (const pixel of component) {
      output[pixel] = 1;
    }
    keptCount += component.length;
  }
  return { mask: output, count: keptCount };
}

function componentBelongsToFocus(
  component: number[],
  width: number,
  rect: PixelRect,
  focusRect?: PixelRect,
): boolean {
  if (!focusRect) {
    return true;
  }
  let insideCount = 0;
  for (const index of component) {
    const x = index % width;
    const y = Math.floor(index / width);
    if (pointInsideRect(rect.x + x, rect.y + y, focusRect)) {
      insideCount += 1;
    }
  }
  return insideCount > 0 && insideCount / component.length >= 0.12;
}

function protectOutlineFringe({
  connectedMask,
  dilatedMask,
  edgeThreshold,
  focusRect,
  luminances,
  rect,
}: {
  connectedMask: Uint8Array;
  dilatedMask: Uint8Array;
  edgeThreshold: number;
  focusRect?: PixelRect;
  luminances: Float32Array;
  rect: PixelRect;
}): Uint8Array {
  if (!focusRect) {
    return dilatedMask;
  }
  const output = Uint8Array.from(dilatedMask);
  const protectedEdgeThreshold = Math.max(24, edgeThreshold * 1.2);
  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      const index = y * rect.w + x;
      if (
        !output[index] ||
        connectedMask[index] ||
        pointInsideRect(rect.x + x, rect.y + y, focusRect)
      ) {
        continue;
      }
      if (
        localLuminanceEdge(luminances, rect.w, rect.h, x, y) >=
        protectedEdgeThreshold
      ) {
        output[index] = 0;
      }
    }
  }
  return output;
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

function pointInsideRect(x: number, y: number, rect: PixelRect): boolean {
  return (
    x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
  );
}

function isInside(
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  return x >= 0 && x < width && y >= 0 && y < height;
}
