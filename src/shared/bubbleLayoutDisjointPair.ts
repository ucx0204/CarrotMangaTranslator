import type { BubbleShapeRegion, BubbleShapeSpan } from "./bubbleLayout";
import {
  clampBubbleRatio,
  collectBlockBoundaries,
  ratioIntervalDistance,
  resolveBubbleRegionBounds,
  resolveBubbleRegionCenter,
  resolveIntervalAt,
} from "./bubbleLayoutDisjointGeometry";

const MIN_INTERVAL_RATIO = 1e-5;
const COORDINATE_EPSILON = 1e-7;

export type BubbleRegionSeparationGeometry = {
  blockExtentPx: number;
  inlineExtentPx: number;
  gutterBlockRatio: number;
  gutterInlineRatio: number;
};

export function separateBubbleRegionPair(
  first: BubbleShapeRegion,
  second: BubbleShapeRegion,
  geometry: BubbleRegionSeparationGeometry,
): [BubbleShapeRegion, BubbleShapeRegion] | null {
  const firstCenter = resolveBubbleRegionCenter(first);
  const secondCenter = resolveBubbleRegionCenter(second);
  const firstBounds = resolveBubbleRegionBounds(first);
  const secondBounds = resolveBubbleRegionBounds(second);
  const blockGapPx =
    ratioIntervalDistance(
      { start: firstBounds.blockStart, end: firstBounds.blockEnd },
      { start: secondBounds.blockStart, end: secondBounds.blockEnd },
    ) * geometry.blockExtentPx;
  const inlineGapPx =
    ratioIntervalDistance(
      { start: firstBounds.inlineStart, end: firstBounds.inlineEnd },
      { start: secondBounds.inlineStart, end: secondBounds.inlineEnd },
    ) * geometry.inlineExtentPx;
  const gutterPx = geometry.gutterBlockRatio * geometry.blockExtentPx;
  if (
    blockGapPx > 0 &&
    inlineGapPx > 0 &&
    Math.hypot(blockGapPx, inlineGapPx) < gutterPx
  ) {
    const requiredBlockGapPx = Math.sqrt(
      Math.max(0, gutterPx ** 2 - inlineGapPx ** 2),
    );
    return separatePairOnBlockAxis(
      first,
      second,
      firstCenter.block,
      secondCenter.block,
      requiredBlockGapPx / geometry.blockExtentPx,
    );
  }
  const inlineDistancePx =
    Math.abs(firstCenter.inline - secondCenter.inline) *
    geometry.inlineExtentPx;
  const blockDistancePx =
    Math.abs(firstCenter.block - secondCenter.block) * geometry.blockExtentPx;

  return inlineDistancePx >= blockDistancePx
    ? separatePairOnInlineAxis(
        first,
        second,
        firstCenter,
        secondCenter,
        geometry,
      )
    : separatePairOnBlockAxis(
        first,
        second,
        firstCenter.block,
        secondCenter.block,
        geometry.gutterBlockRatio,
      );
}

function separatePairOnInlineAxis(
  first: BubbleShapeRegion,
  second: BubbleShapeRegion,
  firstCenter: { block: number; inline: number },
  secondCenter: { block: number; inline: number },
  geometry: BubbleRegionSeparationGeometry,
): [BubbleShapeRegion, BubbleShapeRegion] | null {
  const firstIsLeading = firstCenter.inline <= secondCenter.inline;
  const leading = firstIsLeading ? first : second;
  const trailing = firstIsLeading ? second : first;
  const halfGutter = geometry.gutterInlineRatio / 2;
  const boundaries = collectBlockBoundaries(leading, trailing);
  const leadingSpans: BubbleShapeSpan[] = [];
  const trailingSpans: BubbleShapeSpan[] = [];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    appendSeparatedInlineBand({
      blockStart: boundaries[index],
      blockEnd: boundaries[index + 1],
      firstCenter,
      secondCenter,
      halfGutter,
      geometry,
      leading,
      leadingSpans,
      trailing,
      trailingSpans,
    });
  }

  if (leadingSpans.length === 0 || trailingSpans.length === 0) return null;
  const result: [BubbleShapeRegion, BubbleShapeRegion] = [
    { spans: leadingSpans },
    { spans: trailingSpans },
  ];
  return firstIsLeading ? result : [result[1], result[0]];
}

type InlineBandSeparation = {
  blockStart: number | undefined;
  blockEnd: number | undefined;
  firstCenter: { block: number; inline: number };
  secondCenter: { block: number; inline: number };
  halfGutter: number;
  geometry: BubbleRegionSeparationGeometry;
  leading: BubbleShapeRegion;
  trailing: BubbleShapeRegion;
  leadingSpans: BubbleShapeSpan[];
  trailingSpans: BubbleShapeSpan[];
};

function appendSeparatedInlineBand(input: InlineBandSeparation): void {
  const { blockStart, blockEnd } = input;
  if (
    blockStart === undefined ||
    blockEnd === undefined ||
    blockEnd - blockStart <= COORDINATE_EPSILON
  ) {
    return;
  }
  const coordinate = (blockStart + blockEnd) / 2;
  const leadingInterval = resolveIntervalAt(input.leading, coordinate);
  const trailingInterval = resolveIntervalAt(input.trailing, coordinate);
  const needsGap =
    leadingInterval &&
    trailingInterval &&
    ratioIntervalDistance(leadingInterval, trailingInterval) <
      input.geometry.gutterInlineRatio;
  const projectedBoundary = resolveInlinePartitionBoundary(
    coordinate,
    input.firstCenter,
    input.secondCenter,
    input.geometry,
  );
  const boundary =
    leadingInterval && trailingInterval
      ? clampBubbleRatio(
          projectedBoundary,
          Math.min(leadingInterval.end, trailingInterval.start),
          Math.max(leadingInterval.end, trailingInterval.start),
        )
      : projectedBoundary;

  appendOptionalBand(
    input.leadingSpans,
    blockStart,
    blockEnd,
    leadingInterval,
    needsGap ? boundary - input.halfGutter : undefined,
    undefined,
  );
  appendOptionalBand(
    input.trailingSpans,
    blockStart,
    blockEnd,
    trailingInterval,
    undefined,
    needsGap ? boundary + input.halfGutter : undefined,
  );
}

function resolveInlinePartitionBoundary(
  blockCoordinate: number,
  firstCenter: { block: number; inline: number },
  secondCenter: { block: number; inline: number },
  geometry: BubbleRegionSeparationGeometry,
): number {
  const firstBlockPx = firstCenter.block * geometry.blockExtentPx;
  const secondBlockPx = secondCenter.block * geometry.blockExtentPx;
  const firstInlinePx = firstCenter.inline * geometry.inlineExtentPx;
  const secondInlinePx = secondCenter.inline * geometry.inlineExtentPx;
  const deltaBlockPx = secondBlockPx - firstBlockPx;
  const deltaInlinePx = secondInlinePx - firstInlinePx;
  if (Math.abs(deltaInlinePx) <= COORDINATE_EPSILON) {
    return (firstCenter.inline + secondCenter.inline) / 2;
  }
  const blockPx = blockCoordinate * geometry.blockExtentPx;
  const middleBlockPx = (firstBlockPx + secondBlockPx) / 2;
  const middleInlinePx = (firstInlinePx + secondInlinePx) / 2;
  return (
    (middleInlinePx -
      ((blockPx - middleBlockPx) * deltaBlockPx) / deltaInlinePx) /
    geometry.inlineExtentPx
  );
}

function appendOptionalBand(
  target: BubbleShapeSpan[],
  blockStart: number,
  blockEnd: number,
  interval: { start: number; end: number } | null,
  maximum: number | undefined,
  minimum: number | undefined,
): void {
  if (!interval) return;
  appendSpan(target, {
    blockStart,
    blockEnd,
    inlineStart:
      minimum === undefined
        ? interval.start
        : Math.max(interval.start, minimum),
    inlineEnd:
      maximum === undefined ? interval.end : Math.min(interval.end, maximum),
  });
}

function separatePairOnBlockAxis(
  first: BubbleShapeRegion,
  second: BubbleShapeRegion,
  firstCenter: number,
  secondCenter: number,
  gutterRatio: number,
): [BubbleShapeRegion, BubbleShapeRegion] | null {
  if (Math.abs(firstCenter - secondCenter) <= COORDINATE_EPSILON) return null;
  const firstIsLeading = firstCenter < secondCenter;
  const leading = firstIsLeading ? first : second;
  const trailing = firstIsLeading ? second : first;
  const boundary = (firstCenter + secondCenter) / 2;
  const halfGutter = gutterRatio / 2;
  const leadingRegion = cropRegionBlockAxis(leading, 0, boundary - halfGutter);
  const trailingRegion = cropRegionBlockAxis(
    trailing,
    boundary + halfGutter,
    1,
  );
  if (!leadingRegion || !trailingRegion) return null;
  const result: [BubbleShapeRegion, BubbleShapeRegion] = [
    leadingRegion,
    trailingRegion,
  ];
  return firstIsLeading ? result : [result[1], result[0]];
}

function cropRegionBlockAxis(
  region: BubbleShapeRegion,
  minimum: number,
  maximum: number,
): BubbleShapeRegion | null {
  const spans: BubbleShapeSpan[] = [];
  for (const span of region.spans) {
    appendSpan(spans, {
      ...span,
      blockStart: Math.max(span.blockStart, minimum),
      blockEnd: Math.min(span.blockEnd, maximum),
    });
  }
  return spans.length > 0 ? { spans } : null;
}

function appendSpan(target: BubbleShapeSpan[], span: BubbleShapeSpan): void {
  if (
    span.blockEnd - span.blockStart <= MIN_INTERVAL_RATIO ||
    span.inlineEnd - span.inlineStart <= MIN_INTERVAL_RATIO
  ) {
    return;
  }
  const previous = target.at(-1);
  if (
    previous &&
    Math.abs(previous.blockEnd - span.blockStart) <= COORDINATE_EPSILON &&
    Math.abs(previous.inlineStart - span.inlineStart) <= COORDINATE_EPSILON &&
    Math.abs(previous.inlineEnd - span.inlineEnd) <= COORDINATE_EPSILON
  ) {
    previous.blockEnd = span.blockEnd;
    return;
  }
  target.push({ ...span });
}
