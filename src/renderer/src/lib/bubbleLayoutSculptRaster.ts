import type {
  BubbleLayout,
  BubbleShapeSpan,
} from "../../../shared/bubbleLayout";
import type { BBox, Point } from "../../../shared/textTypes";

const PAGE_EXTENT = 1000;
const NEIGHBORS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
] as const;

export type SculptRaster = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type SculptLabels = { values: Int32Array; count: number };
export type SculptGrid = {
  raster: SculptRaster;
  current: Uint8Array;
  owners: Uint8Array;
  stroke: Uint8Array;
};

export function buildSculptGrid(
  bbox: BBox,
  layout: BubbleLayout,
  points: readonly Point[],
  radius: number,
  mode: "add" | "subtract",
): SculptGrid | null {
  const raster = rasterBounds(bbox, points, radius, mode);
  if (!raster) return null;
  const current = new Uint8Array(raster.width * raster.height);
  const owners = new Uint8Array(current.length);
  layout.regions.forEach((region, regionIndex) => {
    for (const span of region.spans) {
      fillBox(
        raster,
        pageBox(span, bbox, layout.direction),
        current,
        owners,
        1 << regionIndex,
      );
    }
  });
  return {
    raster,
    current,
    owners,
    stroke: strokeMask(raster, points, radius),
  };
}

export function addConnected(
  grid: SculptGrid,
): { mask: Uint8Array } | { reason: "detached" } {
  const labels = labelSculptMask(grid.stroke, grid.raster);
  const touching = new Uint8Array(labels.count + 1);
  grid.stroke.forEach((value, index) => {
    const component = labels.values[index] ?? 0;
    if (value && component && touches(index, grid.current, grid.raster)) {
      touching[component] = 1;
    }
  });
  if (!touching.some(Boolean)) return { reason: "detached" };
  const mask = grid.current.slice();
  labels.values.forEach((component, index) => {
    if (component && touching[component]) mask[index] = 1;
  });
  return { mask };
}

export function subtractSafely(
  grid: SculptGrid,
): { mask: Uint8Array } | { reason: "empty" | "disconnect" } {
  const mask = grid.current.map((value, index) =>
    value && !grid.stroke[index] ? 1 : 0,
  );
  if (sculptMasksEqual(grid.current, mask)) return { reason: "empty" };
  const before = labelSculptMask(grid.current, grid.raster);
  const after = labelSculptMask(mask, grid.raster);
  const survivors = new Int32Array(before.count + 1);
  for (let index = 0; index < mask.length; index += 1) {
    const oldLabel = before.values[index] ?? 0;
    const newLabel = after.values[index] ?? 0;
    if (!oldLabel || !newLabel) continue;
    if (!survivors[oldLabel]) survivors[oldLabel] = newLabel;
    else if (survivors[oldLabel] !== newLabel) return { reason: "disconnect" };
  }
  if (Array.from(survivors.slice(1)).some((value) => value === 0)) {
    return { reason: "empty" };
  }
  return after.count === before.count ? { mask } : { reason: "disconnect" };
}

export function labelSculptMask(
  mask: Uint8Array,
  raster: SculptRaster,
): SculptLabels {
  const values = new Int32Array(mask.length);
  const queue = new Int32Array(mask.length);
  let count = 0;
  mask.forEach((filled, seed) => {
    if (!filled || values[seed]) return;
    count += 1;
    flood(mask, values, queue, raster, seed, count);
  });
  return { values, count };
}

export function sculptMasksEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function rasterBounds(
  bbox: BBox,
  points: readonly Point[],
  radius: number,
  mode: "add" | "subtract",
): SculptRaster | null {
  const xs = mode === "add" ? points.map(({ x }) => x) : [];
  const ys = mode === "add" ? points.map(({ y }) => y) : [];
  const x = Math.floor(
    clamp(Math.min(bbox.x, ...xs.map((value) => value - radius)), 0, 999),
  );
  const y = Math.floor(
    clamp(Math.min(bbox.y, ...ys.map((value) => value - radius)), 0, 999),
  );
  const right = Math.ceil(
    clamp(
      Math.max(bbox.x + bbox.w, ...xs.map((value) => value + radius)),
      x + 1,
      PAGE_EXTENT,
    ),
  );
  const bottom = Math.ceil(
    clamp(
      Math.max(bbox.y + bbox.h, ...ys.map((value) => value + radius)),
      y + 1,
      PAGE_EXTENT,
    ),
  );
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null;
}

function pageBox(
  span: BubbleShapeSpan,
  bbox: BBox,
  direction: BubbleLayout["direction"],
): BBox {
  const horizontal = direction === "horizontal";
  const xStart = horizontal ? span.inlineStart : span.blockStart;
  const xEnd = horizontal ? span.inlineEnd : span.blockEnd;
  const yStart = horizontal ? span.blockStart : span.inlineStart;
  const yEnd = horizontal ? span.blockEnd : span.inlineEnd;
  return {
    x: bbox.x + xStart * bbox.w,
    y: bbox.y + yStart * bbox.h,
    w: (xEnd - xStart) * bbox.w,
    h: (yEnd - yStart) * bbox.h,
  };
}

function fillBox(
  raster: SculptRaster,
  box: BBox,
  mask: Uint8Array,
  owners: Uint8Array,
  owner: number,
): void {
  const [left, right] = cellRange(
    box.x - raster.x,
    box.x + box.w - raster.x,
    raster.width,
  );
  const [top, bottom] = cellRange(
    box.y - raster.y,
    box.y + box.h - raster.y,
    raster.height,
  );
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = y * raster.width + x;
      mask[index] = 1;
      owners[index] |= owner;
    }
  }
}

function strokeMask(
  raster: SculptRaster,
  points: readonly Point[],
  radius: number,
): Uint8Array {
  const mask = new Uint8Array(raster.width * raster.height);
  const segments =
    points.length === 1
      ? [[points[0], points[0]] as const]
      : points.slice(1).map((point, index) => [points[index], point] as const);
  for (const [start, end] of segments) {
    if (!start || !end) continue;
    paintSegment(raster, mask, start, end, radius);
  }
  return mask;
}

function paintSegment(
  raster: SculptRaster,
  mask: Uint8Array,
  start: Point,
  end: Point,
  radius: number,
): void {
  const [left, right] = cellRange(
    Math.min(start.x, end.x) - radius - raster.x,
    Math.max(start.x, end.x) + radius - raster.x,
    raster.width,
  );
  const [top, bottom] = cellRange(
    Math.min(start.y, end.y) - radius - raster.y,
    Math.max(start.y, end.y) + radius - raster.y,
    raster.height,
  );
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const point = { x: raster.x + x + 0.5, y: raster.y + y + 0.5 };
      if (segmentDistanceSquared(point, start, end) <= radius * radius) {
        mask[y * raster.width + x] = 1;
      }
    }
  }
}

function segmentDistanceSquared(
  point: Point,
  start: Point,
  end: Point,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const squared = dx * dx + dy * dy;
  const ratio =
    squared === 0
      ? 0
      : clamp(
          ((point.x - start.x) * dx + (point.y - start.y) * dy) / squared,
          0,
          1,
        );
  const x = point.x - start.x - ratio * dx;
  const y = point.y - start.y - ratio * dy;
  return x * x + y * y;
}

function touches(
  index: number,
  mask: Uint8Array,
  raster: SculptRaster,
): boolean {
  if (mask[index]) return true;
  const x = index % raster.width;
  const y = Math.floor(index / raster.width);
  return NEIGHBORS.some(([dx, dy]) => {
    const nextX = x + dx;
    const nextY = y + dy;
    return (
      nextX >= 0 &&
      nextX < raster.width &&
      nextY >= 0 &&
      nextY < raster.height &&
      Boolean(mask[nextY * raster.width + nextX])
    );
  });
}

function flood(
  mask: Uint8Array,
  labels: Int32Array,
  queue: Int32Array,
  raster: SculptRaster,
  seed: number,
  labelValue: number,
): void {
  let head = 0;
  let tail = 1;
  queue[0] = seed;
  labels[seed] = labelValue;
  while (head < tail) {
    const index = queue[head++] ?? 0;
    const x = index % raster.width;
    const y = Math.floor(index / raster.width);
    for (const [dx, dy] of NEIGHBORS) {
      const nextX = x + dx;
      const nextY = y + dy;
      if (
        nextX < 0 ||
        nextX >= raster.width ||
        nextY < 0 ||
        nextY >= raster.height
      ) {
        continue;
      }
      const next = nextY * raster.width + nextX;
      if (!mask[next] || labels[next]) continue;
      labels[next] = labelValue;
      queue[tail++] = next;
    }
  }
}

function cellRange(
  start: number,
  end: number,
  limit: number,
): [number, number] {
  return [
    clamp(Math.ceil(start - 0.5), 0, limit),
    clamp(Math.floor(end - 0.5) + 1, 0, limit),
  ];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
