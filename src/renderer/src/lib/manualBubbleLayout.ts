import type {
  BubbleLayout,
  BubbleShapeSpan,
} from "../../../shared/bubbleLayout";
import type {
  BBox,
  Point,
  RenderTextDirection,
} from "../../../shared/textTypes";

const MANUAL_PROFILE_BAND_COUNT = 48;
const MIN_LOCAL_INTERVAL = 0.002;
const COORDINATE_EPSILON = 1e-6;

export type ManualBubbleLayoutPatch = {
  bubbleLayout: BubbleLayout;
  renderBbox: BBox;
  renderBboxSpace: "normalized_1000";
};

/**
 * Converts a user-authored page polygon into the same block-local span profile
 * used by automatic bubble detection. The text direction is supplied by the
 * selected block and is never changed by this conversion.
 */
export function buildManualBubbleLayoutPatch(
  points: readonly Point[],
  direction: RenderTextDirection,
): ManualBubbleLayoutPatch | null {
  const polygon = normalizePolygon(points);
  if (polygon.length < 3) return null;
  const renderBbox = resolvePolygonBbox(polygon);
  if (!renderBbox || renderBbox.w < 10 || renderBbox.h < 10) return null;

  const localPolygon = polygon.map((point) => ({
    x: (point.x - renderBbox.x) / renderBbox.w,
    y: (point.y - renderBbox.y) / renderBbox.h,
  }));
  const spans = buildPolygonSpans(localPolygon, direction);
  if (spans.length === 0) return null;

  return {
    renderBbox,
    renderBboxSpace: "normalized_1000",
    bubbleLayout: {
      version: 1,
      direction,
      confidence: 1,
      origin: "manual",
      modelId: "manual-shape-v1",
      insetRatio: 0,
      regions: [{ spans }],
    },
  };
}

function normalizePolygon(points: readonly Point[]): Point[] {
  const normalized: Point[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const next = {
      x: clamp(point.x, 0, 1000),
      y: clamp(point.y, 0, 1000),
    };
    const previous = normalized.at(-1);
    if (
      previous &&
      Math.abs(previous.x - next.x) <= COORDINATE_EPSILON &&
      Math.abs(previous.y - next.y) <= COORDINATE_EPSILON
    ) {
      continue;
    }
    normalized.push(next);
  }
  if (normalized.length > 1 && pointsEqual(normalized[0], normalized.at(-1))) {
    normalized.pop();
  }
  return normalized;
}

function resolvePolygonBbox(points: readonly Point[]): BBox | null {
  if (points.length < 3) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  if (![x, y, maxX, maxY].every(Number.isFinite)) return null;
  return { x, y, w: maxX - x, h: maxY - y };
}

function buildPolygonSpans(
  points: readonly Point[],
  direction: RenderTextDirection,
): BubbleShapeSpan[] {
  const spans: BubbleShapeSpan[] = [];
  for (let index = 0; index < MANUAL_PROFILE_BAND_COUNT; index += 1) {
    const blockStart = index / MANUAL_PROFILE_BAND_COUNT;
    const blockEnd = (index + 1) / MANUAL_PROFILE_BAND_COUNT;
    const interval = resolveConservativeBandInterval(
      points,
      direction,
      blockStart,
      blockEnd,
    );
    if (!interval || interval.end - interval.start < MIN_LOCAL_INTERVAL) {
      continue;
    }
    spans.push({
      blockStart,
      blockEnd,
      inlineStart: interval.start,
      inlineEnd: interval.end,
    });
  }
  return coalesceSpans(spans);
}

function resolveConservativeBandInterval(
  points: readonly Point[],
  direction: RenderTextDirection,
  blockStart: number,
  blockEnd: number,
): { start: number; end: number } | null {
  const inset = Math.min(
    COORDINATE_EPSILON,
    Math.max(0, (blockEnd - blockStart) / 4),
  );
  const samples = [
    blockStart + inset,
    (blockStart + blockEnd) / 2,
    blockEnd - inset,
  ];
  let start = 0;
  let end = 1;
  for (const sample of samples) {
    const interval = scanPolygonInterval(points, direction, sample);
    if (!interval) return null;
    start = Math.max(start, interval.start);
    end = Math.min(end, interval.end);
  }
  return end > start ? { start, end } : null;
}

function scanPolygonInterval(
  points: readonly Point[],
  direction: RenderTextDirection,
  blockCoordinate: number,
): { start: number; end: number } | null {
  const intersections: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const first = points[index];
    const second = points[(index + 1) % points.length];
    const intersection = resolveEdgeIntersection(
      first,
      second,
      direction,
      blockCoordinate,
    );
    if (intersection !== null) intersections.push(intersection);
  }
  intersections.sort((left, right) => left - right);
  if (intersections.length < 2) return null;
  return {
    start: clamp(intersections[0] ?? 0, 0, 1),
    end: clamp(intersections.at(-1) ?? 1, 0, 1),
  };
}

function resolveEdgeIntersection(
  first: Point | undefined,
  second: Point | undefined,
  direction: RenderTextDirection,
  blockCoordinate: number,
): number | null {
  if (!first || !second) return null;
  const firstBlock = direction === "horizontal" ? first.y : first.x;
  const secondBlock = direction === "horizontal" ? second.y : second.x;
  if (
    firstBlock > blockCoordinate === secondBlock > blockCoordinate ||
    Math.abs(secondBlock - firstBlock) <= COORDINATE_EPSILON
  ) {
    return null;
  }
  const ratio = (blockCoordinate - firstBlock) / (secondBlock - firstBlock);
  const firstInline = direction === "horizontal" ? first.x : first.y;
  const secondInline = direction === "horizontal" ? second.x : second.y;
  return firstInline + ratio * (secondInline - firstInline);
}

function coalesceSpans(spans: readonly BubbleShapeSpan[]): BubbleShapeSpan[] {
  const result: BubbleShapeSpan[] = [];
  for (const span of spans) {
    const previous = result.at(-1);
    if (
      previous &&
      Math.abs(previous.blockEnd - span.blockStart) <= COORDINATE_EPSILON &&
      Math.abs(previous.inlineStart - span.inlineStart) <= COORDINATE_EPSILON &&
      Math.abs(previous.inlineEnd - span.inlineEnd) <= COORDINATE_EPSILON
    ) {
      previous.blockEnd = span.blockEnd;
    } else {
      result.push({ ...span });
    }
  }
  return result;
}

function pointsEqual(
  left: Point | undefined,
  right: Point | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    Math.abs(left.x - right.x) <= COORDINATE_EPSILON &&
    Math.abs(left.y - right.y) <= COORDINATE_EPSILON,
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
