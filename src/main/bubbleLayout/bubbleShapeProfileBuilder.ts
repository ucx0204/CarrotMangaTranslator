import type {
  BubbleLayout,
  BubbleShapeRegion,
  BubbleShapeSpan,
} from "../../shared/bubbleLayout";
import { pixelsToBbox } from "../../shared/geometry";
import type {
  BBox,
  RenderTextDirection,
  SourceTextDirection,
} from "../../shared/textTypes";
import type { RefinedBubbleRegion } from "./bubbleMaskTypes";
import { partitionSameBlockBubbleRegions } from "./bubbleSameBlockRegionPartition";

export type BubbleShapeProfileInput = {
  regions: RefinedBubbleRegion[];
  pageWidth: number;
  pageHeight: number;
  renderDirection: RenderTextDirection;
  sourceDirection: SourceTextDirection;
  confidence: number;
  modelId: string;
  sourceImageRevision: string;
  insetPx: number;
  regionGapPx: number;
};

export type BubbleShapeProfileResult = {
  renderBbox: BBox;
  renderBboxSpace: "normalized_1000";
  bubbleLayout: BubbleLayout;
};

export function buildBubbleShapeProfile(
  input: BubbleShapeProfileInput,
): BubbleShapeProfileResult | null {
  if (input.regions.length === 0) return null;
  const ordered = partitionSameBlockBubbleRegions(
    orderBubbleRegions(input.regions, input.sourceDirection),
    input.regionGapPx,
  );
  if (ordered.length === 0) return null;
  const pixelBounds = unionBounds(ordered.map((region) => region.bounds));
  if (pixelBounds.w < 2 || pixelBounds.h < 2) return null;
  const regions = ordered
    .map((region) =>
      buildRegionProfile(region, pixelBounds, input.renderDirection),
    )
    .filter((region): region is BubbleShapeRegion => region.spans.length > 0);
  if (regions.length === 0) return null;
  return {
    renderBbox: pixelsToBbox(pixelBounds, input.pageWidth, input.pageHeight),
    renderBboxSpace: "normalized_1000",
    bubbleLayout: {
      version: 1,
      direction: input.renderDirection,
      confidence: clamp(input.confidence, 0, 1),
      origin: "detected",
      modelId: input.modelId,
      sourceImageRevision: input.sourceImageRevision,
      insetRatio: clamp(
        input.insetPx / Math.max(1, Math.min(pixelBounds.w, pixelBounds.h)),
        0,
        0.49,
      ),
      regions,
    },
  };
}

export function orderBubbleRegions(
  regions: RefinedBubbleRegion[],
  sourceDirection: SourceTextDirection,
): RefinedBubbleRegion[] {
  const rows: RefinedBubbleRegion[][] = [];
  const topOrdered = [...regions].sort(
    (left, right) => left.bounds.y - right.bounds.y,
  );
  for (const region of topOrdered) {
    const row = rows.find((candidate) =>
      belongsToRow(
        region.bounds,
        candidate.map((item) => item.bounds),
      ),
    );
    if (row) row.push(region);
    else rows.push([region]);
  }
  return rows.flatMap((row) =>
    row.sort((left, right) =>
      sourceDirection === "vertical"
        ? right.bounds.x - left.bounds.x
        : left.bounds.x - right.bounds.x,
    ),
  );
}

function belongsToRow(bounds: BBox, row: BBox[]): boolean {
  const rowTop = Math.min(...row.map((item) => item.y));
  const rowBottom = Math.max(...row.map((item) => item.y + item.h));
  const overlap = Math.max(
    0,
    Math.min(bounds.y + bounds.h, rowBottom) - Math.max(bounds.y, rowTop),
  );
  return overlap / Math.max(1, Math.min(bounds.h, rowBottom - rowTop)) >= 0.3;
}

function buildRegionProfile(
  region: RefinedBubbleRegion,
  renderBounds: BBox,
  direction: RenderTextDirection,
): BubbleShapeRegion {
  const blockLength = direction === "horizontal" ? region.height : region.width;
  const bandSize = Math.max(1, Math.ceil(blockLength / 96));
  const spans: BubbleShapeSpan[] = [];
  for (let start = 0; start < blockLength; start += bandSize) {
    const end = Math.min(blockLength, start + bandSize);
    const interval = intersectBandInterval(region, direction, start, end);
    if (!interval) continue;
    spans.push(
      normalizeSpan(region, renderBounds, direction, start, end, interval),
    );
  }
  return { spans };
}

function intersectBandInterval(
  region: RefinedBubbleRegion,
  direction: RenderTextDirection,
  start: number,
  end: number,
): { start: number; end: number } | null {
  let safeStart = 0;
  let safeEnd = direction === "horizontal" ? region.width : region.height;
  for (let block = start; block < end; block += 1) {
    const line = scanMaskLine(region, direction, block);
    if (!line) return null;
    safeStart = Math.max(safeStart, line.start);
    safeEnd = Math.min(safeEnd, line.end);
  }
  return safeEnd > safeStart ? { start: safeStart, end: safeEnd } : null;
}

function scanMaskLine(
  region: RefinedBubbleRegion,
  direction: RenderTextDirection,
  block: number,
): { start: number; end: number } | null {
  const inlineLength =
    direction === "horizontal" ? region.width : region.height;
  let first = -1;
  let last = -1;
  for (let inline = 0; inline < inlineLength; inline += 1) {
    const index =
      direction === "horizontal"
        ? block * region.width + inline
        : inline * region.width + block;
    if (!region.mask[index]) continue;
    if (first < 0) first = inline;
    last = inline;
  }
  return first >= 0 ? { start: first, end: last + 1 } : null;
}

function normalizeSpan(
  region: RefinedBubbleRegion,
  renderBounds: BBox,
  direction: RenderTextDirection,
  blockStart: number,
  blockEnd: number,
  inline: { start: number; end: number },
): BubbleShapeSpan {
  if (direction === "horizontal") {
    return {
      blockStart: ratio(
        region.bounds.y + blockStart - renderBounds.y,
        renderBounds.h,
      ),
      blockEnd: ratio(
        region.bounds.y + blockEnd - renderBounds.y,
        renderBounds.h,
      ),
      inlineStart: ratio(
        region.bounds.x + inline.start - renderBounds.x,
        renderBounds.w,
      ),
      inlineEnd: ratio(
        region.bounds.x + inline.end - renderBounds.x,
        renderBounds.w,
      ),
    };
  }
  return {
    blockStart: ratio(
      region.bounds.x + blockStart - renderBounds.x,
      renderBounds.w,
    ),
    blockEnd: ratio(
      region.bounds.x + blockEnd - renderBounds.x,
      renderBounds.w,
    ),
    inlineStart: ratio(
      region.bounds.y + inline.start - renderBounds.y,
      renderBounds.h,
    ),
    inlineEnd: ratio(
      region.bounds.y + inline.end - renderBounds.y,
      renderBounds.h,
    ),
  };
}

function unionBounds(boxes: BBox[]): BBox {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function ratio(value: number, total: number): number {
  return clamp(value / Math.max(1, total), 0, 1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
