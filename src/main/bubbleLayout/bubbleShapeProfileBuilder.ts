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
  /** Page-space pixel bounds of the source text used to reject tiny shards. */
  textBounds?: BBox;
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

const DOMINANT_TEXT_REGION_MIN_COVERAGE = 0.7;
const SECONDARY_TEXT_REGION_MAX_COVERAGE = 0.15;

export function buildBubbleShapeProfile(
  input: BubbleShapeProfileInput,
): BubbleShapeProfileResult | null {
  if (input.regions.length === 0) return null;
  let ordered = partitionSameBlockBubbleRegions(
    orderBubbleRegions(input.regions, input.sourceDirection),
    input.regionGapPx,
  );
  if (ordered.length === 0) return null;
  let profile = buildProfileData(ordered, input.renderDirection);
  if (!profile) return null;
  const dominantRegionIndex = selectDominantTextRegionIndex(
    profile.regions.map((item) => item.profile),
    profile.pixelBounds,
    input.textBounds,
    input.renderDirection,
  );
  if (dominantRegionIndex !== null) {
    ordered = [profile.regions[dominantRegionIndex].source];
    profile = buildProfileData(ordered, input.renderDirection);
    if (!profile) return null;
  }
  return {
    renderBbox: pixelsToBbox(
      profile.pixelBounds,
      input.pageWidth,
      input.pageHeight,
    ),
    renderBboxSpace: "normalized_1000",
    bubbleLayout: {
      version: 1,
      direction: input.renderDirection,
      confidence: clamp(input.confidence, 0, 1),
      origin: "detected",
      modelId: input.modelId,
      sourceImageRevision: input.sourceImageRevision,
      insetRatio: clamp(
        input.insetPx /
          Math.max(1, Math.min(profile.pixelBounds.w, profile.pixelBounds.h)),
        0,
        0.49,
      ),
      regions: profile.regions.map((item) => item.profile),
    },
  };
}

function buildProfileData(
  regions: RefinedBubbleRegion[],
  renderDirection: RenderTextDirection,
): {
  pixelBounds: BBox;
  regions: Array<{
    source: RefinedBubbleRegion;
    profile: BubbleShapeRegion;
  }>;
} | null {
  const pixelBounds = unionBounds(regions.map((region) => region.bounds));
  if (pixelBounds.w < 2 || pixelBounds.h < 2) return null;
  const profiledRegions = regions
    .map((source) => ({
      source,
      profile: buildRegionProfile(source, pixelBounds, renderDirection),
    }))
    .filter((item) => item.profile.spans.length > 0);
  return profiledRegions.length > 0
    ? { pixelBounds, regions: profiledRegions }
    : null;
}

function selectDominantTextRegionIndex(
  regions: BubbleShapeRegion[],
  renderBounds: BBox,
  textBounds: BBox | undefined,
  direction: RenderTextDirection,
): number | null {
  if (
    !textBounds ||
    textBounds.w <= 0 ||
    textBounds.h <= 0 ||
    regions.length <= 1
  ) {
    return null;
  }
  const coverages = regions.map((region) =>
    resolveTextCoverage(region, renderBounds, textBounds, direction),
  );
  const primaryIndex = coverages.reduce(
    (best, coverage, index) => (coverage > coverages[best] ? index : best),
    0,
  );
  return coverages[primaryIndex] >= DOMINANT_TEXT_REGION_MIN_COVERAGE &&
    coverages.every(
      (coverage, index) =>
        index === primaryIndex ||
        coverage <= SECONDARY_TEXT_REGION_MAX_COVERAGE,
    )
    ? primaryIndex
    : null;
}

function resolveTextCoverage(
  region: BubbleShapeRegion,
  renderBounds: BBox,
  textBounds: BBox,
  direction: RenderTextDirection,
): number {
  const coveredArea = region.spans.reduce(
    (total, span) =>
      total +
      intersectionArea(spanToPixels(span, renderBounds, direction), textBounds),
    0,
  );
  return clamp(coveredArea / Math.max(1, textBounds.w * textBounds.h), 0, 1);
}

function spanToPixels(
  span: BubbleShapeSpan,
  renderBounds: BBox,
  direction: RenderTextDirection,
): BBox {
  if (direction === "horizontal") {
    return {
      x: renderBounds.x + span.inlineStart * renderBounds.w,
      y: renderBounds.y + span.blockStart * renderBounds.h,
      w: (span.inlineEnd - span.inlineStart) * renderBounds.w,
      h: (span.blockEnd - span.blockStart) * renderBounds.h,
    };
  }
  return {
    x: renderBounds.x + span.blockStart * renderBounds.w,
    y: renderBounds.y + span.inlineStart * renderBounds.h,
    w: (span.blockEnd - span.blockStart) * renderBounds.w,
    h: (span.inlineEnd - span.inlineStart) * renderBounds.h,
  };
}

function intersectionArea(left: BBox, right: BBox): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.w, right.x + right.w);
  const y2 = Math.min(left.y + left.h, right.y + right.h);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function orderBubbleRegions(
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
