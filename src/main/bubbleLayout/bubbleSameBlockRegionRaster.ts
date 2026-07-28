import type { RefinedBubbleRegion } from "./bubbleMaskTypes";

export function retainLargestMaskComponent(
  mask: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const visited = new Uint8Array(mask.length);
  let largest: number[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const component = collectConnectedComponent(
      mask,
      visited,
      width,
      height,
      start,
    );
    if (component.length > largest.length) largest = component;
  }
  const output = new Uint8Array(mask.length);
  for (const index of largest) output[index] = 1;
  return output;
}

export function tightenBubbleRegion(
  source: RefinedBubbleRegion,
  mask: Uint8Array,
): RefinedBubbleRegion | null {
  const extents = measureMaskExtents(mask, source.width, source.height);
  if (!extents) return null;
  const width = extents.maxX - extents.minX + 1;
  const height = extents.maxY - extents.minY + 1;
  const tightenedMask = copyMaskCrop(
    mask,
    source.width,
    extents.minX,
    extents.minY,
    width,
    height,
  );
  return {
    bounds: {
      x: source.bounds.x + extents.minX,
      y: source.bounds.y + extents.minY,
      w: width,
      h: height,
    },
    width,
    height,
    area: extents.area,
    mask: tightenedMask,
  };
}

function collectConnectedComponent(
  mask: Uint8Array,
  visited: Uint8Array,
  width: number,
  height: number,
  start: number,
): number[] {
  const component: number[] = [];
  const queue = [start];
  visited[start] = 1;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor];
    component.push(index);
    enqueueConnectedNeighbors(mask, visited, width, height, index, queue);
  }
  return component;
}

function enqueueConnectedNeighbors(
  mask: Uint8Array,
  visited: Uint8Array,
  width: number,
  height: number,
  index: number,
  queue: number[],
): void {
  const x = index % width;
  const y = Math.floor(index / width);
  const neighbors = [
    x > 0 ? index - 1 : -1,
    x + 1 < width ? index + 1 : -1,
    y > 0 ? index - width : -1,
    y + 1 < height ? index + width : -1,
  ];
  for (const neighbor of neighbors) {
    if (neighbor < 0 || !mask[neighbor] || visited[neighbor]) continue;
    visited[neighbor] = 1;
    queue.push(neighbor);
  }
}

function measureMaskExtents(
  mask: Uint8Array,
  width: number,
  height: number,
): {
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} | null {
  let area = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      area += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return area > 0 ? { area, minX, minY, maxX, maxY } : null;
}

function copyMaskCrop(
  mask: Uint8Array,
  sourceWidth: number,
  sourceX: number,
  sourceY: number,
  width: number,
  height: number,
): Uint8Array {
  const output = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      output[y * width + x] =
        mask[(sourceY + y) * sourceWidth + sourceX + x] ?? 0;
    }
  }
  return output;
}
