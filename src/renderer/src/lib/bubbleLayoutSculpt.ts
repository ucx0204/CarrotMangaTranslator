import {
  isUsableBubbleLayout,
  MAX_BUBBLE_REGION_SPANS,
  type BubbleLayout,
  type BubbleShapeRegion,
  type BubbleShapeSpan,
} from "../../../shared/bubbleLayout";
import type { BBox, Point, TranslationBlock } from "../../../shared/textTypes";
import type { ManualBubbleLayoutPatch } from "./manualBubbleLayout";
import {
  addConnected,
  buildSculptGrid,
  labelSculptMask,
  sculptMasksEqual,
  subtractSafely,
  type SculptLabels,
  type SculptRaster,
} from "./bubbleLayoutSculptRaster";

type BubbleLayoutSculptMode = "add" | "subtract";
type BubbleLayoutSculptSource = Pick<
  TranslationBlock,
  "bbox" | "bboxSpace" | "renderBbox" | "renderBboxSpace" | "bubbleLayout"
>;
export type BubbleLayoutSculptInput = {
  /** A TranslationBlock or a draft ManualBubbleLayoutPatch. */
  block: BubbleLayoutSculptSource | ManualBubbleLayoutPatch;
  strokePoints: readonly Point[];
  radius: number;
  mode: BubbleLayoutSculptMode;
};
export type BubbleLayoutSculptRejectReason =
  | "detached"
  | "disconnect"
  | "empty"
  | "invalid";
export type BubbleLayoutSculptResult =
  | { status: "applied"; patch: ManualBubbleLayoutPatch }
  | { status: "rejected"; reason: BubbleLayoutSculptRejectReason };

const PAGE_EXTENT = 1000;
const MODEL_ID = "manual-sculpt-v1";

/**
 * Applies a page-normalized brush stroke without mutating the source block.
 * Additions must touch the old mask. Subtractions may neither erase nor split
 * any old component. Pixel-space boxes are rejected because page dimensions
 * are deliberately absent from this renderer-only helper.
 */
export function sculptBubbleLayout(
  input: BubbleLayoutSculptInput,
): BubbleLayoutSculptResult {
  const layout = input.block.bubbleLayout;
  const bbox = normalizedBbox(input.block);
  const points = normalizePoints(input.strokePoints);
  if (
    !bbox ||
    !points ||
    !isValidSculptInput(layout, points, input.radius, input.mode)
  ) {
    return rejected("invalid");
  }
  const grid = buildSculptGrid(bbox, layout, points, input.radius, input.mode);
  if (!grid || !grid.current.some(Boolean) || !grid.stroke.some(Boolean)) {
    return rejected("empty");
  }
  const changed =
    input.mode === "add" ? addConnected(grid) : subtractSafely(grid);
  if ("reason" in changed) return rejected(changed.reason);
  if (sculptMasksEqual(grid.current, changed.mask)) return rejected("empty");
  const patch = profilePatch(
    changed.mask,
    grid.owners,
    grid.raster,
    layout.direction,
  );
  return patch ? { status: "applied", patch } : rejected("invalid");
}

function isValidSculptInput(
  layout: unknown,
  points: readonly Point[],
  radius: number,
  mode: unknown,
): layout is BubbleLayout {
  return (
    isUsableBubbleLayout(layout) &&
    points.length > 0 &&
    Number.isFinite(radius) &&
    radius > 0 &&
    (mode === "add" || mode === "subtract")
  );
}

function rejected(
  reason: BubbleLayoutSculptRejectReason,
): BubbleLayoutSculptResult {
  return { status: "rejected", reason };
}

function normalizedBbox(
  source: BubbleLayoutSculptSource | ManualBubbleLayoutPatch,
): BBox | null {
  const hasFallback = "bbox" in source;
  const bbox = source.renderBbox ?? (hasFallback ? source.bbox : undefined);
  const space =
    source.renderBbox !== undefined
      ? source.renderBboxSpace
      : hasFallback
        ? source.bboxSpace
        : undefined;
  if (!bbox || space === "pixels") return null;
  const x = clamp(bbox.x, 0, PAGE_EXTENT);
  const y = clamp(bbox.y, 0, PAGE_EXTENT);
  const right = clamp(bbox.x + bbox.w, 0, PAGE_EXTENT);
  const bottom = clamp(bbox.y + bbox.h, 0, PAGE_EXTENT);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
}

function normalizePoints(points: readonly Point[]): Point[] | null {
  if (
    points.some(
      (point) => !Number.isFinite(point.x) || !Number.isFinite(point.y),
    )
  ) {
    return null;
  }
  return points.map(({ x, y }) => ({
    x: clamp(x, 0, PAGE_EXTENT),
    y: clamp(y, 0, PAGE_EXTENT),
  }));
}

function profilePatch(
  mask: Uint8Array,
  owners: Uint8Array,
  raster: SculptRaster,
  direction: BubbleLayout["direction"],
): ManualBubbleLayoutPatch | null {
  const labeled = labelSculptMask(mask, raster);
  const bbox = maskBounds(mask, raster);
  if (!bbox || labeled.count > 4) return null;
  const regions = orderedComponents(labeled, owners).map((component) =>
    componentRegion(labeled.values, component, raster, bbox, direction),
  );
  if (regions.some((region) => !region)) return null;
  return {
    renderBbox: bbox,
    renderBboxSpace: "normalized_1000",
    bubbleLayout: {
      version: 1,
      direction,
      confidence: 1,
      origin: "manual",
      modelId: MODEL_ID,
      insetRatio: 0,
      regions: regions.filter((region): region is BubbleShapeRegion =>
        Boolean(region),
      ),
    },
  };
}

function maskBounds(mask: Uint8Array, raster: SculptRaster): BBox | null {
  let left = raster.width;
  let top = raster.height;
  let right = -1;
  let bottom = -1;
  mask.forEach((filled, index) => {
    if (!filled) return;
    const x = index % raster.width;
    const y = Math.floor(index / raster.width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  });
  return right >= left && bottom >= top
    ? {
        x: raster.x + left,
        y: raster.y + top,
        w: right - left + 1,
        h: bottom - top + 1,
      }
    : null;
}

function orderedComponents(
  labeled: SculptLabels,
  owners: Uint8Array,
): number[] {
  const priority = new Array<number>(labeled.count + 1).fill(4);
  labeled.values.forEach((component, index) => {
    if (!component || !owners[index]) return;
    priority[component] = Math.min(
      priority[component] ?? 4,
      firstOwner(owners[index] ?? 0),
    );
  });
  return Array.from({ length: labeled.count }, (_, index) => index + 1).sort(
    (left, right) =>
      (priority[left] ?? 4) - (priority[right] ?? 4) || left - right,
  );
}

function firstOwner(bits: number): number {
  for (let index = 0; index < 4; index += 1) {
    if (bits & (1 << index)) return index;
  }
  return 4;
}

function componentRegion(
  labels: Int32Array,
  component: number,
  raster: SculptRaster,
  bbox: BBox,
  direction: BubbleLayout["direction"],
): BubbleShapeRegion | null {
  const blockSize = direction === "horizontal" ? raster.height : raster.width;
  const occupied = Array.from({ length: blockSize }, (_, block) =>
    scanRun(labels, component, raster, direction, block),
  );
  const start = occupied.findIndex(Boolean);
  const reverseEnd = [...occupied].reverse().findIndex(Boolean);
  if (start < 0 || reverseEnd < 0) return null;
  const end = occupied.length - reverseEnd;
  const count = Math.min(MAX_BUBBLE_REGION_SPANS, end - start);
  const spans: BubbleShapeSpan[] = [];
  for (let band = 0; band < count; band += 1) {
    const bandStart = start + Math.floor((band * (end - start)) / count);
    const bandEnd = start + Math.floor(((band + 1) * (end - start)) / count);
    const span = bandSpan(
      occupied,
      raster,
      bbox,
      direction,
      bandStart,
      bandEnd,
    );
    if (!span) return null;
    spans.push(span);
  }
  return spans.length ? { spans } : null;
}

function bandSpan(
  runs: Array<{ start: number; end: number; multiple: boolean } | null>,
  raster: SculptRaster,
  bbox: BBox,
  direction: BubbleLayout["direction"],
  blockStart: number,
  blockEnd: number,
): BubbleShapeSpan | null {
  const selected = runs.slice(blockStart, blockEnd);
  if (!selected.length || selected.some((run) => !run || run.multiple)) {
    return null;
  }
  const valid = selected.filter(
    (run): run is NonNullable<(typeof selected)[number]> => Boolean(run),
  );
  const inlineStart = Math.max(...valid.map((run) => run.start));
  const inlineEnd = Math.min(...valid.map((run) => run.end));
  if (inlineEnd <= inlineStart) return null;
  return normalizedSpan(
    raster,
    bbox,
    direction,
    blockStart,
    blockEnd,
    inlineStart,
    inlineEnd,
  );
}

function scanRun(
  labels: Int32Array,
  component: number,
  raster: SculptRaster,
  direction: BubbleLayout["direction"],
  block: number,
): { start: number; end: number; multiple: boolean } | null {
  const length = direction === "horizontal" ? raster.width : raster.height;
  let start = -1;
  let end = -1;
  let closed = false;
  let multiple = false;
  for (let inline = 0; inline < length; inline += 1) {
    const index =
      direction === "horizontal"
        ? block * raster.width + inline
        : inline * raster.width + block;
    if (labels[index] === component) {
      if (closed) multiple = true;
      if (start < 0) start = inline;
      end = inline + 1;
    } else if (start >= 0) closed = true;
  }
  return start >= 0 ? { start, end, multiple } : null;
}

function normalizedSpan(
  raster: SculptRaster,
  bbox: BBox,
  direction: BubbleLayout["direction"],
  blockStart: number,
  blockEnd: number,
  inlineStart: number,
  inlineEnd: number,
): BubbleShapeSpan {
  const horizontal = direction === "horizontal";
  const xStart = raster.x + (horizontal ? inlineStart : blockStart);
  const xEnd = raster.x + (horizontal ? inlineEnd : blockEnd);
  const yStart = raster.y + (horizontal ? blockStart : inlineStart);
  const yEnd = raster.y + (horizontal ? blockEnd : inlineEnd);
  return horizontal
    ? {
        blockStart: (yStart - bbox.y) / bbox.h,
        blockEnd: (yEnd - bbox.y) / bbox.h,
        inlineStart: (xStart - bbox.x) / bbox.w,
        inlineEnd: (xEnd - bbox.x) / bbox.w,
      }
    : {
        blockStart: (xStart - bbox.x) / bbox.w,
        blockEnd: (xEnd - bbox.x) / bbox.w,
        inlineStart: (yStart - bbox.y) / bbox.h,
        inlineEnd: (yEnd - bbox.y) / bbox.h,
      };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
