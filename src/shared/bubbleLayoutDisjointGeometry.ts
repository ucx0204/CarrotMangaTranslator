import type { BubbleShapeRegion } from "./bubbleLayout";

export function resolveBubbleRegionCenter(region: BubbleShapeRegion): {
  block: number;
  inline: number;
} {
  let area = 0;
  let block = 0;
  let inline = 0;
  for (const span of region.spans) {
    const spanArea =
      (span.blockEnd - span.blockStart) * (span.inlineEnd - span.inlineStart);
    area += spanArea;
    block += ((span.blockStart + span.blockEnd) / 2) * spanArea;
    inline += ((span.inlineStart + span.inlineEnd) / 2) * spanArea;
  }
  return area > 0
    ? { block: block / area, inline: inline / area }
    : { block: 0.5, inline: 0.5 };
}

export function resolveBubbleRegionBounds(region: BubbleShapeRegion): {
  blockStart: number;
  blockEnd: number;
  inlineStart: number;
  inlineEnd: number;
} {
  return {
    blockStart: Math.min(...region.spans.map((span) => span.blockStart)),
    blockEnd: Math.max(...region.spans.map((span) => span.blockEnd)),
    inlineStart: Math.min(...region.spans.map((span) => span.inlineStart)),
    inlineEnd: Math.max(...region.spans.map((span) => span.inlineEnd)),
  };
}

export function ratioIntervalDistance(
  first: { start: number; end: number },
  second: { start: number; end: number },
): number {
  if (first.end < second.start) return second.start - first.end;
  if (second.end < first.start) return first.start - second.end;
  return 0;
}

export function cloneBubbleRegion(
  region: BubbleShapeRegion,
): BubbleShapeRegion {
  return { spans: region.spans.map((span) => ({ ...span })) };
}

export function clampBubbleRatio(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function collectBlockBoundaries(
  first: BubbleShapeRegion,
  second: BubbleShapeRegion,
): number[] {
  return [
    ...new Set(
      [...first.spans, ...second.spans].flatMap((span) => [
        span.blockStart,
        span.blockEnd,
      ]),
    ),
  ].sort((left, right) => left - right);
}

export function resolveIntervalAt(
  region: BubbleShapeRegion,
  blockCoordinate: number,
): { start: number; end: number } | null {
  const span = region.spans.find(
    (candidate) =>
      candidate.blockStart <= blockCoordinate &&
      candidate.blockEnd >= blockCoordinate,
  );
  return span ? { start: span.inlineStart, end: span.inlineEnd } : null;
}
